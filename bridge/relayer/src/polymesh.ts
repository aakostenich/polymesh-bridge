import { LocalSigningManager } from '@polymeshassociation/local-signing-manager';
import { BigNumber, Polymesh } from '@polymeshassociation/polymesh-sdk';

import { config } from './config.js';

/**
 * Polymesh side of the bridge.
 *
 * The escrow account holds POLYX locked by users bridging Polymesh -> Ethereum,
 * and releases POLYX to users bridging Ethereum -> Polymesh. This module wraps
 * the Polymesh SDK connection, the escrow signer, and the small set of
 * operations the relayer needs (balance, transfer, finalized-block stream,
 * incoming transfer events to the escrow).
 *
 * Connection pattern mirrors tests/src/helpers/factory.ts (SDK v30):
 *   Polymesh.connect({ nodeUrl, middlewareV2, polkadot }) + setSigningManager.
 */

let _sdk: Polymesh | undefined;
let _escrowAddress: string | undefined;

/** Connect to the Polymesh node and attach the escrow signing manager. */
export async function getPolymesh(): Promise<Polymesh> {
  if (_sdk) return _sdk;

  const signingManager = await LocalSigningManager.create({
    accounts: [{ mnemonic: config.polymesh.escrowMnemonic }],
    // The local dev chain uses well-known dev keys;Sdk verification is skipped.
  });

  const sdk = await Polymesh.connect({
    nodeUrl: config.polymesh.nodeUrl,
    middlewareV2: {
      link: config.polymesh.middlewareUrl,
      key: '',
    },
    polkadot: { noInitWarn: true },
  });

  await sdk.setSigningManager(signingManager);

  const accounts = await signingManager.getAccounts();
  if (accounts.length === 0) {
    throw new Error('Escrow signing manager has no accounts');
  }
  _escrowAddress = accounts[0];
  sdk.setSigningAccount(_escrowAddress);

  _sdk = sdk;
  return sdk;
}

/** Address of the escrow account (resolved at first connect). */
export async function getEscrowAddress(): Promise<string> {
  if (!_escrowAddress) await getPolymesh();
  return _escrowAddress!;
}

/** Free POLYX balance (base units) of a given account. */
export async function getBalance(address: string): Promise<BigNumber> {
  const sdk = await getPolymesh();
  const account = await sdk.accountManagement.getAccount({ address });
  const balance = await account.getBalance();
  return balance.free;
}

/** Free POLYX balance of the escrow account. */
export async function getEscrowBalance(): Promise<BigNumber> {
  return getBalance(await getEscrowAddress());
}

/**
 * Release POLYX from the escrow to a recipient (Ethereum -> Polymesh direction).
 * @param recipient Polymesh SS58 address.
 * @param amount Base units of POLYX (6 decimals).
 * @returns The transaction hash on success.
 */
export async function releasePolyx(recipient: string, amount: BigNumber): Promise<string> {
  const sdk = await getPolymesh();
  const escrow = await getEscrowAddress();

  const tx = await sdk.network.transferPolyx(
    { to: recipient, amount, memo: 'bridge:release' },
    { signingAccount: escrow },
  );
  const hash = await tx.run();
  if (!tx.isSuccess) {
    throw new Error(`transferPolyx failed: ${JSON.stringify(tx.txHash)}`);
  }
  return hash ?? '';
}

/**
 * Subscribe to finalized block numbers on Polymesh. The SDK has no public block
 * stream, so we use the underlying polkadot API (exposed as `sdk._polkadotApi`).
 * @param onBlock Called with each finalized block number.
 * @returns An unsubscribe function.
 */
export async function onFinalizedBlock(onBlock: (blockNumber: number) => void): Promise<() => void> {
  const sdk = await getPolymesh();
  const api = sdk._polkadotApi;
  return api.rpc.chain.subscribeFinalizedHeads((header) => {
    onBlock(header.number.toNumber());
  });
}

export interface IncomingTransfer {
  /** Polymesh block number the transfer was finalized in. */
  blockNumber: number;
  /** Sender SS58 address. */
  from: string;
  /** Amount transferred, in SDK base units (6 decimals), as a string. */
  amount: string;
}

/**
 * Polymesh stores balances on-chain with an extra internal factor of 10^6 on
 * top of the 6 display decimals (raw amounts are 12 digits for 1 POLYX). The
 * SDK's `transferPolyx({ amount })` takes display base units (6 decimals), so
 * to compare a raw `Balances.Transfer` event amount with an SDK amount we must
 * divide the raw value by 10^6.
 *
 * Example: transferPolyx({ amount: 2_000_000 }) // 2 POLYX, 6 decimals
 *          -> raw event amount: 2_000_000_000_000
 *          -> normalized:       2_000_000  (matches the SDK amount)
 */
const POLYMESH_RAW_FACTOR = 1_000_000;

export function normalizeRawAmount(raw: string): string {
  // Raw is always a multiple of the factor; use BigInt for exactness.
  const n = BigInt(raw) / BigInt(POLYMESH_RAW_FACTOR);
  return n.toString();
}

/**
 * Fetch `Balances.Transfer` events credited to a target account within a block
 * range (inclusive), using the underlying polkadot API. The SDK does not expose
 * real-time transfer events (its history methods query the lagging middleware).
 *
 * @param target Recipient SS58 address (typically the escrow).
 * @param fromBlock Inclusive start block.
 * @param toBlock Inclusive end block.
 */
export async function getIncomingTransfers(
  target: string,
  fromBlock: number,
  toBlock: number,
): Promise<IncomingTransfer[]> {
  const sdk = await getPolymesh();
  const api = sdk._polkadotApi;
  const results: IncomingTransfer[] = [];

  for (let block = fromBlock; block <= toBlock; block++) {
    const hash = await api.rpc.chain.getBlockHash(block);
    const atBlock = await api.at(hash);
    const events = await atBlock.query.system.events();

    for (const record of events) {
      const { event } = record;
      if (event.section === 'balances' && event.method === 'Transfer') {
        const from = event.data[0]?.toString();
        const to = event.data[1]?.toString();
        const rawAmount = event.data[2]?.toString();
        if (to === target && from && rawAmount) {
          results.push({ blockNumber: block, from, amount: normalizeRawAmount(rawAmount) });
        }
      }
    }
  }

  return results;
}

/** Gracefully disconnect the SDK. */
export async function disconnectPolymesh(): Promise<void> {
  if (_sdk) {
    await _sdk.disconnect();
    _sdk = undefined;
    _escrowAddress = undefined;
  }
}
