import { childLogger } from '../logger.js';
import { publishEvent } from '../redis/event-publisher.js';
import type { SessionContext } from '../sessions/session-context.js';
import { classifyDisconnect } from './disconnect-classifier.js';

/**
 * Auto-reconnect loop for Zalo sessions that drop for transient reasons.
 *
 * Algorithm:
 *   1. onDisconnect classifies the error
 *   2. If non-recoverable → mark expired + emit event + stop
 *   3. If recoverable → schedule retry with exponential backoff
 *      (5s, 15s, 60s, 300s, 900s) capped at 5 attempts per hour
 *   4. Retry counter resets when a session becomes ready again
 *
 * Red team H6 + H3 notes:
 *   - Rate limiter prevents runaway retry loops on persistent network issues
 *   - Cap per hour prevents ban amplification
 *   - Non-recoverable errors bypass retries entirely
 */

const log = childLogger({ component: 'reconnect-manager' });

const BACKOFF_SCHEDULE_MS = [5_000, 15_000, 60_000, 300_000, 900_000];
const MAX_ATTEMPTS_PER_HOUR = 5;
const WINDOW_MS = 60 * 60 * 1000;

interface RetryBudget {
  attempts: number;
  windowStart: number;
}

interface RetryFn {
  (ctx: SessionContext): Promise<void>;
}

class ReconnectManager {
  private readonly budgets = new Map<string, RetryBudget>();
  private readonly scheduled = new Map<string, NodeJS.Timeout>();

  /** Called whenever a session transitions to disconnected. */
  handleDisconnect(ctx: SessionContext, err: unknown, retry: RetryFn): void {
    const classification = classifyDisconnect(err);

    log.info(
      {
        session_id: ctx.sessionId,
        reason: classification.reason,
        recoverable: classification.recoverable,
      },
      'reconnect-manager: disconnect classified',
    );

    if (!classification.recoverable) {
      ctx.markDisconnected(classification.reason);
      void publishEvent({
        type: 'session_disconnected',
        session_id: ctx.sessionId,
        reason: classification.reason,
        recoverable: false,
        error_message: classification.message,
      });
      this.clearBudget(ctx.sessionId);
      return;
    }

    // Recoverable — schedule retry if we still have budget.
    const budget = this.getBudget(ctx.sessionId);
    if (budget.attempts >= MAX_ATTEMPTS_PER_HOUR) {
      log.warn(
        { session_id: ctx.sessionId, attempts: budget.attempts },
        'reconnect budget exhausted — escalating to non-recoverable',
      );
      ctx.markDisconnected(classification.reason);
      void publishEvent({
        type: 'session_disconnected',
        session_id: ctx.sessionId,
        reason: 'unknown',
        recoverable: false,
        error_message: `retry budget exhausted: ${classification.message}`,
      });
      return;
    }

    const delay = BACKOFF_SCHEDULE_MS[Math.min(budget.attempts, BACKOFF_SCHEDULE_MS.length - 1)];
    budget.attempts += 1;
    log.info(
      { session_id: ctx.sessionId, delay_ms: delay, attempt: budget.attempts },
      'reconnect-manager: scheduling retry',
    );

    ctx.markDisconnected(classification.reason);
    const timer = setTimeout(() => {
      this.scheduled.delete(ctx.sessionId);
      retry(ctx).catch((retryErr) => {
        log.warn(
          {
            session_id: ctx.sessionId,
            err: retryErr instanceof Error ? retryErr.message : String(retryErr),
          },
          'reconnect retry callback threw',
        );
      });
    }, delay);
    this.scheduled.set(ctx.sessionId, timer);
  }

  /** Reset budget on successful reconnect. */
  markRecovered(sessionId: string): void {
    this.clearBudget(sessionId);
    const t = this.scheduled.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.scheduled.delete(sessionId);
    }
  }

  /** Cancel any pending retries (e.g. on session delete). */
  cancel(sessionId: string): void {
    const t = this.scheduled.get(sessionId);
    if (t) clearTimeout(t);
    this.scheduled.delete(sessionId);
    this.budgets.delete(sessionId);
  }

  private getBudget(sessionId: string): RetryBudget {
    const existing = this.budgets.get(sessionId);
    const now = Date.now();
    if (!existing || now - existing.windowStart > WINDOW_MS) {
      const fresh: RetryBudget = { attempts: 0, windowStart: now };
      this.budgets.set(sessionId, fresh);
      return fresh;
    }
    return existing;
  }

  private clearBudget(sessionId: string): void {
    this.budgets.delete(sessionId);
  }
}

let instance: ReconnectManager | null = null;

export function getReconnectManager(): ReconnectManager {
  if (!instance) instance = new ReconnectManager();
  return instance;
}

export function resetReconnectManagerForTests(): void {
  instance = null;
}

export type { ReconnectManager };
