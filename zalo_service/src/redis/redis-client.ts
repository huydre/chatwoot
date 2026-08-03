import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { childLogger } from '../logger.js';

/**
 * Redis connection manager.
 *
 * ioredis requires a dedicated connection for pub/sub since subscribing puts the
 * client into a mode where normal commands are rejected. We keep 2 singletons:
 *   - commandClient: regular ops (GET/SET/etc)
 *   - publisherClient: publish-only
 *
 * A subscriber client is not created here since zalo_service does not subscribe
 * to Redis itself — only Rails does (via ZaloEventSubscriber).
 */

const log = childLogger({ component: 'redis-client' });

let commandClient: Redis | null = null;
let publisherClient: Redis | null = null;

function buildClient(label: string): Redis {
  const cfg = loadConfig();
  const client = new Redis(cfg.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on('connect', () => log.info({ label }, 'redis connecting'));
  client.on('ready', () => log.info({ label }, 'redis ready'));
  client.on('error', (err) =>
    log.error({ label, err: err.message }, 'redis error'),
  );
  client.on('close', () => log.warn({ label }, 'redis connection closed'));
  client.on('reconnecting', (delay: number) =>
    log.info({ label, delay }, 'redis reconnecting'),
  );

  return client;
}

export function getCommandClient(): Redis {
  if (!commandClient) commandClient = buildClient('command');
  return commandClient;
}

export function getPublisherClient(): Redis {
  if (!publisherClient) publisherClient = buildClient('publisher');
  return publisherClient;
}

export async function closeRedisClients(): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];
  if (commandClient) tasks.push(commandClient.quit());
  if (publisherClient) tasks.push(publisherClient.quit());
  await Promise.allSettled(tasks);
  commandClient = null;
  publisherClient = null;
  log.info('redis clients closed');
}
