import express, {
  type Application,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { childLogger } from '../logger.js';
import { authMiddleware } from './auth-middleware.js';
import { healthRouter } from './routes/health-routes.js';
import { loginRouter } from './routes/login-routes.js';
import { sessionRouter } from './routes/session-routes.js';

/**
 * Express application factory.
 *
 * Route layout:
 *   /healthz       → public, no auth (for liveness probes)
 *   /login/*       → protected (Phase 02)
 *   /send          → protected (Phase 02)
 *   /session/*     → protected (Phase 02)
 *
 * Middlewares are kept minimal (KISS): json parser, request-id, auth on
 * protected routes, and a single structured error handler at the end.
 */

const log = childLogger({ component: 'http-server' });

function requestIdMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const headerValue = req.headers['x-request-id'];
  const id =
    typeof headerValue === 'string' && headerValue.length > 0
      ? headerValue
      : `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  (req as Request & { requestId: string }).requestId = id;
  next();
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  log.error(
    {
      err: err instanceof Error ? err.message : String(err),
      path: req.path,
      method: req.method,
    },
    'http-server: unhandled error',
  );
  res.status(500).json({ error: 'internal_server_error' });
};

export function createApp(): Application {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use(requestIdMiddleware);

  // Public routes first (no auth)
  app.use('/healthz', healthRouter);

  // Everything below requires the internal token
  app.use(authMiddleware);

  // Phase 02: login + session lifecycle routes
  app.use('/login', loginRouter);
  app.use('/session', sessionRouter);

  // /send arrives in Phase 04 (Rails → Node outbound). Stub for now.
  app.all('/send', (_req, res) => {
    res.status(501).json({ error: 'not_implemented_phase_02' });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);

  return app;
}
