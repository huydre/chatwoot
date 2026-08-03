import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { childLogger } from '../../logger.js';
import { getSessionManager } from '../../sessions/session-manager.js';
import { SessionPersistenceClient } from '../../sessions/session-persistence-client.js';
import { DefaultZaloFactory } from '../../zalo/zalo-client-factory.js';
import { startLoginFlow } from '../../zalo/zalo-login-flow.js';
import { attachMessageListener } from '../../zalo/zalo-message-listener.js';
import { startSync } from '../../zalo/zalo-sync-service.js';

/**
 * Login flow endpoints — called by Rails Zalo::QrLoginService from the
 * dashboard when a user clicks "Add Zalo Inbox".
 *
 * POST /login/start          → kick off a QR login, return { session_id }
 * GET  /login/status/:id     → poll current state (used by Vue component)
 *
 * The login flow runs in the background so the HTTP request returns fast.
 * Rails polls /login/status/:id every ~1.5s and drives the UI state machine.
 */

const log = childLogger({ component: 'login-routes' });
export const loginRouter = Router();

const startLoginSchema = z.object({
  account_id: z.number().int().positive(),
  existing_channel_id: z.number().int().positive().optional(),
  user_agent: z.string().optional(),
  language: z.string().optional(),
});

loginRouter.post('/start', async (req: Request, res: Response) => {
  const parsed = startLoginSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
    return;
  }

  let ctx;
  try {
    ctx = getSessionManager().create();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ reason }, 'failed to create session');
    res.status(503).json({ error: 'capacity_exceeded', detail: reason });
    return;
  }

  // Kick off login in the background. We deliberately do NOT await so the
  // HTTP call returns in milliseconds — Rails will poll /login/status/:id.
  const deps = {
    zaloFactory: new DefaultZaloFactory(),
    persistence: new SessionPersistenceClient(),
  };
  void startLoginFlow(
    ctx,
    {
      accountId: parsed.data.account_id,
      existingChannelId: parsed.data.existing_channel_id,
      userAgent: parsed.data.user_agent,
      language: parsed.data.language,
    },
    deps,
  ).then(() => {
    if (ctx.state !== 'ready' || !ctx.api) return;

    // Attach message listener so tin nhắn mới chảy vào Redis ngay.
    attachMessageListener(ctx);

    // Auto-trigger sync on fresh login so the dashboard sidebar
    // populates with the user's existing threads immediately instead
    // of waiting for someone to message them first. Fire-and-forget —
    // errors are logged inside the sync service.
    void startSync(ctx, { includeGroupHistory: true }).catch(() => {
      /* already logged */
    });
  });

  res.json({
    session_id: ctx.sessionId,
    status: ctx.state,
  });
});

loginRouter.get('/status/:session_id', (req: Request, res: Response) => {
  const ctx = getSessionManager().get(req.params.session_id);
  if (!ctx) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  res.json(ctx.serialize());
});
