import { childLogger } from '../logger.js';
import { publishEvent } from '../redis/event-publisher.js';
import { reloginWithCredentials } from '../zalo/zalo-client-factory.js';
import { attachMessageListener } from '../zalo/zalo-message-listener.js';
import { getSessionManager } from './session-manager.js';
// Keep sync trigger lazy to avoid a circular import between
// session-bootstrap → zalo-sync-service → session-context.
let startSyncFn: ((ctx: unknown, opts: { includeGroupHistory?: boolean }) => Promise<unknown>) | null = null;
async function lazyStartSync(ctx: unknown): Promise<void> {
  if (!startSyncFn) {
    const mod = await import('../zalo/zalo-sync-service.js');
    startSyncFn = mod.startSync as never;
  }
  await startSyncFn!(ctx, { includeGroupHistory: false });
}
import {
  SessionPersistenceClient,
  type RailsSessionRow,
} from './session-persistence-client.js';

/**
 * Startup session restore.
 *
 * On every zalo_service boot we ask Rails for the list of currently-active
 * sessions and re-authenticate each one with its stored cookies so message
 * listeners come back online without requiring the user to scan a new QR.
 *
 * Failure modes handled:
 *   - Rails unreachable / 404: persistence client returns `[]`, we log and
 *     continue with zero sessions (the service will still accept new logins).
 *   - Individual session re-auth fails (cookie expired / banned): mark the
 *     session disconnected via publishEvent so Rails flags the channel, but
 *     keep processing the remaining rows.
 *
 * A small concurrency cap prevents thundering-herd calls to Zalo when a
 * process with many sessions starts up.
 */

const log = childLogger({ component: 'session-bootstrap' });
const RESTORE_CONCURRENCY = 5;

export async function restoreSessionsFromRails(
  persistence: SessionPersistenceClient = new SessionPersistenceClient(),
): Promise<{ restored: number; failed: number }> {
  log.info('session-bootstrap: fetching active sessions from Rails');

  const rows = await persistence.listActive();
  if (rows.length === 0) {
    log.info('session-bootstrap: no sessions to restore');
    return { restored: 0, failed: 0 };
  }

  log.info({ count: rows.length }, 'session-bootstrap: starting restore');

  let restored = 0;
  let failed = 0;

  // Process in chunks of RESTORE_CONCURRENCY so we don't hammer Zalo.
  for (let i = 0; i < rows.length; i += RESTORE_CONCURRENCY) {
    const chunk = rows.slice(i, i + RESTORE_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((row) => restoreSingle(row, persistence)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') restored++;
      else failed++;
    }
  }

  log.info({ restored, failed }, 'session-bootstrap: done');
  return { restored, failed };
}

async function restoreSingle(
  row: RailsSessionRow,
  persistence: SessionPersistenceClient,
): Promise<void> {
  const manager = getSessionManager();
  const sessionId = row.session_id;
  log.debug({ session_id: sessionId }, 'restoring session');

  try {
    const cookies = JSON.parse(row.cookies) as unknown;
    const api = await reloginWithCredentials({
      cookie: cookies,
      imei: row.imei,
      userAgent: row.user_agent,
    });

    const ctx = manager.create(sessionId);
    // Cast is safe here — reloginWithCredentials returns zca-js API instance.
    ctx.markReady(api as never, row.zalo_own_id ?? 'unknown');
    attachMessageListener(ctx);

    void publishEvent({
      type: 'session_ready',
      session_id: sessionId,
      own_id: row.zalo_own_id ?? 'unknown',
    });

    // Auto-sync threads on restore (without group history — groups
    // already have their recent messages persisted from last run, and
    // pulling them again just spams Zalo's rate limit).
    void lazyStartSync(ctx).catch(() => {
      /* already logged */
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ session_id: sessionId, reason }, 'session restore failed');

    void persistence.patchSession(sessionId, { status: 'disconnected' });
    void publishEvent({
      type: 'session_disconnected',
      session_id: sessionId,
      reason: classifyRestoreError(reason),
      recoverable: false,
      error_message: reason,
    });

    throw err;
  }
}

function classifyRestoreError(
  message: string,
):
  | 'cookie_expired'
  | 'banned'
  | 'network'
  | 'unknown' {
  const lower = message.toLowerCase();
  if (/401|403|unauthorized|invalid.*cookie|thất bại/.test(lower))
    return 'cookie_expired';
  if (/banned|suspended|blocked/.test(lower)) return 'banned';
  if (/econnreset|etimedout|network|socket/.test(lower)) return 'network';
  return 'unknown';
}
