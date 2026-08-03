/**
 * Pure function that maps a raw disconnect error into a classified reason
 * plus a recoverable flag.
 *
 * The classifier is intentionally conservative: when we cannot confidently
 * detect a hard-fail cause, we mark the disconnect as NON-recoverable so the
 * reconnect manager does not end up in an infinite retry loop against Zalo.
 *
 * Red team H3 noted that a pure regex classifier is brittle if Zalo changes
 * its error strings. We mitigate by:
 *   1. Matching on multiple signals (message, code, name)
 *   2. Defaulting to non-recoverable on "unknown" so loops bail out fast
 *   3. Never swallowing an error — the original is always passed through
 */

export type DisconnectReason =
  | 'cookie_expired'
  | 'banned'
  | 'manual'
  | 'network'
  | 'heartbeat_failed'
  | 'listener_closed'
  | 'unknown';

export interface ClassifiedDisconnect {
  reason: DisconnectReason;
  recoverable: boolean;
  message: string;
}

interface ErrorLike {
  message?: string;
  code?: string | number;
  name?: string;
}

export function classifyDisconnect(err: unknown): ClassifiedDisconnect {
  const e: ErrorLike =
    err && typeof err === 'object' ? (err as ErrorLike) : { message: String(err) };
  const message = String(e.message ?? err ?? '');
  const code = String(e.code ?? '').toLowerCase();
  const name = String(e.name ?? '').toLowerCase();
  const haystack = `${message} ${code} ${name}`.toLowerCase();

  // --- Hard failures (do NOT auto-retry) ---
  if (/\b(401|403)\b|unauthor|invalid.*cookie|session.*expired|thất bại/.test(haystack)) {
    return {
      reason: 'cookie_expired',
      recoverable: false,
      message,
    };
  }
  if (/banned|suspended|blocked|bị chặn/.test(haystack)) {
    return { reason: 'banned', recoverable: false, message };
  }
  if (/password.*changed|force.*logout|manual.*logout/.test(haystack)) {
    return { reason: 'manual', recoverable: false, message };
  }

  // --- Transient failures (safe to retry) ---
  if (/econnreset|etimedout|enetdown|enetunreach|socket hang up|network/.test(haystack)) {
    return { reason: 'network', recoverable: true, message };
  }
  if (/heartbeat|ping.*fail|no.*pong/.test(haystack)) {
    return { reason: 'heartbeat_failed', recoverable: true, message };
  }
  if (/listener.*closed|ws.*closed|websocket.*closed/.test(haystack)) {
    return { reason: 'listener_closed', recoverable: true, message };
  }

  // Unknown → default to NON-recoverable to stop retry loops.
  return { reason: 'unknown', recoverable: false, message };
}
