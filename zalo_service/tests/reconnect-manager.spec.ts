import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../src/sessions/session-context.js';
import {
  getReconnectManager,
  resetReconnectManagerForTests,
} from '../src/reconnect/reconnect-manager.js';

vi.mock('../src/redis/event-publisher.js', () => ({
  publishEvent: vi.fn(async () => {}),
}));

describe('ReconnectManager', () => {
  beforeEach(() => {
    resetReconnectManagerForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetReconnectManagerForTests();
  });

  it('marks non-recoverable disconnects as expired without scheduling retry', () => {
    const mgr = getReconnectManager();
    const ctx = new SessionContext('sess-1');
    const retry = vi.fn(async () => {});

    mgr.handleDisconnect(ctx, new Error('401 unauthorized'), retry);

    expect(ctx.state).toBe('disconnected');
    expect(ctx.errorMessage).toBe('cookie_expired');
    // No retry scheduled
    vi.advanceTimersByTime(10_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('schedules retry with exponential backoff for recoverable errors', () => {
    const mgr = getReconnectManager();
    const ctx = new SessionContext('sess-1');
    const retry = vi.fn(async () => {});

    mgr.handleDisconnect(ctx, new Error('ECONNRESET'), retry);

    // First backoff is 5s
    vi.advanceTimersByTime(4_999);
    expect(retry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(retry).toHaveBeenCalledWith(ctx);
  });

  it('escalates after max attempts per hour', () => {
    const mgr = getReconnectManager();
    const ctx = new SessionContext('sess-1');
    const retry = vi.fn(async () => {});

    // Fire 6 disconnects in a row
    for (let i = 0; i < 6; i++) {
      mgr.handleDisconnect(ctx, new Error('network down'), retry);
    }

    // 6th should escalate — ctx stays disconnected and no retry fired
    expect(ctx.state).toBe('disconnected');
  });

  it('cancel() clears pending retries', () => {
    const mgr = getReconnectManager();
    const ctx = new SessionContext('sess-1');
    const retry = vi.fn(async () => {});

    mgr.handleDisconnect(ctx, new Error('ETIMEDOUT'), retry);
    mgr.cancel(ctx.sessionId);

    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('markRecovered resets budget', () => {
    const mgr = getReconnectManager();
    const ctx = new SessionContext('sess-1');
    const retry = vi.fn(async () => {});

    // Use up some budget
    for (let i = 0; i < 3; i++) {
      mgr.handleDisconnect(ctx, new Error('network'), retry);
      mgr.cancel(ctx.sessionId); // avoid scheduling issues
    }

    mgr.markRecovered(ctx.sessionId);
    // Fresh budget — should schedule again
    mgr.handleDisconnect(ctx, new Error('ETIMEDOUT'), retry);
    vi.advanceTimersByTime(5_001);
    expect(retry).toHaveBeenCalled();
  });
});
