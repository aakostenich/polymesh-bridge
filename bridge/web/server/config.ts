import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const network = (process.env.BRIDGE_NETWORK ?? 'local').toLowerCase();
const isTestnet = network === 'testnet' || network === 'sepolia';

// Load profile envs (first match), then allow local overrides.
const candidates = [
  process.env.BRIDGE_ENV_FILE ? resolve(process.cwd(), process.env.BRIDGE_ENV_FILE) : '',
  isTestnet ? resolve(here, '../../relayer/.env.testnet') : '',
  isTestnet ? resolve(here, '../../envs/testnet.env') : '',
  resolve(here, '../../relayer/.env'),
  resolve(here, '../../envs/local.env'),
  resolve(here, '../.env'),
].filter(Boolean);

for (const p of candidates) {
  if (existsSync(p)) loadDotenv({ path: p, override: false });
}
// Prefer explicit testnet file when requested
if (isTestnet) {
  const t = resolve(here, '../../relayer/.env.testnet');
  if (existsSync(t)) loadDotenv({ path: t, override: true });
}

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

const isTestnetCfg =
  (process.env.BRIDGE_NETWORK ?? 'local').toLowerCase() === 'testnet' ||
  (process.env.BRIDGE_NETWORK ?? '').toLowerCase() === 'sepolia';

export const config = {
  network: isTestnetCfg ? 'testnet' : 'local',
  port: int('BRIDGE_WEB_API_PORT', 5174),
  eth: {
    rpcUrl: required(
      'BRIDGE_ETH_RPC_URL',
      isTestnetCfg
        ? 'https://ethereum-sepolia-rpc.publicnode.com'
        : 'http://127.0.0.1:8546',
    ),
    chainId: int('BRIDGE_ETH_CHAIN_ID', isTestnetCfg ? 11155111 : 1337),
    chainName: isTestnetCfg ? 'Sepolia' : 'Anvil Local (POLYX Bridge)',
    explorerUrl: isTestnetCfg ? 'https://sepolia.etherscan.io' : null as string | null,
    bridgeAddress: required('BRIDGE_ADDRESS'),
    wPolyxAddress: required('WPOLYX_ADDRESS'),
  },
  polymesh: {
    nodeUrl: required(
      'POLYMESH_NODE_URL',
      isTestnetCfg ? 'wss://testnet-rpc.polymesh.live/' : 'ws://127.0.0.1:9944',
    ),
    middlewareUrl: required(
      'POLYMESH_GRAPHQL_URL',
      isTestnetCfg ? 'https://testnet-graphql.polymesh.live/' : 'http://127.0.0.1:3000',
    ),
    portalUrl: isTestnetCfg ? 'https://portal.polymesh.live/' : null as string | null,
    escrowMnemonic: required(
      'BRIDGE_POLYMESH_ESCROW_MNEMONIC',
      isTestnetCfg ? undefined : '//Charlie',
    ),
  },
  intentApiUrl: process.env.BRIDGE_INTENT_API_URL ?? 'http://127.0.0.1:3006',
  /**
   * Relayer API token. Mirrors relayer default (`dev-bridge-token`).
   * Set BRIDGE_API_TOKEN=off to disable.
   */
  apiToken: (() => {
    const raw = process.env.BRIDGE_API_TOKEN;
    if (raw === undefined) return isTestnetCfg ? null : 'dev-bridge-token';
    const t = raw.trim();
    if (t === '' || t.toLowerCase() === 'off' || t.toLowerCase() === 'none') return null;
    return t;
  })(),
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
