import { config } from './config.js';
import { sumVolumeSince } from './db.js';

export type CapCheckOk = { ok: true };
export type CapCheckErr = { ok: false; error: string };
export type CapCheck = CapCheckOk | CapCheckErr;

function startOfUtcDayUnix(): number {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

export function formatBaseAsPolyx(base: string | bigint): string {
  const n = typeof base === 'bigint' ? base : BigInt(base);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Enforce min / max per-tx and rolling UTC-day volume limit.
 * `amountBase` is 6-decimal base units as a decimal string.
 */
export function checkTransferCaps(amountBase: string): CapCheck {
  let amount: bigint;
  try {
    amount = BigInt(amountBase);
  } catch {
    return { ok: false, error: 'invalid amount' };
  }
  if (amount <= 0n) {
    return { ok: false, error: 'amount must be > 0' };
  }

  const min = BigInt(config.caps.minAmount);
  const max = BigInt(config.caps.maxAmount);
  const daily = BigInt(config.caps.dailyVolume);

  if (amount < min) {
    return {
      ok: false,
      error: `amount ${formatBaseAsPolyx(amount)} POLYX below minimum ${formatBaseAsPolyx(min)} POLYX`,
    };
  }
  if (amount > max) {
    return {
      ok: false,
      error: `amount ${formatBaseAsPolyx(amount)} POLYX above maximum ${formatBaseAsPolyx(max)} POLYX`,
    };
  }

  const used = sumVolumeSince(startOfUtcDayUnix());
  if (used + amount > daily) {
    return {
      ok: false,
      error: `daily volume exceeded: used ${formatBaseAsPolyx(used)} + ${formatBaseAsPolyx(amount)} > limit ${formatBaseAsPolyx(daily)} POLYX (UTC day)`,
    };
  }

  return { ok: true };
}

export function capsSnapshot(): {
  minAmount: string;
  maxAmount: string;
  dailyVolume: string;
  dailyUsed: string;
  minPolyx: string;
  maxPolyx: string;
  dailyVolumePolyx: string;
  dailyUsedPolyx: string;
} {
  const dailyUsed = sumVolumeSince(startOfUtcDayUnix());
  return {
    minAmount: config.caps.minAmount,
    maxAmount: config.caps.maxAmount,
    dailyVolume: config.caps.dailyVolume,
    dailyUsed: dailyUsed.toString(),
    minPolyx: formatBaseAsPolyx(config.caps.minAmount),
    maxPolyx: formatBaseAsPolyx(config.caps.maxAmount),
    dailyVolumePolyx: formatBaseAsPolyx(config.caps.dailyVolume),
    dailyUsedPolyx: formatBaseAsPolyx(dailyUsed),
  };
}
