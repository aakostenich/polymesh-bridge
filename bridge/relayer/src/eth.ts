import { Contract, JsonRpcProvider, Wallet, type EventLog } from 'ethers';

import { bridgeAbi } from './abi.js';
import { config } from './config.js';

/**
 * Ethereum (Anvil) side of the bridge.
 *
 * The relayer acts as the trusted minter on Ethereum: it reads
 * `BridgedToPolymesh` burn events (Ethereum -> Polymesh) and calls
 * `mintFromPolymesh` (Polymesh -> Ethereum). This module wires up the ethers
 * provider, the relayer wallet, and typed helpers around the bridge contract.
 */

let _provider: JsonRpcProvider | undefined;
let _relayerWallet: Wallet | undefined;
let _bridge: Contract | undefined;

export function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(config.eth.rpcUrl, config.eth.chainId, {
      staticNetwork: true,
    });
  }
  return _provider;
}

export function getRelayerWallet(): Wallet {
  if (!_relayerWallet) {
    const provider = getProvider();
    _relayerWallet = new Wallet(config.eth.relayerPrivateKey, provider);
  }
  return _relayerWallet;
}

/** Read-only contract instance for queries and event filtering. */
export function getBridgeContract(): Contract {
  if (!_bridge) {
    const provider = getProvider();
    _bridge = new Contract(config.eth.bridgeAddress, bridgeAbi, provider);
  }
  return _bridge;
}

/** Signer-backed contract instance for sending transactions (mint). */
export function getBridgeContractSigner(): Contract {
  const wallet = getRelayerWallet();
  return new Contract(config.eth.bridgeAddress, bridgeAbi, wallet);
}

export interface BridgedToPolymeshEvent {
  /** Monotonic event id from the bridge contract (replay key). */
  id: bigint;
  /** Ethereum address that burned wPOLYX. */
  sender: string;
  /** Polymesh SS58 address that should receive POLYX. */
  polymeshRecipient: string;
  /** Amount burned (6 decimals). */
  amount: bigint;
  /** Block the event was emitted in. */
  blockNumber: number;
  /** Transaction hash. */
  txHash: string;
}

/**
 * Query `BridgedToPolymesh` events from `fromBlock` to `toBlock` (inclusive).
 */
export async function getBridgedToPolymeshEvents(
  fromBlock: number,
  toBlock: number,
): Promise<BridgedToPolymeshEvent[]> {
  const bridge = getBridgeContract();
  const filter = bridge.filters.BridgedToPolymesh();
  const logs = (await bridge.queryFilter(filter, fromBlock, toBlock)) as EventLog[];

  return logs.map((log) => ({
    id: (log.args.id as bigint),
    sender: log.args.sender as string,
    polymeshRecipient: log.args.polymeshRecipient as string,
    amount: log.args.amount as bigint,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  }));
}

/** Current latest block number on Ethereum. */
export async function getLatestBlock(): Promise<number> {
  return getProvider().getBlockNumber();
}

/**
 * Mint wPOLYX on Ethereum, crediting POLYX locked on Polymesh.
 * @param ethRecipient Ethereum address to mint to.
 * @param amount Amount in base units (6 decimals), as bigint.
 * @param polyEventId Unique Polymesh lock id (replay key).
 * @returns The transaction hash.
 */
export async function mintFromPolymesh(
  ethRecipient: string,
  amount: bigint,
  polyEventId: bigint,
): Promise<string> {
  const bridge = getBridgeContractSigner();
  const tx = await bridge.mintFromPolymesh(ethRecipient, amount, polyEventId);
  const receipt = await tx.wait();
  if (receipt === null) {
    throw new Error('mintFromPolymesh: no receipt');
  }
  return receipt.hash;
}
