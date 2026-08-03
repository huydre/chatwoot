import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionPersistenceClient } from '../src/sessions/session-persistence-client.js';

describe('SessionPersistenceClient', () => {
  beforeAll(() => {
    process.env.ZALO_SERVICE_INTERNAL_TOKEN = 'a'.repeat(32);
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'fatal';
  });

  // null, not [] — an unreachable Rails must not look like "nothing to restore".
  it('listActive returns null on 404', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 404 }),
    ) as unknown as typeof fetch;
    const client = new SessionPersistenceClient({ fetchImpl: fetchMock });
    const result = await client.listActive();
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('listActive returns rows on 200', async () => {
    const rows = [
      {
        session_id: 's1',
        channel_zalo_id: 1,
        account_id: 1,
        zalo_own_id: 'u1',
        cookies: '[]',
        imei: 'imei',
        user_agent: 'ua',
        proxy_url: null,
        status: 'ready',
        last_seen_at: null,
      },
    ];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(rows), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new SessionPersistenceClient({ fetchImpl: fetchMock });
    const result = await client.listActive();
    expect(result).toEqual(rows);
  });

  it('listActive returns null on network error after retries', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new SessionPersistenceClient({ fetchImpl: fetchMock });
    const result = await client.listActive();
    expect(result).toBeNull();
    // 3 attempts (initial + 2 retries)
    expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3);
  }, 15_000);

  it('createSession POSTs with internal token', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          session_id: 's1',
          channel_zalo_id: 1,
          account_id: 1,
          zalo_own_id: 'u1',
          cookies: '[]',
          imei: 'i',
          user_agent: 'ua',
          proxy_url: null,
          status: 'ready',
          last_seen_at: null,
        }),
        { status: 201 },
      ),
    ) as unknown as typeof fetch;
    const client = new SessionPersistenceClient({ fetchImpl: fetchMock });
    const saved = await client.createSession({
      session_id: 's1',
      own_id: 'u1',
      cookies: '[]',
      imei: 'i',
      user_agent: 'ua',
    });
    expect(saved?.session_id).toBe('s1');
    const [, opts] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect((opts.headers as Record<string, string>)['X-Zalo-Service-Token']).toBe(
      'a'.repeat(32),
    );
  });

  it('patchSession returns false on 404 without throwing', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 404 }),
    ) as unknown as typeof fetch;
    const client = new SessionPersistenceClient({ fetchImpl: fetchMock });
    const ok = await client.patchSession('missing', { status: 'deleted' });
    expect(ok).toBe(false);
  });
});
