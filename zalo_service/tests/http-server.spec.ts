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

  // /send used to answer 501 not_implemented_phase_02 for everything. Getting
  // past auth into request validation is what proves it is wired up now.
  it('passes auth with correct token and validates the send body', async () => {
    const { createApp } = await import('../src/http/server.js');
    const app = createApp();
    const res = await request(app)
      .post('/send')
      .set('X-Zalo-Service-Token', TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('returns 404 from /send when the session is unknown', async () => {
    const { createApp } = await import('../src/http/server.js');
    const app = createApp();
    const res = await request(app)
      .post('/send')
      .set('X-Zalo-Service-Token', TOKEN)
      .send({ session_id: 'nope', thread_id: '123', content: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('session_not_found');
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
