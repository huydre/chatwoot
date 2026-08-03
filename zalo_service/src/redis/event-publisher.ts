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
 * Appends validated events to the `zalo.events` Redis stream.
 *
 * The schema validation below guarantees Rails ZaloEventSubscriber can trust the
 * shape of every event and route it to the right Sidekiq job. Invalid events are
 * dropped with an error log (caller bug) and never published — we would rather
 * lose one bad message than corrupt downstream state.
 *
 * A stream rather than pub/sub, because pub/sub drops anything published while
 * no subscriber is attached (so a Rails listener restart silently loses every
 * message sent during it) and fans out to every subscriber (so N Rails pods
 * each enqueue the same job). A consumer group on a stream gives replay across
 * restarts and exactly one delivery per group. See red team finding C1.
 */

const STREAM = 'zalo.events';
// Bounds memory if Rails stops consuming; ~hours of traffic at expected rates.
const STREAM_MAXLEN = 10_000;
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
    const id = await client.xadd(
      STREAM,
      'MAXLEN',
      '~',
      STREAM_MAXLEN,
      '*',
      'payload',
      payload,
    );
    log.debug({ type: parsed.data.type, id }, 'event published');
  } catch (err) {
    // Intentionally swallow — event loss is acceptable; service crash is not.
    // Rails health monitor will reconcile stale sessions on next tick.
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'event-publisher: publish failed (event lost)',
    );
  }
}
