import pino, { type Logger, type LoggerOptions } from 'pino';
import { loadConfig } from './config.js';

/**
 * Structured logger with sensitive-field redaction.
 *
 * NEVER log full cookies, imei, internal tokens, or QR base64 payloads.
 * The redact rules below catch the common paths these values might appear on.
 */

const REDACT_PATHS = [
  // Cookies and session secrets anywhere in the log object
  '*.cookie',
  '*.cookies',
  '*.cookies_encrypted',
  '*.imei',
  '*.accessToken',
  '*.access_token',
  '*.token',
  // HTTP headers that carry secrets
  'req.headers["x-zalo-service-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
  // Body fields for session persistence endpoints
  'req.body.cookies',
  'req.body.cookies_encrypted',
  'req.body.imei',
  'req.body.user_agent',
  // QR base64 is too large to log even though not sensitive
  '*.qr_base64',
  '*.image',
];

function buildPinoOptions(): LoggerOptions {
  const cfg = loadConfig();
  const isDev = cfg.NODE_ENV === 'development';

  return {
    level: cfg.LOG_LEVEL,
    base: { service: 'zalo_service' },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service',
          },
        }
      : undefined,
  };
}

let rootLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = pino(buildPinoOptions());
  }
  return rootLogger;
}

/** Create a child logger with a fixed context object (e.g., component name). */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}
