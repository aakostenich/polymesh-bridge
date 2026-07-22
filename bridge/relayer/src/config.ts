import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load env file priority:
 *   1. BRIDGE_ENV_FILE (absolute or relative path)
 *   2. .env.testnet when BRIDGE_NETWORK=testnet or npm script start:testnet
 *   3. .env (default local)
 */
function loadEnvFiles(): void {
  const cwd = process.cwd();
  const candidates: string[] = [];

  if (process.env.BRIDGE_ENV_FILE) {
    candidates.push(resolve(cwd, process.env.BRIDGE_ENV_FILE));
  }

  const network = (process.env.BRIDGE_NETWORK ?? '').toLowerCase();
  if (network === 'testnet' || network === 'sepolia') {
    candidates.push(resolve(cwd, '.env.testnet'));
    candidates.push(resolve(cwd, '../envs/testnet.env'));
  }

  candidates.push(resolve(cwd, '.env'));
  candidates.push(resolve(cwd, '../envs/local.env'));

  for (const p of candidates) {
    if (existsSync(p)) {
      loadDotenv({ path: p, override: false });
      // First existing file wins as primary; still allow process env to override.
      // Load remaining only for missing keys (override: false).
    }
  }

  // If BRIDGE_NETWORK=testnet, prefer .env.testnet with override for that file alone.
  if (network === 'testnet' || network === 'sepolia') {
    const testnetPath = resolve(cwd, '.env.testnet');
    if (existsSync(testnetPath)) {
      loadDotenv({ path: testnetPath, override: true });
    }
  }
}

loadEnvFiles();

/**
 * Centralized configuration for the bridge relayer.
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required config: ${name}. See bridge/relayer/.env.example or .env.testnet.example`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Config ${name} must be an integer, got: ${raw}`);
  return parsed;
}

function polyxToBase(name: string, fallbackHuman: string): string {
  const raw = process.env[name] ?? fallbackHuman;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Config ${name} must be a non-negative number (POLYX), got: ${raw}`);
  }
  const [whole, frac = ''] = String(raw).split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const base = BigInt(whole || '0') * 1_000_000n + BigInt(fracPadded || '0');
  return base.toString();
}

function apiToken(): string | null {
  const raw = process.env.BRIDGE_API_TOKEN;
  if (raw === undefined) return 'dev-bridge-token';
  const t = raw.trim();
  if (t === '' || t.toLowerCase() === 'off' || t.toLowerCase() === 'none') return null;
  return t;
}

const network = (process.env.BRIDGE_NETWORK ?? 'local').toLowerCase();
const isTestnet = network === 'testnet' || network === 'sepolia';

export const config = {
  network: isTestnet ? 'testnet' : 'local',

  eth: {
    rpcUrl: required(
      'BRIDGE_ETH_RPC_URL',
      isTestnet
        ? 'https://ethereum-sepolia-rpc.publicnode.com'
        : `http://127.0.0.1:${process.env.BRIDGE_ETH_RPC_PORT ?? 8546}`,
    ),
    chainId: int('BRIDGE_ETH_CHAIN_ID', isTestnet ? 11155111 : 1337),
    chainName: isTestnet ? 'Sepolia' : 'Anvil Local (POLYX Bridge)',
    explorerUrl: isTestnet ? 'https://sepolia.etherscan.io' : null,
    relayerPrivateKey: required(
      'BRIDGE_ETH_RELAYER_KEY',
      isTestnet
        ? undefined
        : '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ),
    bridgeAddress: required('BRIDGE_ADDRESS'),
    wPolyxAddress: required('WPOLYX_ADDRESS'),
    confirmations: int('BRIDGE_ETH_CONFIRMATIONS', isTestnet ? 3 : 2),
  },

  polymesh: {
    nodeUrl: required(
      'POLYMESH_NODE_URL',
      isTestnet ? 'wss://testnet-rpc.polymesh.live/' : 'ws://127.0.0.1:9944',
    ),
    middlewareUrl: required(
      'POLYMESH_GRAPHQL_URL',
      isTestnet ? 'https://testnet-graphql.polymesh.live/' : 'http://127.0.0.1:3000',
    ),
    portalUrl: isTestnet ? 'https://portal.polymesh.live/' : null,
    explorerUrl: isTestnet ? 'https://polymesh-testnet.subscan.io/' : null,
    escrowMnemonic: required(
      'BRIDGE_POLYMESH_ESCROW_MNEMONIC',
      isTestnet ? undefined : '//Charlie',
    ),
  },

  pollIntervalMs: int('BRIDGE_POLL_INTERVAL_MS', isTestnet ? 6000 : 4000),
  polymeshFinalityBlocks: int('BRIDGE_POLYMESH_FINALITY_BLOCKS', isTestnet ? 10 : 5),
  dbPath:
    process.env.BRIDGE_DB_PATH ??
    (isTestnet ? './bridge-state.testnet.db' : './bridge-state.db'),
  intentApiPort: int('BRIDGE_INTENT_API_PORT', 3006),

  apiToken: apiToken(),

  rateLimit: {
    windowMs: int('BRIDGE_API_RATE_WINDOW_MS', 60_000),
    maxRequests: int('BRIDGE_API_RATE_MAX', isTestnet ? 20 : 30),
  },

  caps: {
    minAmount: polyxToBase('BRIDGE_MIN_AMOUNT_POLYX', '0.01'),
    maxAmount: polyxToBase('BRIDGE_MAX_AMOUNT_POLYX', isTestnet ? '1000' : '10000'),
    dailyVolume: polyxToBase('BRIDGE_DAILY_VOLUME_POLYX', isTestnet ? '10000' : '100000'),
  },
} as const;

export type Config = typeof config;
