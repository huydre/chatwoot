import { describe, expect, it } from 'vitest';
import { SessionContext } from '../src/sessions/session-context.js';

describe('SessionContext state machine', () => {
  it('starts in pending state', () => {
    const ctx = new SessionContext('sess-1');
    expect(ctx.state).toBe('pending');
    expect(ctx.ownId).toBeNull();
    expect(ctx.api).toBeNull();
  });

  it('markQrReady sets qr payload + expiry', () => {
    const ctx = new SessionContext('sess-1');
    ctx.markQrReady('iVBOR_base64_bytes', 30_000);
    expect(ctx.state).toBe('qr_ready');
    expect(ctx.qrBase64).toBe('iVBOR_base64_bytes');
    expect(ctx.qrExpiresAt).toBeInstanceOf(Date);
  });

  it('markReady clears qr payload and stores api handle', () => {
    const ctx = new SessionContext('sess-1');
    ctx.markQrReady('abc');
    const fakeApi = { sendMessage: () => {} };
    ctx.markReady(fakeApi, 'user_42');
    expect(ctx.state).toBe('ready');
    expect(ctx.ownId).toBe('user_42');
    expect(ctx.api).toBe(fakeApi);
    expect(ctx.qrBase64).toBeNull();
    expect(ctx.lastConnectedAt).toBeInstanceOf(Date);
  });

  it('markDisconnected clears api but keeps ownId', () => {
    const ctx = new SessionContext('sess-1');
    ctx.markReady({}, 'u1');
    ctx.markDisconnected('network');
    expect(ctx.state).toBe('disconnected');
    expect(ctx.api).toBeNull();
    expect(ctx.ownId).toBe('u1');
    expect(ctx.errorMessage).toBe('network');
  });

  it('isActive reflects terminal states', () => {
    const ctx = new SessionContext('sess-1');
    expect(ctx.isActive()).toBe(true);
    ctx.markExpired();
    expect(ctx.isActive()).toBe(false);
  });

  it('serialize produces JSON-friendly snapshot', () => {
    const ctx = new SessionContext('sess-1');
    ctx.markReady({}, 'u1');
    const snap = ctx.serialize();
    expect(snap.session_id).toBe('sess-1');
    expect(snap.state).toBe('ready');
    expect(snap.own_id).toBe('u1');
    expect(snap.last_connected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
