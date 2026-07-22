import 'dotenv/config';

/**
 * Centralized configuration for the bridge relayer.
 *
 * All values can be overridden via environment variables (see `.env.example`).
 * Defaults match the local dev environment started by `--profile eth`:
 *   - Polymesh node:      ws://127.0.0.1:9944   (from this repo's dev-env)
 *   - Polymesh middleware: http://127.0.0.1:3000 (Subquery GraphQL)
 *   - Ethereum (Anvil):   http://127.0.0.1:8546  (added by this bridge)
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

export const config = {
  // --- Ethereum (Anvil) ---
  eth: {
    rpcUrl: required('BRIDGE_ETH_RPC_URL', `http://127.0.0.1:${process.env.BRIDGE_ETH_RPC_PORT ?? 8546}`),
    chainId: int('BRIDGE_ETH_CHAIN_ID', 1337),
    // Private key the relayer uses to call mintFromPolymesh on Ethereum.
    // Defaults to Anvil account[1] (the relayer address set during deploy).
    relayerPrivateKey: required('BRIDGE_ETH_RELAYER_KEY', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),
    // Deployed contract addresses (filled in after running deploy-eth.sh).
    bridgeAddress: required('BRIDGE_ADDRESS'),
    wPolyxAddress: required('WPOLYX_ADDRESS'),
    // Number of Ethereum confirmations before acting on a burn event.
    // On Anvil with auto-mining this can be low; bump for real networks.
    confirmations: int('BRIDGE_ETH_CONFIRMATIONS', 2),
  },

  // --- Polymesh ---
  polymesh: {
    nodeUrl: required('POLYMESH_NODE_URL', 'ws://127.0.0.1:9944'),
    middlewareUrl: required('POLYMESH_GRAPHQL_URL', 'http://127.0.0.1:3000'),
    // Mnemonic of the Polymesh account that holds the POLYX escrow.
    // This account receives locked POLYX (Poly->Eth) and releases POLYX (Eth->Poly).
    escrowMnemonic: required('BRIDGE_POLYMESH_ESCROW_MNEMONIC', '//Charlie'),
  },

  // --- Relayer behaviour ---
  pollIntervalMs: int('BRIDGE_POLL_INTERVAL_MS', 4000),
  // Number of Polymesh blocks to consider final before crediting a lock.
  polymeshFinalityBlocks: int('BRIDGE_POLYMESH_FINALITY_BLOCKS', 5),
  dbPath: process.env.BRIDGE_DB_PATH ?? './bridge-state.db',
  // HTTP port for the intent-registration API (used by lock-polyx.ts to tell
  // the relayer which Ethereum address a POLYX lock is destined for).
  intentApiPort: int('BRIDGE_INTENT_API_PORT', 3006),
} as const;

export type Config = typeof config;
