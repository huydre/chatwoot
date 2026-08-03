import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from '../config.js';
import { childLogger } from '../logger.js';

/**
 * Internal token auth middleware.
 *
 * Every protected route requires header `X-Zalo-Service-Token` to match
 * ZALO_SERVICE_INTERNAL_TOKEN. Uses constant-time comparison to prevent
 * timing attacks. Public routes (e.g. /healthz) opt out by being mounted
 * before this middleware.
 */

const log = childLogger({ component: 'auth-middleware' });
const HEADER = 'x-zalo-service-token';

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = req.headers[HEADER];
  if (typeof token !== 'string' || token.length === 0) {
    log.warn({ ip: req.ip, path: req.path }, 'auth: missing token');
    res.status(401).json({ error: 'missing internal token' });
    return;
  }

  const expected = loadConfig().ZALO_SERVICE_INTERNAL_TOKEN;
  if (!constantTimeEqual(token, expected)) {
    log.warn({ ip: req.ip, path: req.path }, 'auth: invalid token');
    res.status(401).json({ error: 'invalid internal token' });
    return;
  }

  next();
}
