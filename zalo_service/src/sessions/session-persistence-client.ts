import { loadConfig } from '../config.js';
import { childLogger } from '../logger.js';

/**
 * HTTP client for the Rails internal Zalo session API.
 *
 * Contract (implemented in Phase 03 of the Rails side):
 *   GET    /internal/zalo_sessions?status=active
 *   POST   /internal/zalo_sessions          (Node → Rails, after QR login success)
 *   GET    /internal/zalo_sessions/:session_id
 *   PUT    /internal/zalo_sessions/:session_id      (refresh cookies)
 *   PATCH  /internal/zalo_sessions/:session_id      (status/last_seen_at only)
 *   DELETE /internal/zalo_sessions/:session_id
 *
 * Design notes:
 *   - The client is TOLERANT to Rails being unreachable or returning 404.
 *     zalo_service must continue running even when Rails is offline or the
 *     migrations for Phase 03 have not been applied yet.
 *   - Calls use the shared internal token (same env var, both directions).
 *   - Retries only on 5xx / network errors, never on 4xx.
 */

const log = childLogger({ component: 'persistence-client' });

export interface RailsSessionRow {
  session_id: string;
  channel_zalo_id: number;
  account_id: number;
  zalo_own_id: string | null;
  // Serialized JSON, AES-256-GCM sealed for the hop. Use decryptFromRails().
  cookies_encrypted: string;
  imei: string;
  user_agent: string;
  proxy_url: string | null;
  status: string;
  last_seen_at: string | null;
  inbox_id?: number;
}

export interface CreateSessionPayload {
  session_id: string;
  own_id: string;
  display_name?: string;
  cookies_encrypted: string;
  imei: string;
  user_agent: string;
  account_id: number;
  existing_channel_id?: number;
}

export interface PatchSessionPayload {
  status?: string;
  last_seen_at?: string;
  cookies_encrypted?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FetchFn = typeof fetch;

export class SessionPersistenceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchFn;

  constructor(opts: { fetchImpl?: FetchFn } = {}) {
    const cfg = loadConfig();
    this.baseUrl = cfg.CHATWOOT_INTERNAL_URL.replace(/\/$/, '');
    this.token = cfg.ZALO_SERVICE_INTERNAL_TOKEN;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Blocks until Rails answers its health check, or the deadline passes.
   *
   * Node and Rails start concurrently under the Procfile, and Rails may still
   * be loading or migrating. Without this the boot-time restore ran against a
   * Rails that was not up yet, exhausted its three retries in about a second,
   * and reported "no sessions to restore" — leaving every session down until
   * someone noticed (red team H2).
   */
  async waitUntilRailsReady(timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let delay = 500;

    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/health`, {
          method: 'GET',
        });
        if (res.ok) return true;
        log.warn({ status: res.status }, 'rails health check not ok yet');
      } catch (err) {
        log.debug(
          { reason: err instanceof Error ? err.message : String(err) },
          'rails not reachable yet',
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 5_000);
    }
    return false;
  }

  /**
   * Returns null when Rails could not be asked, as distinct from [] meaning
   * Rails answered and has nothing to restore. Collapsing the two is what
   * made a failed restore look like a successful empty one.
   */
  async listActive(): Promise<RailsSessionRow[] | null> {
    // No status query param — Rails falls back to the .active scope
    // which covers [pending, qr_ready, scanning, confirmed, ready].
    // Passing ?status=active would match zero rows because 'active' is
    // not a real ZaloSession status value.
    const res = await this.request('GET', '/internal/zalo_sessions');
    if (!res) return null;
    if (!res.ok) {
      log.warn({ status: res.status }, 'listActive: non-ok response');
      return null;
    }
    return (await res.json()) as RailsSessionRow[];
  }

  async createSession(payload: CreateSessionPayload): Promise<RailsSessionRow | null> {
    const res = await this.request('POST', '/internal/zalo_sessions', payload);
    if (!res || !res.ok) {
      log.error({ status: res?.status }, 'createSession failed');
      return null;
    }
    return (await res.json()) as RailsSessionRow;
  }

  async patchSession(
    sessionId: string,
    payload: PatchSessionPayload,
  ): Promise<boolean> {
    const res = await this.request(
      'PATCH',
      `/internal/zalo_sessions/${sessionId}`,
      payload,
    );
    return res?.ok ?? false;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const res = await this.request('DELETE', `/internal/zalo_sessions/${sessionId}`);
    return res?.ok ?? false;
  }

  // ---- private ------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<Response | null> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-Zalo-Service-Token': this.token,
      'Content-Type': 'application/json',
    };
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      // Only retry transient 5xx — 4xx are caller bugs and must surface.
      if (res.status >= 500 && attempt < 2) {
        const backoff = 500 * Math.pow(2, attempt);
        log.warn(
          { method, path, status: res.status, attempt },
          'rails 5xx — retrying',
        );
        await sleep(backoff);
        return this.request(method, path, body, attempt + 1);
      }

      return res;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt < 2) {
        const backoff = 500 * Math.pow(2, attempt);
        log.warn({ method, path, reason, attempt }, 'rails fetch error — retrying');
        await sleep(backoff);
        return this.request(method, path, body, attempt + 1);
      }
      log.error({ method, path, reason }, 'rails fetch gave up after retries');
      return null;
    }
  }
}
