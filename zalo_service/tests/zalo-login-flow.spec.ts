import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../src/sessions/session-context.js';
import { startLoginFlow, type ZaloFactory, type ZaloLike } from '../src/zalo/zalo-login-flow.js';

vi.mock('../src/redis/event-publisher.js', () => ({
  publishEvent: vi.fn(async () => {}),
}));

describe('startLoginFlow', () => {
  beforeAll(() => {
    process.env.ZALO_SERVICE_INTERNAL_TOKEN = 'a'.repeat(32);
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'fatal';
  });

  /**
   * Build a fake zca-js Zalo that drives the callback through all login
   * events then resolves with a minimal api handle. This lets us assert the
   * state machine transitions without hitting Zalo servers.
   */
  const buildFakeZaloFactory = (): ZaloFactory => ({
    create(): ZaloLike {
      return {
        async loginQR(_opts, callback) {
          // Generated
          callback({
            type: 0,
            data: { image: 'qr_base64_abc', code: '...', options: {}, token: 't' },
          });
          // Scanned
          callback({
            type: 2,
            data: { avatar: 'a', display_name: 'Alice' },
          });
          // Got login info
          callback({
            type: 4,
            data: {
              cookie: [{ name: 'c', value: 'v', domain: 'zalo.me' }],
              imei: 'imei-abc',
              userAgent: 'ua-abc',
            },
          });
          return { ctx: { uid: 'user-42' } };
        },
      };
    },
  });

  const buildFakePersistence = () => ({
    createSession: vi.fn(async () => ({
      session_id: 'sess-1',
      channel_zalo_id: 1,
      account_id: 1,
      zalo_own_id: 'user-42',
      cookies: '[]',
      imei: 'imei-abc',
      user_agent: 'ua-abc',
      proxy_url: null,
      status: 'ready',
      last_seen_at: null,
    })),
    patchSession: vi.fn(async () => true),
    deleteSession: vi.fn(async () => true),
    listActive: vi.fn(async () => []),
  });

  it('walks the full happy path and lands on ready', async () => {
    const ctx = new SessionContext('sess-1');
    const persistence = buildFakePersistence();

    await startLoginFlow(
      ctx,
      { accountId: 1 },
      {
        zaloFactory: buildFakeZaloFactory(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        persistence: persistence as any,
      },
    );

    expect(ctx.state).toBe('ready');
    expect(ctx.ownId).toBe('user-42');
    expect(ctx.displayName).toBe('Alice');
    expect(persistence.createSession).toHaveBeenCalledOnce();
  });

  it('marks failed when zca-js throws', async () => {
    const ctx = new SessionContext('sess-1');
    const factory: ZaloFactory = {
      create(): ZaloLike {
        return {
          async loginQR() {
            throw new Error('network down');
          },
        };
      },
    };
    await startLoginFlow(
      ctx,
      {},
      {
        zaloFactory: factory,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        persistence: buildFakePersistence() as any,
      },
    );
    expect(ctx.state).toBe('failed');
    expect(ctx.errorMessage).toContain('network down');
  });

  it('marks failed when loginQR returns without GotLoginInfo', async () => {
    const ctx = new SessionContext('sess-1');
    const factory: ZaloFactory = {
      create(): ZaloLike {
        return {
          async loginQR(_opts, cb) {
            cb({ type: 0, data: { image: 'abc', code: 'c', options: {}, token: 't' } });
            return {};
          },
        };
      },
    };
    await startLoginFlow(
      ctx,
      {},
      {
        zaloFactory: factory,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        persistence: buildFakePersistence() as any,
      },
    );
    expect(ctx.state).toBe('failed');
    expect(ctx.errorMessage).toBe('login_completed_without_credentials');
  });
});
