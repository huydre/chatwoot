import { beforeAll, describe, expect, it, vi } from 'vitest';

const xaddSpy = vi.fn(async () => '1700000000000-0');

vi.mock('../src/redis/redis-client.js', () => ({
  getPublisherClient: () => ({
    xadd: xaddSpy,
  }),
  getCommandClient: () => ({ ping: async () => 'PONG' }),
  closeRedisClients: async () => {},
}));

describe('event publisher', () => {
  beforeAll(() => {
    process.env.ZALO_SERVICE_INTERNAL_TOKEN = 'a'.repeat(32);
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'fatal';
  });

  it('appends a valid session_ready event to the stream', async () => {
    const { publishEvent } = await import('../src/redis/event-publisher.js');
    await publishEvent({
      type: 'session_ready',
      session_id: '00000000-0000-4000-8000-000000000000',
      own_id: 'user_abc',
      display_name: 'Test User',
    });

    expect(xaddSpy).toHaveBeenCalled();
    const args = xaddSpy.mock.calls[xaddSpy.mock.calls.length - 1] as unknown[];
    // xadd(stream, 'MAXLEN', '~', maxlen, '*', 'payload', json)
    expect(args[0]).toBe('zalo.events');
    expect(args[1]).toBe('MAXLEN');
    expect(args[4]).toBe('*');
    expect(args[5]).toBe('payload');
    const payload = JSON.parse(args[6] as string);
    expect(payload.type).toBe('session_ready');
    expect(payload.own_id).toBe('user_abc');
    expect(payload.timestamp).toBeDefined();
  });

  it('drops invalid events without publishing', async () => {
    xaddSpy.mockClear();
    const { publishEvent } = await import('../src/redis/event-publisher.js');
    await publishEvent({
      // @ts-expect-error testing invalid shape
      type: 'session_ready',
      session_id: 'not-a-uuid',
      own_id: 'user_abc',
    });
    expect(xaddSpy).not.toHaveBeenCalled();
  });

  it('does not crash when Redis publish throws', async () => {
    xaddSpy.mockImplementationOnce(async () => {
      throw new Error('redis down');
    });
    const { publishEvent } = await import('../src/redis/event-publisher.js');
    await expect(
      publishEvent({
        type: 'qr_expired',
        session_id: '00000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toBeUndefined();
  });
});
