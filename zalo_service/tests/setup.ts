/**
 * Vitest global setup.
 *
 * Runs before ANY test module is loaded. We set the env vars here so
 * top-level module side-effects (e.g. `childLogger({...})` at file scope)
 * can safely call loadConfig() without throwing.
 */

process.env.ZALO_SERVICE_INTERNAL_TOKEN ??= 'a'.repeat(32);
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'fatal';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.CHATWOOT_INTERNAL_URL ??= 'http://127.0.0.1:3000';
