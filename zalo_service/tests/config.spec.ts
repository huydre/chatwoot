import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('config loader', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Wipe all zalo-relevant env between tests
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith('ZALO_') ||
        key === 'REDIS_URL' ||
        key === 'CHATWOOT_INTERNAL_URL' ||
        key === 'NODE_ENV' ||
        key === 'LOG_LEVEL'
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('throws when ZALO_SERVICE_INTERNAL_TOKEN is missing', async () => {
    const { loadConfig } = await import('../src/config.js?missing');
    expect(() => loadConfig()).toThrow(/ZALO_SERVICE_INTERNAL_TOKEN/);
  });

  it('throws when token is too short', async () => {
    process.env.ZALO_SERVICE_INTERNAL_TOKEN = 'short';
    const { loadConfig } = await import('../src/config.js?short');
    expect(() => loadConfig()).toThrow(/at least 16/);
  });

  it('loads defaults when minimum env provided', async () => {
    process.env.ZALO_SERVICE_INTERNAL_TOKEN = 'a'.repeat(32);
    const { loadConfig } = await import('../src/config.js?ok');
    const cfg = loadConfig();
    expect(cfg.ZALO_SERVICE_PORT).toBe(4567);
    expect(cfg.ZALO_SERVICE_HOST).toBe('127.0.0.1');
    expect(cfg.NODE_ENV).toBe('development'); // default when NODE_ENV unset
    expect(cfg.REDIS_URL).toMatch(/^redis:\/\//);
  });
});
