import 'dotenv/config';

/**
 * Centralized configuration for the bridge relayer.
 *
 * Defaults match the local dev environment started by `--profile eth`.
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required config: ${name}. See bridge/relayer/.env.example`);
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

/** Human POLYX amount → 6-decimal base units string. */
function polyxToBase(name: string, fallbackHuman: string): string {
  const raw = process.env[name] ?? fallbackHuman;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Config ${name} must be a non-negative number (POLYX), got: ${raw}`);
  }
  // Avoid float junk: multiply carefully for up to 6 decimals.
  const [whole, frac = ''] = String(raw).split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const base = BigInt(whole || '0') * 1_000_000n + BigInt(fracPadded || '0');
  return base.toString();
}

/**
 * API token. Empty / "off" / "none" disables auth (local-only; logged as WARNING).
 * Default `dev-bridge-token` so demos work out of the box with auth enabled.
 */
function apiToken(): string | null {
  const raw = process.env.BRIDGE_API_TOKEN;
  if (raw === undefined) return 'dev-bridge-token';
  const t = raw.trim();
  if (t === '' || t.toLowerCase() === 'off' || t.toLowerCase() === 'none') return null;
  return t;
}

export const config = {
  eth: {
    rpcUrl: required('BRIDGE_ETH_RPC_URL', `http://127.0.0.1:${process.env.BRIDGE_ETH_RPC_PORT ?? 8546}`),
    chainId: int('BRIDGE_ETH_CHAIN_ID', 1337),
    relayerPrivateKey: required(
      'BRIDGE_ETH_RELAYER_KEY',
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ),
    bridgeAddress: required('BRIDGE_ADDRESS'),
    wPolyxAddress: required('WPOLYX_ADDRESS'),
    confirmations: int('BRIDGE_ETH_CONFIRMATIONS', 2),
  },

  polymesh: {
    nodeUrl: required('POLYMESH_NODE_URL', 'ws://127.0.0.1:9944'),
    middlewareUrl: required('POLYMESH_GRAPHQL_URL', 'http://127.0.0.1:3000'),
    escrowMnemonic: required('BRIDGE_POLYMESH_ESCROW_MNEMONIC', '//Charlie'),
  },

  pollIntervalMs: int('BRIDGE_POLL_INTERVAL_MS', 4000),
  polymeshFinalityBlocks: int('BRIDGE_POLYMESH_FINALITY_BLOCKS', 5),
  dbPath: process.env.BRIDGE_DB_PATH ?? './bridge-state.db',
  intentApiPort: int('BRIDGE_INTENT_API_PORT', 3006),

  /** Bearer token for mutating API routes. null = auth disabled. */
  apiToken: apiToken(),

  /** Max POST /lock-intent requests per IP per window. */
  rateLimit: {
    windowMs: int('BRIDGE_API_RATE_WINDOW_MS', 60_000),
    maxRequests: int('BRIDGE_API_RATE_MAX', 30),
  },

  /**
   * Transfer caps in 6-decimal base units.
   * Env vars accept human POLYX (e.g. BRIDGE_MAX_AMOUNT_POLYX=10000).
   */
  caps: {
    minAmount: polyxToBase('BRIDGE_MIN_AMOUNT_POLYX', '0.01'),
    maxAmount: polyxToBase('BRIDGE_MAX_AMOUNT_POLYX', '10000'),
    dailyVolume: polyxToBase('BRIDGE_DAILY_VOLUME_POLYX', '100000'),
  },
} as const;

export type Config = typeof config;
