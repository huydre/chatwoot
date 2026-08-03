import { Router, type Request, type Response } from 'express';
import { getCommandClient } from '../../redis/redis-client.js';
import { getSessionManager } from '../../sessions/session-manager.js';

/**
 * Liveness + lightweight readiness endpoint.
 *
 * GET /healthz — always returns 200 with a snapshot of subsystem state.
 * Overmind/Docker/K8s probes can use the HTTP 200 for liveness; operators
 * read the JSON body for deeper state (redis, session count, heap).
 *
 * Heap is reported because zca-js holds websocket state, listeners and
 * response buffers per session, so a leak ends in OOM, a supervisor restart,
 * a re-restore of every session, and the same leak again — with nothing in
 * the logs to say why (red team H6). Exposing heap lets external monitoring
 * see the climb; capping the restart rate itself belongs to the supervisor,
 * which is documented in docs/integrations/zalo-personal.md.
 */

export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get('/', async (_req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

  let redisOk = false;
  try {
    const pong = await getCommandClient().ping();
    redisOk = pong === 'PONG';
  } catch {
    redisOk = false;
  }

  const { heapUsed, heapTotal, rss } = process.memoryUsage();

  res.json({
    ok: true,
    service: 'zalo_service',
    uptime_seconds: uptimeSeconds,
    redis_ok: redisOk,
    session_count: getSessionManager().size(),
    memory: {
      heap_used_mb: Math.round(heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(heapTotal / 1024 / 1024),
      rss_mb: Math.round(rss / 1024 / 1024),
    },
  });
});
