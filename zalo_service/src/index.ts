import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { createApp } from './http/server.js';
import { closeRedisClients, getCommandClient } from './redis/redis-client.js';
import { restoreSessionsFromRails } from './sessions/session-bootstrap.js';
import { startHeartbeat, stopHeartbeat } from './reconnect/heartbeat-service.js';

/**
 * Entry point for the Zalo Node sidecar service.
 *
 * Lifecycle:
 *   1. Load + validate config (throws on missing env)
 *   2. Warm up Redis connection
 *   3. Start HTTP server bound to ZALO_SERVICE_HOST / ZALO_SERVICE_PORT
 *   4. Install SIGTERM/SIGINT handlers for graceful shutdown
 *
 * Phase 01 scope: foundation only. No sessions, no zca-js wiring yet.
 * Later phases mount the session manager, login flow, and message listener.
 */

const log = getLogger();

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info(
    {
      node_env: cfg.NODE_ENV,
      host: cfg.ZALO_SERVICE_HOST,
      port: cfg.ZALO_SERVICE_PORT,
    },
    'zalo_service starting',
  );

  // Eagerly open Redis so /healthz reports accurate state from the first hit.
  getCommandClient();

  const app = createApp();
  const server: Server = app.listen(
    cfg.ZALO_SERVICE_PORT,
    cfg.ZALO_SERVICE_HOST,
    () => {
      log.info(
        { url: `http://${cfg.ZALO_SERVICE_HOST}:${cfg.ZALO_SERVICE_PORT}` },
        'zalo_service ready',
      );
    },
  );

  installShutdownHandlers(server);

  // Kick off session restore asynchronously so the HTTP server accepts
  // requests immediately even if Rails is slow to respond.
  void restoreSessionsFromRails().catch((err) => {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'session-bootstrap failed — continuing without restored sessions',
    );
  });

  // Heartbeat probe loop for ready sessions (Phase 06).
  startHeartbeat();
}

function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'zalo_service shutdown initiated');

    // Stop accepting new connections
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    stopHeartbeat();
    await closeRedisClients();

    log.info('zalo_service shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason: String(reason) }, 'unhandledRejection');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'zalo_service failed to start',
  );
  process.exit(1);
});
