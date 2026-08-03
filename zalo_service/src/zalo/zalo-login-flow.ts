import type { API } from 'zca-js';

import { encryptForRails } from '../crypto/transport-cipher.js';
import { childLogger } from '../logger.js';
import { publishEvent } from '../redis/event-publisher.js';
import type { SessionContext } from '../sessions/session-context.js';
import type { SessionPersistenceClient } from '../sessions/session-persistence-client.js';

/**
 * QR login flow orchestrator.
 *
 * Wraps the real zca-js loginQR() call and translates its callback event
 * union into SessionContext state transitions + Redis events. The Rails side
 * polls `/login/status/:session_id` which reads straight off the context, so
 * every state change is observable in < 1.5s.
 *
 * Phase 01 verified the actual zca-js unknown surface via the library source:
 *   zalo.loginQR(
 *     { userAgent?, language?, qrPath? },
 *     (event: LoginQRCallbackEvent) => void
 *   ) => Promise<unknown>
 *
 * Event variants we react to:
 *   - QRCodeGenerated  → markQrReady + publish qr_code
 *   - QRCodeExpired    → markExpired + publish qr_expired
 *   - QRCodeScanned    → markScanning
 *   - QRCodeDeclined   → markFailed
 *   - GotLoginInfo     → handled AFTER loginQR() resolves (we need the api
 *                        handle too). The event carries { cookie, imei,
 *                        userAgent } which we persist to Rails.
 *
 * We treat zca-js as an injected dependency to keep the tests hermetic —
 * they can pass a fake Zalo constructor and drive the state machine without
 * hitting Zalo's servers.
 */

const log = childLogger({ component: 'zalo-login-flow' });

// Minimal shape of what we need from zca-js, so the test fake stays small.
// The *return* type is the library's real one: everything downstream calls
// methods on it, and typing it as unknown is what let those calls drift.
// A fake in a test can cast; production code must not.
export interface ZaloLike {
  loginQR(
    options: { userAgent?: string; language?: string; qrPath?: string } | undefined,
    callback: (event: unknown) => void,
  ): Promise<API>;
}

export interface ZaloFactory {
  create(): ZaloLike;
}

export interface LoginFlowDeps {
  zaloFactory: ZaloFactory;
  persistence: SessionPersistenceClient;
}

export interface StartLoginOptions {
  // Required: the session Rails persists is scoped to this account, and
  // without it the internal API used to fall back to Account.first (C2).
  accountId: number;
  existingChannelId?: number;
  userAgent?: string;
  language?: string;
}

// Mirror of zca-js LoginQRCallbackEventType enum (from loginQR.ts source).
const EVT_QR_GENERATED = 0;
const EVT_QR_EXPIRED = 1;
const EVT_QR_SCANNED = 2;
const EVT_QR_DECLINED = 3;
const EVT_GOT_LOGIN_INFO = 4;

interface ZcaLoginEvent {
  type: number;
  data: {
    image?: string;
    code?: string;
    display_name?: string;
    avatar?: string;
    cookie?: unknown;
    imei?: string;
    userAgent?: string;
  } | null;
}

interface CapturedCredentials {
  cookie: unknown;
  imei: string;
  userAgent: string;
}

export async function startLoginFlow(
  ctx: SessionContext,
  opts: StartLoginOptions,
  deps: LoginFlowDeps,
): Promise<void> {
  const zalo = deps.zaloFactory.create();
  // Holder object — avoids TS narrowing `captured` to `never` when the event
  // handler mutates it inside a closure the type checker can't see through.
  const credentialBox: { value: CapturedCredentials | null } = { value: null };

  const handleEvent = (event: unknown): void => {
    const typed = event as ZcaLoginEvent;
    try {
      switch (typed.type) {
        case EVT_QR_GENERATED: {
          const image = typed.data?.image;
          if (typeof image === 'string' && image.length > 0) {
            ctx.markQrReady(image);
            void publishEvent({
              type: 'qr_code',
              session_id: ctx.sessionId,
              qr_base64: image,
              expires_at:
                ctx.qrExpiresAt?.toISOString() ?? new Date().toISOString(),
            });
          }
          break;
        }
        case EVT_QR_EXPIRED: {
          ctx.markExpired('qr_expired');
          void publishEvent({ type: 'qr_expired', session_id: ctx.sessionId });
          break;
        }
        case EVT_QR_SCANNED: {
          ctx.markScanning(typed.data?.display_name ?? null);
          break;
        }
        case EVT_QR_DECLINED: {
          ctx.markFailed('qr_declined');
          break;
        }
        case EVT_GOT_LOGIN_INFO: {
          // We can't use the api yet — zalo.loginQR() hasn't returned.
          // Capture the credentials and persist them once the promise resolves.
          const cookie = typed.data?.cookie;
          const imei = typed.data?.imei;
          const userAgent = typed.data?.userAgent;
          if (cookie && typeof imei === 'string' && typeof userAgent === 'string') {
            credentialBox.value = { cookie, imei, userAgent };
            ctx.markConfirmed();
          }
          break;
        }
        default:
          log.debug({ type: typed.type }, 'unknown zca-js login event');
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'login event handler threw',
      );
    }
  };

  try {
    const api = await zalo.loginQR(
      { userAgent: opts.userAgent, language: opts.language ?? 'vi' },
      handleEvent,
    );

    const captured = credentialBox.value;
    if (!captured) {
      ctx.markFailed('login_completed_without_credentials');
      return;
    }

    // Zca-js surfaces the account uid via api.getOwnId() in this version,
    // but the exact method name is not stable across versions. We fall back
    // to stringifying whatever identity it exposes.
    const ownId = extractOwnId(api);

    ctx.markReady(api, ownId);

    // Persist to Rails. Ok to fail silently — Rails may not be ready yet.
    const saved = await deps.persistence.createSession({
      session_id: ctx.sessionId,
      own_id: ownId,
      display_name: ctx.displayName ?? undefined,
      cookies_encrypted: encryptForRails(JSON.stringify(captured.cookie)),
      imei: captured.imei,
      user_agent: captured.userAgent,
      account_id: opts.accountId,
      existing_channel_id: opts.existingChannelId,
    });

    // Rails returns the inbox_id on first create — surface it to the
    // context so the frontend polling endpoint can tell the Vue flow
    // where to redirect.
    if (saved?.inbox_id) {
      ctx.inboxId = saved.inbox_id;
    }

    void publishEvent({
      type: 'session_ready',
      session_id: ctx.sessionId,
      own_id: ownId,
      display_name: ctx.displayName ?? undefined,
    });

    if (!saved) {
      log.warn(
        { session_id: ctx.sessionId },
        'login succeeded but Rails persistence returned null — session lives in memory only until next sync',
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ session_id: ctx.sessionId, reason }, 'loginQR threw');
    ctx.markFailed(reason);
  }
}

function extractOwnId(api: API): string {
  const candidate = api as unknown as {
    getOwnId?: () => string;
    ctx?: { uid?: string };
    uid?: string;
  };
  if (typeof candidate.getOwnId === 'function') {
    try {
      const v = candidate.getOwnId();
      if (v) return v;
    } catch {
      /* fall through */
    }
  }
  if (candidate.ctx?.uid) return String(candidate.ctx.uid);
  if (candidate.uid) return String(candidate.uid);
  return 'unknown';
}
