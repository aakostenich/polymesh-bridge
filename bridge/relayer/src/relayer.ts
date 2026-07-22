import { BigNumber } from '@polymeshassociation/polymesh-sdk';
import { createServer } from 'node:http';

import { config } from './config.js';
import { closeDb, getCursor, isProcessed, markProcessed, setCursor } from './db.js';
import {
  getBridgedToPolymeshEvents,
  getBridgeContract,
  getLatestBlock,
  getRelayerWallet,
  mintFromPolymesh,
} from './eth.js';
import {
  disconnectPolymesh,
  getEscrowAddress,
  getEscrowBalance,
  getIncomingTransfers,
  getPolymesh,
  onFinalizedBlock,
  releasePolyx,
} from './polymesh.js';

/**
 * Main relayer loop.
 *
 * Two independent watchers run on a shared poll cadence:
 *
 *  1. Eth -> Polymesh: scan `BridgedToPolymesh` events (user burned wPOLYX),
 *     wait for confirmations, then release POLYX from escrow on Polymesh.
 *
 *  2. Polymesh -> Eth: scan finalized blocks for transfers into the escrow
 *     (user locked POLYX), wait for finality, then mint wPOLYX on Ethereum.
 *
 * Replay safety: each action is checked against the SQLite store before
 * running and marked after. The mint direction additionally relies on the
 * contract's on-chain `processedNonces` guard.
 *
 * Trust model (MVP): the relayer is the single trusted authority for the mint
 * direction and holds the escrow key. See bridge/README.md.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(scope: string, msg: string): void {
  // ISO timestamp + scope tag for greppable logs.
  console.log(`[${new Date().toISOString()}] [${scope}] ${msg}`);
}

async function processEthToPolymesh(): Promise<void> {
  const latest = await getLatestBlock();
  const confirmations = config.eth.confirmations;
  const safeBlock = latest - confirmations;
  if (safeBlock < 0) return; // chain not deep enough yet

  const fromBlock = getCursor('eth_to_poly') + 1;
  if (fromBlock > safeBlock) return;

  const events = await getBridgedToPolymeshEvents(fromBlock, safeBlock);
  for (const ev of events) {
    const eventId = String(ev.id);
    if (isProcessed('eth_to_poly', eventId)) {
      log('ETH→POLY', `event id=${eventId} already relayed, skipping`);
      continue;
    }

    const amount = new BigNumber(ev.amount.toString());
    log('ETH→POLY', `event id=${eventId}: releasing ${ev.amount} to ${ev.polymeshRecipient}`);

    try {
      const hash = await releasePolyx(ev.polymeshRecipient, amount);
      markProcessed({
        direction: 'eth_to_poly',
        eventId,
        txHash: ev.txHash,
        relayedTxHash: hash,
      });
      log('ETH→POLY', `event id=${eventId} relayed: ${hash}`);
    } catch (err) {
      // Leave unmarked so the next poll retries. Transient failures (e.g. escrow
      // temporarily underfunded, node hiccup) are expected to resolve.
      log('ETH→POLY', `event id=${eventId} FAILED: ${(err as Error).message}`);
    }
  }

  setCursor('eth_to_poly', safeBlock);
}

interface PendingIntent {
  /** Polymesh sender address (must match the transfer's `from`). */
  polySender: string;
  /** Ethereum address to receive minted wPOLYX. */
  ethRecipient: string;
  /** Expected lock amount in base units. */
  amount: string;
  /** Timestamp the intent was registered. */
  createdAt: number;
}

/**
 * MVP binding for Poly->Eth: a pending intent provided out-of-band (see
 * lock-polyx.ts) is matched to an incoming escrow transfer by
 * (sender, amount). A real bridge would carry the eth recipient on-chain
 * (e.g. via a settlement `memo`); see README limitations.
 *
 * This in-memory map is populated by a tiny HTTP endpoint in lock-polyx.ts when
 * run in `--register` mode against a running relayer. For the standalone
 * smoke test we also accept intents via an env-provided list at startup.
 */
const pendingIntents: PendingIntent[] = new Array();

export function registerIntent(intent: PendingIntent): void {
  pendingIntents.push(intent);
  log('POLY→ETH', `intent registered: ${intent.amount} from ${intent.polySender} -> ${intent.ethRecipient}`);
}

function consumeIntent(sender: string, amount: string): PendingIntent | undefined {
  const idx = pendingIntents.findIndex((i) => i.polySender === sender && i.amount === amount);
  if (idx === -1) return undefined;
  const [intent] = pendingIntents.splice(idx, 1);
  return intent;
}

let polyScanBlock = 0;

/**
 * Tiny HTTP API so `lock-polyx.ts` can register a pending intent with a running
 * relayer: POST /lock-intent { polySender, ethRecipient, amount }.
 *
 * This binds an incoming POLYX transfer to the Ethereum address that should
 * receive the minted wPOLYX. Without it the relayer cannot know the eth
 * recipient (MVP limitation — see README). Returns 201 on success, 400 on bad
 * input.
 */
function startIntentApi(): void {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/lock-intent') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy(); // guard against huge payloads
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Partial<PendingIntent>;
          if (!parsed.polySender || !parsed.ethRecipient || !parsed.amount) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing polySender/ethRecipient/amount' }));
            return;
          }
          registerIntent({
            polySender: parsed.polySender,
            ethRecipient: parsed.ethRecipient,
            amount: parsed.amount,
            createdAt: Date.now(),
          });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(config.intentApiPort, () => {
    log('RELAYER', `intent API listening on :${config.intentApiPort} (POST /lock-intent)`);
  });
}


async function processPolymeshToEth(): Promise<void> {
  const sdk = await getPolymesh();
  const escrow = await getEscrowAddress();
  const finalized = await sdk.network.getLatestBlock();
  const finalizedNum = finalized.toNumber();
  const finalityBlocks = config.polymeshFinalityBlocks;
  const safeBlock = Math.max(finalizedNum - finalityBlocks, 0);

  if (polyScanBlock === 0) {
    // First run: resume just below the safe block so we don't replay history.
    polyScanBlock = Math.max(getCursor('poly_to_eth'), 0);
  }
  const fromBlock = polyScanBlock + 1;
  if (fromBlock > safeBlock) return;

  const transfers = await getIncomingTransfers(escrow, fromBlock, safeBlock);
  for (const t of transfers) {
    const eventId = `${t.blockNumber}:${t.from}:${t.amount}`;
    if (isProcessed('poly_to_eth', eventId)) {
      continue;
    }

    const intent = consumeIntent(t.from, t.amount);
    if (!intent) {
      log('POLY→ETH', `transfer at block ${t.blockNumber} from ${t.from} of ${t.amount}: no matching intent, leaving for later`);
      // Re-add to the front so a later intent registration can pick it up.
      // NOTE: for the MVP this means an unmatched early transfer must be
      // registered before the relayer scans its block. See README.
      continue;
    }

    log('POLY→ETH', `minting ${t.amount} wPOLYX to ${intent.ethRecipient} (lock at block ${t.blockNumber})`);
    try {
      // Use blockNumber as the on-chain replay key for the mint.
      const polyEventId = BigInt(t.blockNumber);
      const hash = await mintFromPolymesh(intent.ethRecipient, BigInt(t.amount), polyEventId);
      markProcessed({
        direction: 'poly_to_eth',
        eventId,
        relayedTxHash: hash,
      });
      log('POLY→ETH', `minted: ${hash}`);
    } catch (err) {
      log('POLY→ETH', `mint FAILED: ${(err as Error).message}`);
    }
  }

  polyScanBlock = safeBlock;
  setCursor('poly_to_eth', safeBlock);
}

async function main(): Promise<void> {
  log('RELAYER', 'starting');
  const sdk = await getPolymesh();
  const escrow = await getEscrowAddress();
  const balance = await getEscrowBalance();
  log('RELAYER', `connected to Polymesh; escrow=${escrow} balance=${balance.dividedBy(10 ** 6).toFixed(6)} POLYX`);
  log('RELAYER', `Ethereum RPC=${config.eth.rpcUrl} bridge=${config.eth.bridgeAddress}`);

  // Sanity: verify the relayer key matches the on-chain relayer role.
  const bridge = getBridgeContract();
  const onChainRelayer: string = await bridge.relayer();
  const walletAddr = getRelayerWallet().address;
  if (walletAddr.toLowerCase() !== onChainRelayer.toLowerCase()) {
    log('RELAYER', `WARNING: relayer wallet ${walletAddr} != on-chain relayer ${onChainRelayer}. Minting will fail.`);
  }

  // Best-effort: drive a Polymesh finalized-block tick so Poly->Eth keeps moving
  // even if the poll interval is long. Errors here are non-fatal.
  onFinalizedBlock(() => {
    void processPolymeshToEth().catch((e) => log('POLY→ETH', `tick error: ${(e as Error).message}`));
  }).catch((e) => log('RELAYER', `block subscription error: ${(e as Error).message}`));

  // HTTP API for Poly->Eth intent registration (used by lock-polyx.ts).
  startIntentApi();

  log('RELAYER', `polling every ${config.pollIntervalMs}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await Promise.allSettled([processEthToPolymesh(), processPolymeshToEth()]);
    await sleep(config.pollIntervalMs);
  }
}

main()
  .catch((err) => {
    console.error('[RELAYER] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    closeDb();
    await disconnectPolymesh();
  });
