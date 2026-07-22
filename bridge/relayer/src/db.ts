import Database from 'better-sqlite3';

import { config } from './config.js';

/**
 * Persistent replay-protection store.
 *
 * Each processed cross-chain action is recorded once. Both directions are
 * covered:
 *   - 'eth_to_poly': a `BridgedToPolymesh` event id that has triggered a POLYX
 *     release on Polymesh.
 *   - 'poly_to_eth': a Polymesh lock (block + sender + amount) that has
 *     triggered a wPOLYX mint on Ethereum.
 *
 * This is the relayer's own idempotency layer; the bridge contract has an
 * independent on-chain `processedNonces` guard for the mint direction.
 */

export type Direction = 'eth_to_poly' | 'poly_to_eth';

export interface ProcessedEvent {
  direction: Direction;
  /** Unique id for this direction: Eth event id (eth_to_poly) or synthetic Polymesh id (poly_to_eth). */
  eventId: string;
  /** Optional source tx hash for traceability. */
  txHash?: string;
  /** Optional destination tx hash once the relay completes. */
  relayedTxHash?: string;
}

let _db: Database.Database | undefined;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath);
    _db.pragma('journal_mode = WAL');

    _db.exec(`
      CREATE TABLE IF NOT EXISTS processed_events (
        direction      TEXT    NOT NULL,
        event_id       TEXT    NOT NULL,
        tx_hash        TEXT,
        relayed_tx_hash TEXT,
        created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (direction, event_id)
      );
    `);

    // Track per-direction scan cursors so restarts resume without rescanning.
    _db.exec(`
      CREATE TABLE IF NOT EXISTS scan_cursor (
        direction   TEXT PRIMARY KEY,
        last_block  INTEGER NOT NULL
      );
    `);
  }
  return _db;
}

/** Returns true if the given (direction, eventId) was already relayed. */
export function isProcessed(direction: Direction, eventId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM processed_events WHERE direction = ? AND event_id = ?').get(direction, eventId);
  return row !== undefined;
}

/** Record a relayed event. Inserting an existing key is a no-op (idempotent). */
export function markProcessed(ev: ProcessedEvent): void {
  getDb()
    .prepare(
      `INSERT INTO processed_events (direction, event_id, tx_hash, relayed_tx_hash)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(direction, event_id) DO UPDATE SET relayed_tx_hash = excluded.relayed_tx_hash`,
    )
    .run(ev.direction, ev.eventId, ev.txHash ?? null, ev.relayedTxHash ?? null);
}

/** Get the last-scanned block for a direction (inclusive resume point), or 0. */
export function getCursor(direction: Direction): number {
  const row = getDb().prepare('SELECT last_block FROM scan_cursor WHERE direction = ?').get(direction) as
    | { last_block: number }
    | undefined;
  return row?.last_block ?? 0;
}

/** Persist the last-scanned block for a direction. */
export function setCursor(direction: Direction, lastBlock: number): void {
  getDb()
    .prepare(
      `INSERT INTO scan_cursor (direction, last_block) VALUES (?, ?)
       ON CONFLICT(direction) DO UPDATE SET last_block = excluded.last_block`,
    )
    .run(direction, lastBlock);
}

/** Close the database handle (mainly for tests / clean shutdown). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
