import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const relayerEnv = resolve(here, '../../relayer/.env');
const localEnv = resolve(here, '../.env');

if (existsSync(relayerEnv)) loadDotenv({ path: relayerEnv });
if (existsSync(localEnv)) loadDotenv({ path: localEnv, override: true });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing config ${name}. Set it in bridge/relayer/.env`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Config ${name} must be an integer`);
  return n;
}

export const config = {
  port: int('BRIDGE_WEB_API_PORT', 5174),
  eth: {
    rpcUrl: required('BRIDGE_ETH_RPC_URL', 'http://127.0.0.1:8546'),
    chainId: int('BRIDGE_ETH_CHAIN_ID', 1337),
    bridgeAddress: required('BRIDGE_ADDRESS'),
    wPolyxAddress: required('WPOLYX_ADDRESS'),
  },
  polymesh: {
    nodeUrl: required('POLYMESH_NODE_URL', 'ws://127.0.0.1:9944'),
    middlewareUrl: required('POLYMESH_GRAPHQL_URL', 'http://127.0.0.1:3000'),
    escrowMnemonic: required('BRIDGE_POLYMESH_ESCROW_MNEMONIC', '//Charlie'),
  },
  intentApiUrl: process.env.BRIDGE_INTENT_API_URL ?? 'http://127.0.0.1:3006',
} as const;

/** Well-known Anvil accounts (Foundry defaults) for local demos. */
export const ANVIL_ACCOUNTS = [
  {
    name: 'Anvil #0 (deployer)',
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  },
  {
    name: 'Anvil #1 (relayer)',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  },
  {
    name: 'Anvil #2',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  },
  {
    name: 'Anvil #3',
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    privateKey: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  },
  {
    name: 'Anvil #4',
    address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    privateKey: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  },
] as const;

/** Polymesh dev-chain accounts used by the local signing manager. */
export const POLYMESH_DEV_ACCOUNTS = [
  { name: 'Alice', mnemonic: '//Alice', role: 'funded sudo' },
  { name: 'Bob', mnemonic: '//Bob', role: 'demo user' },
  { name: 'Charlie', mnemonic: '//Charlie', role: 'escrow (default)' },
  { name: 'Dave', mnemonic: '//Dave', role: 'demo user' },
] as const;
