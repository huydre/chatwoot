import { childLogger } from '../logger.js';
import { getReconnectManager } from '../reconnect/reconnect-manager.js';
import { publishEvent } from '../redis/event-publisher.js';
import type { SessionContext } from '../sessions/session-context.js';

/**
 * Wires zca-js `api.listener` events onto the Redis pub/sub channel that Rails
 * ZaloEventSubscriber consumes.
 *
 * Responsibilities:
 *   1. Subscribe to `message` events from zca-js
 *   2. Forward the raw message payload to Rails verbatim — all semantic
 *      parsing (contact resolution, attachment download, dedup) lives in the
 *      Rails Zalo::IncomingMessageService where Chatwoot conventions apply
 *   3. On listener close/error, mark the context disconnected so the
 *      reconnect manager (Phase 06) can react
 *
 * Self messages are forwarded too. This used to drop them, to avoid looping
 * on the echo of a reply sent from Chatwoot — but Zalo emits the same event
 * for anything the user types in the Zalo app, so dropping them here meant
 * the agent's own half of every conversation never existed as far as
 * Chatwoot was concerned. Rails dedupes the echo by source_id instead, which
 * distinguishes the two; this layer cannot.
 *
 * Phase 02 intentionally does not wire the full reconnect loop yet; that
 * arrives in phase-06-logout-detection-reconnect. Here we just surface the
 * disconnect signal so the rest of the system knows something went wrong.
 */

const log = childLogger({ component: 'zalo-message-listener' });

interface ZcaListener {
  on(event: 'message', cb: (msg: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  start(): void;
  stop?(): void;
}

interface ZcaApiWithListener {
  listener: ZcaListener;
}

export function attachMessageListener(ctx: SessionContext): void {
  const api = ctx.api as unknown as ZcaApiWithListener | null;
  if (!api || !api.listener) {
    log.warn({ session_id: ctx.sessionId }, 'no listener on api — skipping');
    return;
  }

  api.listener.on('message', (rawMessage) => {
    try {
      const msg = rawMessage as Record<string, unknown>;

      ctx.touchSeen();

      void publishEvent({
        type: 'message',
        session_id: ctx.sessionId,
        payload: msg,
      });
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          session_id: ctx.sessionId,
        },
        'message handler threw',
      );
    }
  });

  api.listener.on('error', (err) => {
    log.warn(
      {
        session_id: ctx.sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'listener error — routing through reconnect manager',
    );
    getReconnectManager().handleDisconnect(ctx, err, async () => {
      // Reconnect implementation will call back into session-manager
      // restoreSingle() which re-auths with stored cookies. Wired up as a
      // late-binding callback to avoid a circular import with session-
      // bootstrap.
      log.warn({ session_id: ctx.sessionId }, 'listener reconnect callback unset');
    });
  });

  api.listener.on('close', () => {
    log.warn({ session_id: ctx.sessionId }, 'listener closed');
    getReconnectManager().handleDisconnect(
      ctx,
      new Error('listener_closed'),
      async () => {
        log.warn(
          { session_id: ctx.sessionId },
          'close reconnect callback unset',
        );
      },
    );
  });

  try {
    api.listener.start();
    log.info({ session_id: ctx.sessionId }, 'listener started');
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        session_id: ctx.sessionId,
      },
      'listener.start() threw',
    );
    ctx.markFailed('listener_start_failed');
  }
}
