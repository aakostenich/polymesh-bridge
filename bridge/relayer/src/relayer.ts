import { BigNumber } from '@polymeshassociation/polymesh-sdk';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { config } from './config.js';
import {
  closeDb,
  createEthToPolyTransfer,
  createPolyToEthIntent,
  getCursor,
  getTransfer,
  intentIdToPolyEventId,
  isProcessed,
  listTransfers,
  markProcessed,
  memoForIntent,
  setCursor,
  updateTransfer,
} from './db.js';
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
 * Main relayer loop + HTTP status/intent API.
 *
 * Poly→Eth binding uses a short intent id in the Polymesh transfer memo
 * (`b:<intentId>`), stored in SQLite so restarts resume correctly.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(scope: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${scope}] ${msg}`);
}

function readBody(req: IncomingMessage, limit = 8192): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(payload));
}

async function processEthToPolymesh(): Promise<void> {
  const latest = await getLatestBlock();
  const confirmations = config.eth.confirmations;
  const safeBlock = latest - confirmations;
  if (safeBlock < 0) return;

  const fromBlock = getCursor('eth_to_poly') + 1;
  if (fromBlock > safeBlock) return;

  const events = await getBridgedToPolymeshEvents(fromBlock, safeBlock);
  for (const ev of events) {
    const eventId = String(ev.id);
    const intentId = `eth-${eventId}`;

    if (isProcessed('eth_to_poly', eventId)) {
      log('ETH→POLY', `event id=${eventId} already relayed, skipping`);
      continue;
    }

    // Track transfer status (create if first time we see this burn).
    if (!getTransfer(intentId)) {
      createEthToPolyTransfer({
        intentId,
        ethSender: ev.sender,
        polymeshRecipient: ev.polymeshRecipient,
        amount: ev.amount.toString(),
        ethTxHash: ev.txHash,
        status: 'awaiting_finality',
      });
    } else {
      updateTransfer(intentId, { status: 'awaiting_finality', ethTxHash: ev.txHash });
    }

    const amount = new BigNumber(ev.amount.toString());
    log('ETH→POLY', `event id=${eventId}: releasing ${ev.amount} to ${ev.polymeshRecipient}`);
    updateTransfer(intentId, { status: 'relaying' });

    try {
      const hash = await releasePolyx(ev.polymeshRecipient, amount);
      markProcessed({
        direction: 'eth_to_poly',
        eventId,
        txHash: ev.txHash,
        relayedTxHash: hash,
      });
      updateTransfer(intentId, {
        status: 'completed',
        relayedTxHash: hash,
        polyTxHash: hash,
        error: null,
      });
      log('ETH→POLY', `event id=${eventId} relayed: ${hash}`);
    } catch (err) {
      const message = (err as Error).message;
      updateTransfer(intentId, { status: 'failed', error: message });
      log('ETH→POLY', `event id=${eventId} FAILED: ${message}`);
    }
  }

  setCursor('eth_to_poly', safeBlock);
}

let polyScanBlock = 0;

/** Mint for a lock that is already recorded in SQLite (restart-safe). */
async function mintForIntent(intentId: string): Promise<void> {
  const intent = getTransfer(intentId);
  if (!intent || intent.direction !== 'poly_to_eth') return;
  if (intent.status === 'completed') return;

  const eventId = `intent:${intentId}`;
  if (isProcessed('poly_to_eth', eventId)) {
    updateTransfer(intentId, { status: 'completed' });
    return;
  }

  if (!intent.ethRecipient) {
    updateTransfer(intentId, { status: 'failed', error: 'missing ethRecipient on intent' });
    return;
  }

  updateTransfer(intentId, { status: 'relaying', error: null });
  log(
    'POLY→ETH',
    `minting ${intent.amount} wPOLYX to ${intent.ethRecipient} (intent=${intentId}, block=${intent.polyBlock})`,
  );

  try {
    const polyEventId = intentIdToPolyEventId(intentId);
    const hash = await mintFromPolymesh(intent.ethRecipient, BigInt(intent.amount), polyEventId);
    markProcessed({
      direction: 'poly_to_eth',
      eventId,
      relayedTxHash: hash,
    });
    updateTransfer(intentId, {
      status: 'completed',
      relayedTxHash: hash,
      ethTxHash: hash,
      error: null,
    });
    log('POLY→ETH', `intent ${intentId} minted: ${hash}`);
  } catch (err) {
    const message = (err as Error).message;
    updateTransfer(intentId, { status: 'failed', error: message });
    log('POLY→ETH', `intent ${intentId} mint FAILED: ${message}`);
  }
}

/** Retry locks that were observed but not completed (relayer crash / RPC blip). */
async function retryIncompletePolyToEth(): Promise<void> {
  for (const t of listTransfers(100)) {
    if (t.direction !== 'poly_to_eth') continue;
    if (t.polyBlock === null) continue;
    if (t.status === 'completed') continue;
    if (t.status === 'intent_registered') continue;
    // amount/sender failures are terminal
    if (t.error?.includes('mismatch')) continue;
    await mintForIntent(t.intentId);
  }
}

async function processPolymeshToEth(): Promise<void> {
  const sdk = await getPolymesh();
  const escrow = await getEscrowAddress();
  const finalized = await sdk.network.getLatestBlock();
  const finalizedNum = finalized.toNumber();
  const finalityBlocks = config.polymeshFinalityBlocks;
  const safeBlock = Math.max(finalizedNum - finalityBlocks, 0);

  if (polyScanBlock === 0) {
    polyScanBlock = Math.max(getCursor('poly_to_eth'), 0);
  }
  let fromBlock = polyScanBlock + 1;

  // Always retry incomplete mints first (covers restarts after cursor advanced).
  await retryIncompletePolyToEth();

  // If intents are still waiting for a lock observation, rescan a recent window
  // so a prior skip (e.g. memo decode bug) or cursor race cannot strand them.
  const pendingLocks = listTransfers(50).filter(
    (t) => t.direction === 'poly_to_eth' && t.status === 'intent_registered',
  );
  if (pendingLocks.length > 0) {
    const rescanFrom = Math.max(0, safeBlock - 64);
    if (fromBlock > rescanFrom) fromBlock = rescanFrom;
  }

  if (fromBlock > safeBlock) return;

  const transfers = await getIncomingTransfers(escrow, fromBlock, safeBlock);
  for (const t of transfers) {
    const intentId = t.intentId;
    if (!intentId) {
      log(
        'POLY→ETH',
        `transfer block=${t.blockNumber} from=${t.from} amount=${t.amount}: no intent id in memo, skipping`,
      );
      continue;
    }

    const intent = getTransfer(intentId);
    if (!intent || intent.direction !== 'poly_to_eth') {
      log('POLY→ETH', `intent ${intentId} not registered (transfer at block ${t.blockNumber})`);
      continue;
    }

    if (intent.status === 'completed' || isProcessed('poly_to_eth', `intent:${intentId}`)) {
      updateTransfer(intentId, { status: 'completed' });
      continue;
    }

    if (intent.amount !== t.amount) {
      const msg = `amount mismatch: intent=${intent.amount} transfer=${t.amount}`;
      updateTransfer(intentId, {
        status: 'failed',
        error: msg,
        polyBlock: t.blockNumber,
        polyTxHash: t.extrinsicHash,
      });
      log('POLY→ETH', `intent ${intentId}: ${msg}`);
      continue;
    }

    if (intent.polySender && intent.polySender !== t.from) {
      const msg = `sender mismatch: intent=${intent.polySender} transfer=${t.from}`;
      updateTransfer(intentId, {
        status: 'failed',
        error: msg,
        polyBlock: t.blockNumber,
      });
      log('POLY→ETH', `intent ${intentId}: ${msg}`);
      continue;
    }

    // Persist observation BEFORE mint so a crash still resumes from SQLite.
    updateTransfer(intentId, {
      status: 'locked',
      polyBlock: t.blockNumber,
      polyTxHash: t.extrinsicHash,
      polySender: t.from,
    });

    await mintForIntent(intentId);
  }

  polyScanBlock = safeBlock;
  setCursor('poly_to_eth', safeBlock);
}

/**
 * HTTP API:
 *   GET  /health
 *   POST /lock-intent  { polySender, ethRecipient, amount } → { intentId, memo, status }
 *   GET  /transfers
 *   GET  /transfers/:intentId
 */
function startApi(): void {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'OPTIONS') {
          json(res, 204, {});
          return;
        }

        const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.intentApiPort}`);

        if (req.method === 'GET' && url.pathname === '/health') {
          json(res, 200, { ok: true });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/transfers') {
          const limit = Number(url.searchParams.get('limit') ?? '50');
          json(res, 200, { transfers: listTransfers(Number.isFinite(limit) ? limit : 50) });
          return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/transfers/')) {
          const intentId = url.pathname.slice('/transfers/'.length);
          const t = getTransfer(intentId);
          if (!t) {
            json(res, 404, { error: 'not found' });
            return;
          }
          json(res, 200, { transfer: t, memo: memoForIntent(t.intentId) });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/lock-intent') {
          const body = await readBody(req);
          const parsed = JSON.parse(body) as {
            polySender?: string;
            ethRecipient?: string;
            amount?: string;
          };
          if (!parsed.polySender || !parsed.ethRecipient || !parsed.amount) {
            json(res, 400, { error: 'missing polySender/ethRecipient/amount' });
            return;
          }
          if (!parsed.ethRecipient.startsWith('0x') || parsed.ethRecipient.length !== 42) {
            json(res, 400, { error: 'invalid ethRecipient' });
            return;
          }

          const intent = createPolyToEthIntent({
            polySender: parsed.polySender,
            ethRecipient: parsed.ethRecipient,
            amount: parsed.amount,
          });
          const memo = memoForIntent(intent.intentId);
          log(
            'POLY→ETH',
            `intent registered id=${intent.intentId} amount=${intent.amount} ${intent.polySender} -> ${intent.ethRecipient}`,
          );
          json(res, 201, {
            ok: true,
            intentId: intent.intentId,
            memo,
            status: intent.status,
            transfer: intent,
          });
          return;
        }

        json(res, 404, { error: 'not found' });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    })();
  });

  server.listen(config.intentApiPort, () => {
    log(
      'RELAYER',
      `API on :${config.intentApiPort}  POST /lock-intent  GET /transfers  GET /health`,
    );
  });
}

async function main(): Promise<void> {
  log('RELAYER', 'starting');
  const escrow = await getEscrowAddress();
  const balance = await getEscrowBalance();
  log(
    'RELAYER',
    `connected to Polymesh; escrow=${escrow} balance=${balance.dividedBy(10 ** 6).toFixed(6)} POLYX`,
  );
  log('RELAYER', `Ethereum RPC=${config.eth.rpcUrl} bridge=${config.eth.bridgeAddress}`);

  const bridge = getBridgeContract();
  const onChainRelayer: string = await bridge.relayer();
  const walletAddr = getRelayerWallet().address;
  if (walletAddr.toLowerCase() !== onChainRelayer.toLowerCase()) {
    log(
      'RELAYER',
      `WARNING: relayer wallet ${walletAddr} != on-chain relayer ${onChainRelayer}. Minting will fail.`,
    );
  }

  onFinalizedBlock(() => {
    void processPolymeshToEth().catch((e) => log('POLY→ETH', `tick error: ${(e as Error).message}`));
  }).catch((e) => log('RELAYER', `block subscription error: ${(e as Error).message}`));

  startApi();

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
