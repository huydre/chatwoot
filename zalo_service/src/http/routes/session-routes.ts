import { Router, type Request, type Response } from 'express';
import { childLogger } from '../../logger.js';
import { getSessionManager } from '../../sessions/session-manager.js';
import { SessionPersistenceClient } from '../../sessions/session-persistence-client.js';
import { getSyncStatus, startSync } from '../../zalo/zalo-sync-service.js';

/**
 * Session lifecycle endpoints.
 *
 * GET    /session/:id/health   → returns snapshot of a single session's state
 * DELETE /session/:id          → graceful teardown (used by Rails on inbox delete)
 *
 * Protected by the internal token middleware — only Rails can reach these.
 */

const log = childLogger({ component: 'session-routes' });
export const sessionRouter = Router();

sessionRouter.post('/:session_id/sync', async (req: Request, res: Response) => {
  const ctx = getSessionManager().get(req.params.session_id);
  if (!ctx) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  const includeGroupHistory = req.body?.include_group_history !== false;
  const result = await startSync(ctx, { includeGroupHistory });

  if (!result.started) {
    res.status(409).json({ error: result.reason ?? 'already_running' });
    return;
  }
  res.json({ status: 'started', session_id: ctx.sessionId });
});

sessionRouter.get('/:session_id/sync/status', (req: Request, res: Response) => {
  const ctx = getSessionManager().get(req.params.session_id);
  if (!ctx) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  res.json(getSyncStatus(ctx.sessionId));
});

sessionRouter.get('/:session_id/health', (req: Request, res: Response) => {
  const ctx = getSessionManager().get(req.params.session_id);
  if (!ctx) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  res.json({
    session_id: ctx.sessionId,
    state: ctx.state,
    own_id: ctx.ownId,
    last_connected_at: ctx.lastConnectedAt?.toISOString() ?? null,
    last_seen_at: ctx.lastSeenAt?.toISOString() ?? null,
  });
});

sessionRouter.delete('/:session_id', async (req: Request, res: Response) => {
  const manager = getSessionManager();
  const ctx = manager.get(req.params.session_id);
  if (!ctx) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  // Best-effort: stop the zca-js listener if we have one.
  try {
    const api = ctx.api as unknown as { listener?: { stop?: () => void } } | null;
    api?.listener?.stop?.();
  } catch (err) {
    log.warn(
      {
        session_id: ctx.sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'listener stop threw',
    );
  }

  manager.delete(ctx.sessionId);

  // Tell Rails so the DB row reflects reality.
  void new SessionPersistenceClient().patchSession(ctx.sessionId, {
    status: 'deleted',
  });

  res.status(204).end();
});
