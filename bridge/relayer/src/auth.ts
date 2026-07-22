import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { config } from './config.js';

/** Extract Bearer token from Authorization header. */
export function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Returns null if authorized, or an error message.
 * When `config.apiToken` is null, auth is disabled.
 */
export function authorize(req: IncomingMessage): string | null {
  if (!config.apiToken) return null;
  const token = extractBearer(req);
  if (!token) return 'missing Authorization: Bearer <token>';
  if (!safeEqual(token, config.apiToken)) return 'invalid API token';
  return null;
}

/** Simple fixed-window rate limiter per key (usually client IP). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /** Returns true if the request is allowed. */
  allow(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const prev = this.hits.get(key) ?? [];
    const recent = prev.filter((t) => t >= windowStart);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export function clientKey(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length > 0) return xf.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}
