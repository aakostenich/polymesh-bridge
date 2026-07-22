import { LocalSigningManager } from '@polymeshassociation/local-signing-manager';
import { BigNumber, Polymesh } from '@polymeshassociation/polymesh-sdk';

import { config } from './config.js';
import { parseIntentIdFromMemo } from './db.js';

/**
 * Polymesh side of the bridge.
 *
 * The escrow account holds POLYX locked by users bridging Polymesh -> Ethereum,
 * and releases POLYX to users bridging Ethereum -> Polymesh. Incoming lock
 * transfers carry a short intent id in the 32-byte memo (`b:<intentId>`).
 */

let _sdk: Polymesh | undefined;
let _escrowAddress: string | undefined;

export async function getPolymesh(): Promise<Polymesh> {
  if (_sdk) return _sdk;

  const signingManager = await LocalSigningManager.create({
    accounts: [{ mnemonic: config.polymesh.escrowMnemonic }],
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

export async function getEscrowAddress(): Promise<string> {
  if (!_escrowAddress) await getPolymesh();
  return _escrowAddress!;
}

export async function getBalance(address: string): Promise<BigNumber> {
  const sdk = await getPolymesh();
  const account = await sdk.accountManagement.getAccount({ address });
  const balance = await account.getBalance();
  return balance.free;
}

export async function getEscrowBalance(): Promise<BigNumber> {
  return getBalance(await getEscrowAddress());
}

export async function releasePolyx(recipient: string, amount: BigNumber): Promise<string> {
  const sdk = await getPolymesh();
  const escrow = await getEscrowAddress();

  const tx = await sdk.network.transferPolyx(
    { to: recipient, amount, memo: 'bridge:release' },
    { signingAccount: escrow },
  );
  await tx.run();
  if (!tx.isSuccess) {
    throw new Error(`transferPolyx failed: ${JSON.stringify(tx.txHash)}`);
  }
  return String(tx.txHash ?? '');
}

export async function onFinalizedBlock(onBlock: (blockNumber: number) => void): Promise<() => void> {
  const sdk = await getPolymesh();
  const api = sdk._polkadotApi;
  return api.rpc.chain.subscribeFinalizedHeads((header) => {
    onBlock(header.number.toNumber());
  });
}

export interface IncomingTransfer {
  blockNumber: number;
  from: string;
  /** Amount in SDK base units (6 decimals), as a string. */
  amount: string;
  /** Intent id parsed from the extrinsic memo, if present. */
  intentId: string | null;
  /** Extrinsic hash when available. */
  extrinsicHash: string | null;
}

/**
 * Polymesh stores balances on-chain with an extra internal factor of 10^6 on
 * top of the 6 display decimals (raw amounts are 12 digits for 1 POLYX).
 */
const POLYMESH_RAW_FACTOR = 1_000_000n;

export function normalizeRawAmount(raw: string): string {
  const n = BigInt(raw) / POLYMESH_RAW_FACTOR;
  return n.toString();
}

function extractMemoFromExtrinsic(ext: {
  method: { section: string; method: string; args: unknown[] };
}): string | null {
  const { section, method, args } = ext.method;
  if (section !== 'balances') return null;

  // Polymesh / Substrate variants:
  //   transfer(dest, value)
  //   transferWithMemo(dest, value, memo)
  //   transfer_keep_alive / transfer_allow_death — usually no memo
  if (method === 'transferWithMemo' || method === 'transfer_with_memo') {
    const memoArg = args[2];
    return memoArgToString(memoArg);
  }

  // Some runtimes pack memo as optional last arg on transfer.
  if (method === 'transfer' && args.length >= 3) {
    return memoArgToString(args[2]);
  }

  return null;
}

function memoArgToString(memoArg: unknown): string | null {
  if (memoArg === null || memoArg === undefined) return null;
  if (typeof memoArg === 'string') return memoArg;
  const anyArg = memoArg as { toHuman?: () => unknown; toString?: () => string };
  if (typeof anyArg.toHuman === 'function') {
    const human = anyArg.toHuman();
    if (typeof human === 'string') return human;
    if (human && typeof human === 'object') {
      const vals = Object.values(human as Record<string, unknown>);
      for (const v of vals) {
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
  }
  if (typeof anyArg.toString === 'function') {
    const s = anyArg.toString();
    if (s && s !== '[object Object]') return s;
  }
  return null;
}

/**
 * Fetch incoming escrow credits. Prefer Polymesh `TransferWithMemo` (memo is
 * on the event); fall back to `Transfer` + extrinsic memo parsing.
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
    const signedBlock = await api.rpc.chain.getBlock(hash);
    const atBlock = await api.at(hash);
    const events = await atBlock.query.system.events();
    const extrinsics = signedBlock.block.extrinsics;

    // Index of TransferWithMemo already handled so we don't double-count Transfer.
    const handledExt = new Set<number>();

    for (const record of events) {
      const { event, phase } = record;
      if (event.section !== 'balances') continue;

      const isMemoTransfer = event.method === 'TransferWithMemo';
      const isPlainTransfer = event.method === 'Transfer';
      if (!isMemoTransfer && !isPlainTransfer) continue;

      const from = event.data[0]?.toString();
      const to = event.data[1]?.toString();
      const rawAmount = event.data[2]?.toString();
      if (to !== target || !from || !rawAmount) continue;

      let intentId: string | null = null;
      let extrinsicHash: string | null = null;
      const extIdx = phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : -1;

      if (extIdx >= 0) {
        const ext = extrinsics[extIdx];
        if (ext) extrinsicHash = ext.hash?.toHex?.() ?? null;
      }

      if (isMemoTransfer) {
        // data[3] is the fixed 32-byte Memo (often hex-encoded ASCII).
        const memoRaw = event.data[3] as { toHuman?: () => unknown; toString?: () => string };
        let memoStr: string | null = null;
        try {
          const human = memoRaw?.toHuman?.() ?? memoRaw?.toString?.();
          memoStr = typeof human === 'string' ? human : (memoRaw?.toString?.() ?? null);
        } catch {
          memoStr = memoRaw?.toString?.() ?? null;
        }
        intentId = parseIntentIdFromMemo(memoStr);
        if (extIdx >= 0) handledExt.add(extIdx);
      } else if (isPlainTransfer) {
        if (extIdx >= 0 && handledExt.has(extIdx)) {
          // Companion Transfer of a TransferWithMemo — skip duplicate.
          continue;
        }
        if (extIdx >= 0) {
          const ext = extrinsics[extIdx];
          if (ext) {
            const memo = extractMemoFromExtrinsic(ext as never);
            intentId = parseIntentIdFromMemo(memo);
          }
        }
      }

      results.push({
        blockNumber: block,
        from,
        amount: normalizeRawAmount(rawAmount),
        intentId,
        extrinsicHash,
      });
    }
  }

  return results;
}

export async function disconnectPolymesh(): Promise<void> {
  if (_sdk) {
    await _sdk.disconnect();
    _sdk = undefined;
    _escrowAddress = undefined;
  }
}
