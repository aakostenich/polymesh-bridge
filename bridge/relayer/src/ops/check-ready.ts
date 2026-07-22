/**
 * Readiness check for local or testnet bridge stack.
 *
 * Exit 0 if good enough to bridge; 1 if blockers; 2 if warnings only (--strict treats warnings as fail).
 *
 * Usage:
 *   yarn check
 *   BRIDGE_NETWORK=testnet yarn check
 *   yarn check:testnet
 *   yarn check --strict
 */

import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress, isAddress } from 'ethers';

import { config } from '../config.js';
import { disconnectPolymesh, getEscrowAddress, getEscrowBalance } from '../polymesh.js';

type Severity = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  severity: Severity;
  detail: string;
}

const BRIDGE_ABI = [
  'function relayer() view returns (address)',
  'function paused() view returns (bool)',
  'function wPolyx() view returns (address)',
] as const;

const WPOLYX_ABI = ['function minter() view returns (address)', 'function symbol() view returns (string)'] as const;

const ZERO = '0x0000000000000000000000000000000000000000';

function isZeroAddr(a: string): boolean {
  try {
    return getAddress(a) === getAddress(ZERO);
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const checks: Check[] = [];

  const push = (name: string, severity: Severity, detail: string) => {
    checks.push({ name, severity, detail });
  };

  console.log(`[CHECK] network=${config.network}`);
  console.log(`[CHECK] eth=${config.eth.rpcUrl} chainId=${config.eth.chainId}`);
  console.log(`[CHECK] poly=${config.polymesh.nodeUrl}`);
  console.log('');

  // --- Config sanity ---
  if (isZeroAddr(config.eth.bridgeAddress) || isZeroAddr(config.eth.wPolyxAddress)) {
    push(
      'contracts.addresses',
      'fail',
      'BRIDGE_ADDRESS / WPOLYX_ADDRESS are zero — deploy first (deploy-eth.sh)',
    );
  } else if (!isAddress(config.eth.bridgeAddress) || !isAddress(config.eth.wPolyxAddress)) {
    push('contracts.addresses', 'fail', 'Invalid BRIDGE_ADDRESS or WPOLYX_ADDRESS');
  } else {
    push(
      'contracts.addresses',
      'ok',
      `bridge=${config.eth.bridgeAddress} wPolyx=${config.eth.wPolyxAddress}`,
    );
  }

  if (!config.apiToken) {
    push('api.auth', 'warn', 'BRIDGE_API_TOKEN disabled — do not expose :3006');
  } else {
    push('api.auth', 'ok', 'Bearer auth enabled');
  }

  // --- Ethereum RPC ---
  let provider: JsonRpcProvider | undefined;
  let relayerWallet: Wallet | undefined;
  try {
    provider = new JsonRpcProvider(config.eth.rpcUrl, config.eth.chainId, { staticNetwork: true });
    const net = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    if (Number(net.chainId) !== config.eth.chainId) {
      push(
        'eth.rpc',
        'fail',
        `chain id mismatch: rpc=${net.chainId} config=${config.eth.chainId}`,
      );
    } else {
      push('eth.rpc', 'ok', `chainId=${net.chainId} block=${block}`);
    }

    relayerWallet = new Wallet(config.eth.relayerPrivateKey, provider);
    const ethBal = await provider.getBalance(relayerWallet.address);
    const ethBalNum = Number(formatEther(ethBal));
    const minEth = config.network === 'testnet' ? 0.02 : 0.001;
    if (ethBalNum < minEth) {
      push(
        'eth.relayerGas',
        config.network === 'testnet' ? 'fail' : 'warn',
        `${formatEther(ethBal)} ETH on ${relayerWallet.address} (need ≥ ${minEth} for mints)`,
      );
    } else {
      push('eth.relayerGas', 'ok', `${formatEther(ethBal)} ETH on ${relayerWallet.address}`);
    }
  } catch (err) {
    push('eth.rpc', 'fail', (err as Error).message);
  }

  // --- Contracts ---
  if (provider && !isZeroAddr(config.eth.bridgeAddress)) {
    try {
      const codeB = await provider.getCode(config.eth.bridgeAddress);
      const codeW = await provider.getCode(config.eth.wPolyxAddress);
      if (codeB === '0x' || codeW === '0x') {
        push('contracts.code', 'fail', 'No contract code at bridge/wPolyx — wrong network or not deployed');
      } else {
        const bridge = new Contract(config.eth.bridgeAddress, BRIDGE_ABI, provider);
        const wpolyx = new Contract(config.eth.wPolyxAddress, WPOLYX_ABI, provider);
        const [onChainRelayer, paused, wFromBridge, minter, symbol] = await Promise.all([
          bridge.relayer() as Promise<string>,
          bridge.paused() as Promise<boolean>,
          bridge.wPolyx() as Promise<string>,
          wpolyx.minter() as Promise<string>,
          wpolyx.symbol() as Promise<string>,
        ]);
        push('contracts.code', 'ok', `symbol=${symbol} paused=${paused}`);

        if (getAddress(wFromBridge) !== getAddress(config.eth.wPolyxAddress)) {
          push('contracts.wiring', 'fail', `bridge.wPolyx()=${wFromBridge} != WPOLYX_ADDRESS`);
        } else if (getAddress(minter) !== getAddress(config.eth.bridgeAddress)) {
          push('contracts.wiring', 'fail', `wPolyx.minter()=${minter} != bridge`);
        } else {
          push('contracts.wiring', 'ok', 'bridge ↔ wPolyx minter linked');
        }

        if (relayerWallet && getAddress(onChainRelayer) !== getAddress(relayerWallet.address)) {
          push(
            'contracts.relayerRole',
            'fail',
            `on-chain relayer ${onChainRelayer} != key address ${relayerWallet.address}`,
          );
        } else {
          push('contracts.relayerRole', 'ok', `relayer=${onChainRelayer}`);
        }
      }
    } catch (err) {
      push('contracts', 'fail', (err as Error).message);
    }
  }

  // --- Polymesh ---
  try {
    const escrow = await getEscrowAddress();
    const bal = await getEscrowBalance();
    const polyx = bal.dividedBy(10 ** 6);
    const minEscrow = config.network === 'testnet' ? 10 : 1;
    push('poly.connect', 'ok', `escrow=${escrow}`);
    if (polyx.lt(minEscrow)) {
      push(
        'poly.escrow',
        config.network === 'testnet' ? 'fail' : 'warn',
        `${polyx.toFixed(6)} POLYX (recommend ≥ ${minEscrow} for releases)`,
      );
    } else {
      push('poly.escrow', 'ok', `${polyx.toFixed(6)} POLYX`);
    }
  } catch (err) {
    push('poly.connect', 'fail', (err as Error).message);
  }

  // --- Intent API ---
  const intentBase = `http://127.0.0.1:${config.intentApiPort}`;
  try {
    const res = await fetch(`${intentBase}/health`);
    if (!res.ok) {
      push('relayer.api', 'fail', `HTTP ${res.status} at ${intentBase}/health — is yarn start running?`);
    } else {
      const body = (await res.json()) as { ok?: boolean; authRequired?: boolean };
      push(
        'relayer.api',
        'ok',
        `${intentBase} ok authRequired=${body.authRequired ?? '?'}`,
      );
    }
  } catch (err) {
    push(
      'relayer.api',
      'fail',
      `unreachable ${intentBase} (${(err as Error).message}) — start relayer first for full stack`,
    );
  }

  // --- Report ---
  console.log('Checks:');
  let fails = 0;
  let warns = 0;
  for (const c of checks) {
    const tag = c.severity === 'ok' ? 'OK  ' : c.severity === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${tag}] ${c.name}: ${c.detail}`);
    if (c.severity === 'fail') fails++;
    if (c.severity === 'warn') warns++;
  }

  console.log('');
  if (fails === 0 && (warns === 0 || !strict)) {
    console.log(
      fails === 0 && warns > 0
        ? `[CHECK] READY with ${warns} warning(s). Pass --strict to fail on warnings.`
        : '[CHECK] READY — stack looks good enough to bridge.',
    );
    if (config.network === 'testnet') {
      console.log('[CHECK] Next: yarn lock "<mnemonic>" 0xRecipient 1.0   or open web UI (yarn dev:testnet)');
    }
    process.exitCode = 0;
  } else {
    console.log(`[CHECK] NOT READY — ${fails} failure(s), ${warns} warning(s). See bridge/TESTNET.md`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('[CHECK] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPolymesh();
  });
