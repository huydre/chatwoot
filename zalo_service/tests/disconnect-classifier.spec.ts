import { describe, expect, it } from 'vitest';
import { classifyDisconnect } from '../src/reconnect/disconnect-classifier.js';

describe('classifyDisconnect', () => {
  it('classifies 401/403 as cookie_expired (non-recoverable)', () => {
    const r = classifyDisconnect(new Error('Request failed with status 401'));
    expect(r.reason).toBe('cookie_expired');
    expect(r.recoverable).toBe(false);
  });

  it('classifies "unauthorized" text as cookie_expired', () => {
    const r = classifyDisconnect(new Error('unauthorized session'));
    expect(r.reason).toBe('cookie_expired');
    expect(r.recoverable).toBe(false);
  });

  it('classifies "banned" as banned (non-recoverable)', () => {
    const r = classifyDisconnect(new Error('account has been banned'));
    expect(r.reason).toBe('banned');
    expect(r.recoverable).toBe(false);
  });

  it('classifies network errors as recoverable', () => {
    const r = classifyDisconnect(new Error('ECONNRESET socket hang up'));
    expect(r.reason).toBe('network');
    expect(r.recoverable).toBe(true);
  });

  it('classifies listener_closed as recoverable', () => {
    const r = classifyDisconnect(new Error('ws closed by peer'));
    expect(r.reason).toBe('listener_closed');
    expect(r.recoverable).toBe(true);
  });

  it('defaults unknown to NON-recoverable to prevent retry loops', () => {
    const r = classifyDisconnect(new Error('wat'));
    expect(r.reason).toBe('unknown');
    expect(r.recoverable).toBe(false);
  });

  it('handles non-Error inputs', () => {
    const r = classifyDisconnect('ETIMEDOUT bare string');
    expect(r.reason).toBe('network');
    expect(r.recoverable).toBe(true);
  });

  it('handles null input', () => {
    const r = classifyDisconnect(null);
    expect(r.reason).toBe('unknown');
    expect(r.recoverable).toBe(false);
  });

  it('reads from err.code field', () => {
    const r = classifyDisconnect({ code: 'ECONNRESET', message: 'network dropped' });
    expect(r.reason).toBe('network');
    expect(r.recoverable).toBe(true);
  });

  it('preserves original message field', () => {
    const r = classifyDisconnect(new Error('ECONNRESET details'));
    expect(r.message).toContain('ECONNRESET');
  });
});
