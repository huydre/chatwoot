import { childLogger } from '../logger.js';
import { zaloEventSchema, type ZaloEvent } from '../schemas/event-schemas.js';
import { getPublisherClient } from './redis-client.js';

/** Distributive Omit — preserves discriminated union when removing a key. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

export type ZaloEventInput = DistributiveOmit<ZaloEvent, 'timestamp'> & {
  timestamp?: string;
};

/**
 * Publishes validated events to the `zalo.events` Redis channel.
 *
 * The schema validation below guarantees Rails ZaloEventSubscriber can trust the
 * shape of every event and route it to the right Sidekiq job. Invalid events are
 * dropped with an error log (caller bug) and never published — we would rather
 * lose one bad message than corrupt downstream state.
 */

const CHANNEL = 'zalo.events';
const log = childLogger({ component: 'event-publisher' });

export async function publishEvent(event: ZaloEventInput): Promise<void> {
  const withTimestamp = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };

  const parsed = zaloEventSchema.safeParse(withTimestamp);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues, type: withTimestamp.type },
      'event-publisher: refusing to publish invalid event',
    );
    return;
  }

  try {
    const client = getPublisherClient();
    const payload = JSON.stringify(parsed.data);
    const delivered = await client.publish(CHANNEL, payload);
    log.debug(
      { type: parsed.data.type, subscribers: delivered },
      'event published',
    );
  } catch (err) {
    // Intentionally swallow — event loss is acceptable; service crash is not.
    // Rails health monitor will reconcile stale sessions on next tick.
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'event-publisher: publish failed (event lost)',
    );
  }
}
