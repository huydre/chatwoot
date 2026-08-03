import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Stub Redis client so tests never touch a real Redis instance.
vi.mock('../src/redis/redis-client.js', () => ({
  getCommandClient: () => ({
    ping: async () => 'PONG',
  }),
  getPublisherClient: () => ({
    publish: async () => 1,
  }),
  closeRedisClients: async () => {},
}));

describe('http server', () => {
  const TOKEN = 'a'.repeat(32);

  beforeAll(() => {
    process.env.ZALO_SERVICE_INTERNAL_TOKEN = TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'fatal';
  });

  it('GET /healthz returns ok without auth', async () => {
    const { createApp } = await import('../src/http/server.js');
    const app = createApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('zalo_service');
    expect(res.body.redis_ok).toBe(true);
  });

  it('rejects protected routes without token', async () => {
    const { createApp } = await import('../src/http/server.js');
    const app = createApp();
    const res = await request(app).post('/send').send({});
    expect(res.status).toBe(401);
  });

  it('rejects protected routes with wrong token', async () => {
    const { createApp } = await import('../src/http/server.js');
    const app = createApp();
    const res = await request(app)
      .post('/send')
      .set('X-Zalo-Service-Token', 'wrong_token_value_123456')
      .send({});
    expect(res.status).toBe(401);
  });

  it('passes auth with correct token (send stub still 501 in phase 02)', async () => {
    const { createApp } = await import('../src/http/server.js');
    const app = createApp();
    const res = await request(app)
      .post('/send')
      .set('X-Zalo-Service-Token', TOKEN)
      .send({});
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented_phase_02');
  });

  it('returns 404 for unknown routes', async () => {
    const { createApp } = await import('../src/http/server.js');
    const app = createApp();
    const res = await request(app)
      .get('/does-not-exist')
      .set('X-Zalo-Service-Token', TOKEN);
    expect(res.status).toBe(404);
  });
});
