import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import { config } from './config.js';

/**
 * Persistent store: replay protection, scan cursors, intents, transfer statuses.
 *
 * Intents are keyed by a short hex `intentId` carried in the Polymesh transfer
 * memo (`b:<intentId>`). That replaces fragile (sender, amount) matching and
 * survives relayer restarts.
 */

export type Direction = 'eth_to_poly' | 'poly_to_eth';

/** Lifecycle of a cross-chain transfer tracked by the relayer. */
export type TransferStatus =
  | 'intent_registered' // Poly→Eth: intent created, lock not seen yet
  | 'locked' // Poly→Eth: escrow transfer observed
  | 'awaiting_finality' // waiting Polymesh finality blocks / Eth confirmations
  | 'relaying' // mint or release in flight
  | 'completed'
  | 'failed';

export interface ProcessedEvent {
  direction: Direction;
  eventId: string;
  txHash?: string;
  relayedTxHash?: string;
}

export interface IntentRecord {
  intentId: string;
  direction: Direction;
  status: TransferStatus;
  polySender: string | null;
  ethRecipient: string | null;
  polymeshRecipient: string | null;
  amount: string;
  polyBlock: number | null;
  ethTxHash: string | null;
  polyTxHash: string | null;
  relayedTxHash: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

let _db: Database.Database | undefined;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath);
    _db.pragma('journal_mode = WAL');

    _db.exec(`
      CREATE TABLE IF NOT EXISTS processed_events (
        direction       TEXT    NOT NULL,
        event_id        TEXT    NOT NULL,
        tx_hash         TEXT,
        relayed_tx_hash TEXT,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (direction, event_id)
      );

      CREATE TABLE IF NOT EXISTS scan_cursor (
        direction   TEXT PRIMARY KEY,
        last_block  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transfers (
        intent_id            TEXT PRIMARY KEY,
        direction            TEXT NOT NULL,
        status               TEXT NOT NULL,
        poly_sender          TEXT,
        eth_recipient        TEXT,
        polymesh_recipient   TEXT,
        amount               TEXT NOT NULL,
        poly_block           INTEGER,
        eth_tx_hash          TEXT,
        poly_tx_hash         TEXT,
        relayed_tx_hash      TEXT,
        error                TEXT,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
      CREATE INDEX IF NOT EXISTS idx_transfers_updated ON transfers(updated_at DESC);
    `);
  }
  return _db;
}

/** 16 hex chars (8 bytes) — fits in Polymesh 32-byte memo as `b:<id>`. */
export function generateIntentId(): string {
  return randomBytes(8).toString('hex');
}

/** Memo payload put on the Polymesh lock transfer. */
export function memoForIntent(intentId: string): string {
  return `b:${intentId}`;
}

/** Decode Polymesh memo (utf8 string, hex 0x…, or padded 32-byte hex) to text. */
export function decodeMemoBytes(memo: string | null | undefined): string | null {
  if (!memo) return null;
  let s = String(memo).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) {
    try {
      const hex = s.slice(2);
      s = Buffer.from(hex, 'hex').toString('utf8');
    } catch {
      return null;
    }
  }
  // Strip null padding used by fixed 32-byte Memo type.
  return s.replace(/\0/g, '').trim() || null;
}

/** Parse `b:<16hex>` (or legacy `bridge:<id>`) from a memo string or hex. */
export function parseIntentIdFromMemo(memo: string | null | undefined): string | null {
  const cleaned = decodeMemoBytes(memo);
  if (!cleaned) return null;
  const m = cleaned.match(/^(?:b|bridge):([0-9a-fA-F]{8,32})$/i);
  return m ? m[1].toLowerCase() : null;
}

export function isProcessed(direction: Direction, eventId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM processed_events WHERE direction = ? AND event_id = ?')
    .get(direction, eventId);
  return row !== undefined;
}

export function markProcessed(ev: ProcessedEvent): void {
  getDb()
    .prepare(
      `INSERT INTO processed_events (direction, event_id, tx_hash, relayed_tx_hash)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(direction, event_id) DO UPDATE SET relayed_tx_hash = excluded.relayed_tx_hash`,
    )
    .run(ev.direction, ev.eventId, ev.txHash ?? null, ev.relayedTxHash ?? null);
}

export function getCursor(direction: Direction): number {
  const row = getDb().prepare('SELECT last_block FROM scan_cursor WHERE direction = ?').get(direction) as
    | { last_block: number }
    | undefined;
  return row?.last_block ?? 0;
}

export function setCursor(direction: Direction, lastBlock: number): void {
  getDb()
    .prepare(
      `INSERT INTO scan_cursor (direction, last_block) VALUES (?, ?)
       ON CONFLICT(direction) DO UPDATE SET last_block = excluded.last_block`,
    )
    .run(direction, lastBlock);
}

function rowToIntent(row: Record<string, unknown>): IntentRecord {
  return {
    intentId: String(row.intent_id),
    direction: row.direction as Direction,
    status: row.status as TransferStatus,
    polySender: (row.poly_sender as string) ?? null,
    ethRecipient: (row.eth_recipient as string) ?? null,
    polymeshRecipient: (row.polymesh_recipient as string) ?? null,
    amount: String(row.amount),
    polyBlock: row.poly_block === null || row.poly_block === undefined ? null : Number(row.poly_block),
    ethTxHash: (row.eth_tx_hash as string) ?? null,
    polyTxHash: (row.poly_tx_hash as string) ?? null,
    relayedTxHash: (row.relayed_tx_hash as string) ?? null,
    error: (row.error as string) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createPolyToEthIntent(params: {
  polySender: string;
  ethRecipient: string;
  amount: string;
}): IntentRecord {
  const intentId = generateIntentId();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO transfers (
        intent_id, direction, status, poly_sender, eth_recipient, amount,
        created_at, updated_at
      ) VALUES (?, 'poly_to_eth', 'intent_registered', ?, ?, ?, ?, ?)`,
    )
    .run(intentId, params.polySender, params.ethRecipient, params.amount, now, now);
  return getTransfer(intentId)!;
}

export function createEthToPolyTransfer(params: {
  intentId: string;
  ethSender: string;
  polymeshRecipient: string;
  amount: string;
  ethTxHash: string;
  status?: TransferStatus;
}): IntentRecord {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO transfers (
        intent_id, direction, status, poly_sender, eth_recipient, polymesh_recipient,
        amount, eth_tx_hash, created_at, updated_at
      ) VALUES (?, 'eth_to_poly', ?, ?, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(intent_id) DO NOTHING`,
    )
    .run(
      params.intentId,
      params.status ?? 'awaiting_finality',
      params.ethSender,
      params.polymeshRecipient,
      params.amount,
      params.ethTxHash,
      now,
      now,
    );
  return getTransfer(params.intentId)!;
}

export function getTransfer(intentId: string): IntentRecord | undefined {
  const row = getDb().prepare('SELECT * FROM transfers WHERE intent_id = ?').get(intentId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToIntent(row) : undefined;
}

export function listTransfers(limit = 50): IntentRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM transfers ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToIntent);
}

export function updateTransfer(
  intentId: string,
  patch: Partial<{
    status: TransferStatus;
    polyBlock: number | null;
    ethTxHash: string | null;
    polyTxHash: string | null;
    relayedTxHash: string | null;
    error: string | null;
    polySender: string | null;
    ethRecipient: string | null;
    polymeshRecipient: string | null;
  }>,
): void {
  const current = getTransfer(intentId);
  if (!current) return;
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `UPDATE transfers SET
        status = ?,
        poly_block = ?,
        eth_tx_hash = ?,
        poly_tx_hash = ?,
        relayed_tx_hash = ?,
        error = ?,
        poly_sender = ?,
        eth_recipient = ?,
        polymesh_recipient = ?,
        updated_at = ?
      WHERE intent_id = ?`,
    )
    .run(
      patch.status ?? current.status,
      patch.polyBlock !== undefined ? patch.polyBlock : current.polyBlock,
      patch.ethTxHash !== undefined ? patch.ethTxHash : current.ethTxHash,
      patch.polyTxHash !== undefined ? patch.polyTxHash : current.polyTxHash,
      patch.relayedTxHash !== undefined ? patch.relayedTxHash : current.relayedTxHash,
      patch.error !== undefined ? patch.error : current.error,
      patch.polySender !== undefined ? patch.polySender : current.polySender,
      patch.ethRecipient !== undefined ? patch.ethRecipient : current.ethRecipient,
      patch.polymeshRecipient !== undefined ? patch.polymeshRecipient : current.polymeshRecipient,
      now,
      intentId,
    );
}

/** Convert 16-hex intent id into a uint256-safe polyEventId for the bridge contract. */
export function intentIdToPolyEventId(intentId: string): bigint {
  // Use lower 16 hex chars; pad if shorter.
  const hex = intentId.replace(/^0x/, '').toLowerCase().padStart(16, '0').slice(0, 16);
  return BigInt(`0x${hex}`);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
