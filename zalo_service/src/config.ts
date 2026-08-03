import { z } from 'zod';

/**
 * Runtime configuration loaded from environment variables.
 * Validated via zod — fails fast on missing/invalid values at startup.
 */

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // HTTP server
  ZALO_SERVICE_HOST: z.string().default('127.0.0.1'),
  ZALO_SERVICE_PORT: z.coerce.number().int().positive().default(4567),

  // Shared secret with Rails
  ZALO_SERVICE_INTERNAL_TOKEN: z
    .string()
    .min(16, 'ZALO_SERVICE_INTERNAL_TOKEN must be at least 16 chars'),

  // Redis (share with Chatwoot)
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Rails internal callback URL
  CHATWOOT_INTERNAL_URL: z.string().url().default('http://127.0.0.1:3000'),

  // Limits
  ZALO_MAX_SESSIONS_PER_PROCESS: z.coerce.number().int().positive().default(50),
});

export type Config = z.infer<typeof envSchema>;

let cachedConfig: Config | null = null;

/**
 * Load and validate config from process.env.
 * Cached after first call so multiple imports share the same instance.
 * Throws a readable error if validation fails.
 */
export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid zalo_service configuration:\n${issues}\n\n` +
        `Set the missing env vars (see zalo_service/.env.example).`,
    );
  }

  cachedConfig = result.data;
  return cachedConfig;
}

/** Convenience accessor — safe to call anywhere after loadConfig() has succeeded once. */
export const config = new Proxy({} as Config, {
  get(_target, prop: string) {
    return loadConfig()[prop as keyof Config];
  },
});
