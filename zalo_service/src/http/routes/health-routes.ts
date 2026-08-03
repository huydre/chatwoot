import { Router, type Request, type Response } from 'express';
import { getCommandClient } from '../../redis/redis-client.js';
import { getSessionManager } from '../../sessions/session-manager.js';

/**
 * Liveness + lightweight readiness endpoint.
 *
 * GET /healthz — always returns 200 with a snapshot of subsystem state.
 * Overmind/Docker/K8s probes can use the HTTP 200 for liveness; operators
 * read the JSON body for deeper state (redis, session count).
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

  res.json({
    ok: true,
    service: 'zalo_service',
    uptime_seconds: uptimeSeconds,
    redis_ok: redisOk,
    session_count: getSessionManager().size(),
  });
});
