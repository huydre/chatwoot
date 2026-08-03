import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { childLogger } from '../logger.js';
import { SessionContext } from './session-context.js';

/**
 * In-memory registry of active Zalo sessions owned by this Node process.
 *
 * Uses a plain Map since Node is single-threaded — no locking required for
 * pure registry operations. The manager enforces the hard cap on concurrent
 * sessions via ZALO_MAX_SESSIONS_PER_PROCESS so a misconfigured deployment
 * cannot OOM the process with unbounded QR logins.
 *
 * Session lifecycle is coordinated here: create/get/delete live in the
 * manager; login flow, listener, and reconnect attach through context mutation.
 */

const log = childLogger({ component: 'session-manager' });

class SessionManager {
  private readonly sessions = new Map<string, SessionContext>();

  create(sessionId?: string): SessionContext {
    const max = loadConfig().ZALO_MAX_SESSIONS_PER_PROCESS;
    if (this.sessions.size >= max) {
      throw new Error(
        `session-manager: capacity reached (${max}). Refusing to create new session.`,
      );
    }

    const id = sessionId ?? randomUUID();
    if (this.sessions.has(id)) {
      throw new Error(`session-manager: session ${id} already exists`);
    }

    const ctx = new SessionContext(id);
    this.sessions.set(id, ctx);
    log.info({ session_id: id, size: this.sessions.size }, 'session created');
    return ctx;
  }

  get(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  delete(sessionId: string): boolean {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return false;
    ctx.markDeleted();
    this.sessions.delete(sessionId);
    log.info(
      { session_id: sessionId, size: this.sessions.size },
      'session deleted',
    );
    return true;
  }

  getAll(): SessionContext[] {
    return Array.from(this.sessions.values());
  }

  size(): number {
    return this.sessions.size;
  }

  /** Drop every session without touching zca-js. Used in tests + shutdown. */
  clear(): void {
    for (const ctx of this.sessions.values()) {
      ctx.markDeleted();
    }
    this.sessions.clear();
  }
}

// Singleton — one registry per process.
let instance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!instance) instance = new SessionManager();
  return instance;
}

/** Test-only: reset the registry between spec runs. */
export function resetSessionManagerForTests(): void {
  instance = null;
}

export type { SessionManager };
