import { beforeAll, describe, expect, it, vi } from 'vitest';

const publishSpy = vi.fn(async () => 1);

vi.mock('../src/redis/redis-client.js', () => ({
  getPublisherClient: () => ({
    publish: publishSpy,
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

  it('publishes a valid session_ready event', async () => {
    const { publishEvent } = await import('../src/redis/event-publisher.js');
    await publishEvent({
      type: 'session_ready',
      session_id: '00000000-0000-4000-8000-000000000000',
      own_id: 'user_abc',
      display_name: 'Test User',
    });

    expect(publishSpy).toHaveBeenCalled();
    const lastCall = publishSpy.mock.calls[publishSpy.mock.calls.length - 1];
    expect(lastCall[0]).toBe('zalo.events');
    const payload = JSON.parse(lastCall[1] as string);
    expect(payload.type).toBe('session_ready');
    expect(payload.own_id).toBe('user_abc');
    expect(payload.timestamp).toBeDefined();
  });

  it('drops invalid events without publishing', async () => {
    publishSpy.mockClear();
    const { publishEvent } = await import('../src/redis/event-publisher.js');
    await publishEvent({
      // @ts-expect-error testing invalid shape
      type: 'session_ready',
      session_id: 'not-a-uuid',
      own_id: 'user_abc',
    });
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('does not crash when Redis publish throws', async () => {
    publishSpy.mockImplementationOnce(async () => {
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
