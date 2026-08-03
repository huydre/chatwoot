import { childLogger } from '../logger.js';
import { getSessionManager } from '../sessions/session-manager.js';
import type { SessionContext } from '../sessions/session-context.js';
import { getReconnectManager } from './reconnect-manager.js';

/**
 * Periodic health probe for ready sessions.
 *
 * Every HEARTBEAT_INTERVAL_MS we walk the session registry and touch each
 * ready session. If a session has not been "seen" (via incoming messages,
 * explicit touches, or previous probes) within STALENESS_THRESHOLD_MS, we
 * treat it as potentially dead and route it through the reconnect manager.
 *
 * Red team H4 note: we deliberately keep the interval randomised per tick to
 * avoid producing a predictable polling fingerprint that Zalo's anti-bot
 * heuristics could flag. We also prefer passive detection (message traffic
 * updating last_seen_at) over active HTTP probes.
 */

const log = childLogger({ component: 'heartbeat-service' });

const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_JITTER_MS = 15_000;
const STALENESS_THRESHOLD_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startHeartbeat(): void {
  if (timer) return;
  scheduleNext();
  log.info('heartbeat-service: started');
}

export function stopHeartbeat(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    log.info('heartbeat-service: stopped');
  }
}

function scheduleNext(): void {
  const jitter = Math.floor(Math.random() * HEARTBEAT_JITTER_MS);
  timer = setTimeout(() => {
    tick().finally(() => scheduleNext());
  }, HEARTBEAT_INTERVAL_MS + jitter);
}

async function tick(): Promise<void> {
  const sessions = getSessionManager().getAll();
  const now = Date.now();

  for (const ctx of sessions) {
    if (ctx.state !== 'ready') continue;

    const lastSeen = ctx.lastSeenAt?.getTime() ?? 0;
    if (now - lastSeen < STALENESS_THRESHOLD_MS) continue;

    log.warn(
      { session_id: ctx.sessionId, stale_ms: now - lastSeen },
      'heartbeat-service: session stale — probing',
    );
    await probeSession(ctx);
  }
}

async function probeSession(ctx: SessionContext): Promise<void> {
  // Passive probe: read whatever lightweight getter zca-js exposes on the
  // api handle. If it throws or returns null, treat as disconnected.
  try {
    const api = ctx.api as unknown as {
      getContext?: () => unknown;
      uid?: string;
    } | null;
    if (!api) throw new Error('api handle missing');

    if (typeof api.getContext === 'function') {
      const result = api.getContext();
      if (result == null) throw new Error('getContext returned null');
    }

    ctx.touchSeen();
  } catch (err) {
    log.warn(
      {
        session_id: ctx.sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'heartbeat probe failed',
    );
    // Route through the reconnect manager so the classifier + backoff
    // logic applies consistently.
    getReconnectManager().handleDisconnect(ctx, err, async () => {
      // Actual reconnect implementation will be wired from session-manager
      // in a later commit — for now we just mark disconnected and let
      // Rails surface the re-login prompt.
      log.warn(
        { session_id: ctx.sessionId },
        'heartbeat triggered reconnect but no reconnect fn wired',
      );
    });
  }
}
