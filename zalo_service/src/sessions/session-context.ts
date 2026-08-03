import type * as zcaJs from 'zca-js';

// The handle is whatever loginQR resolves to, derived from zca-js's own
// declarations. It has to come through a namespace import: zca-js's root
// index.d.ts declares `export as namespace Zalo`, and that UMD namespace
// shadows the re-exported `Zalo` class, so `import type { Zalo }` does not
// resolve.
//
// This used to be `unknown`, and each call site then re-declared its own
// structural interface with optional methods. That is precisely how an
// upstream signature change slips past the compiler: the calls typecheck
// against a hand-written shape that nothing keeps in step with the library.
type ApiHandle = Awaited<ReturnType<InstanceType<typeof zcaJs.Zalo>['loginQR']>>;

/**
 * Per-session state container.
 *
 * A SessionContext represents the full lifecycle of one Zalo account login
 * inside this Node process. It owns:
 *   - the current state enum (drives HTTP polling response)
 *   - the zca-js `api` handle once login succeeds (used for send + listen)
 *   - the identifiers Rails needs to link messages to a Channel::Zalo
 *
 * Transitions are linear until a terminal state. The login flow, message
 * listener, and reconnect manager all mutate through the `mark*` helpers so
 * state changes remain centralised and observable.
 */

export type SessionState =
  | 'pending'
  | 'qr_ready'
  | 'scanning'
  | 'confirmed'
  | 'ready'
  | 'disconnected'
  | 'expired'
  | 'failed'
  | 'deleted';

export interface SessionSerialized {
  session_id: string;
  state: SessionState;
  own_id: string | null;
  display_name: string | null;
  qr_base64: string | null;
  qr_expires_at: string | null;
  last_connected_at: string | null;
  last_seen_at: string | null;
  error_message: string | null;
  inbox_id: number | null;
}

export class SessionContext {
  public state: SessionState = 'pending';
  public ownId: string | null = null;
  public displayName: string | null = null;
  public qrBase64: string | null = null;
  public qrExpiresAt: Date | null = null;
  public lastConnectedAt: Date | null = null;
  public lastSeenAt: Date | null = null;
  public errorMessage: string | null = null;
  public api: ApiHandle | null = null;
  // Persisted Rails Inbox id returned from the internal API after
  // createSession. The frontend polls status and redirects to the
  // "assign agents" page as soon as this becomes non-null.
  public inboxId: number | null = null;

  constructor(public readonly sessionId: string) {}

  // ---- state transitions --------------------------------------------------

  markQrReady(qrBase64: string, ttlMs = 120_000): void {
    this.state = 'qr_ready';
    this.qrBase64 = qrBase64;
    this.qrExpiresAt = new Date(Date.now() + ttlMs);
  }

  markScanning(displayName: string | null = null): void {
    this.state = 'scanning';
    this.displayName = displayName;
  }

  markConfirmed(): void {
    this.state = 'confirmed';
  }

  markReady(api: ApiHandle, ownId: string): void {
    this.state = 'ready';
    this.api = api;
    this.ownId = ownId;
    this.lastConnectedAt = new Date();
    this.lastSeenAt = new Date();
    // Free the QR payload — never needed again and it's large.
    this.qrBase64 = null;
    this.qrExpiresAt = null;
  }

  markDisconnected(reason: string): void {
    this.state = 'disconnected';
    this.errorMessage = reason;
    this.lastSeenAt = new Date();
    this.api = null;
  }

  markExpired(reason = 'qr_timeout'): void {
    this.state = 'expired';
    this.errorMessage = reason;
    this.qrBase64 = null;
    this.qrExpiresAt = null;
  }

  markFailed(reason: string): void {
    this.state = 'failed';
    this.errorMessage = reason;
    this.api = null;
  }

  markDeleted(): void {
    this.state = 'deleted';
    this.api = null;
  }

  touchSeen(): void {
    this.lastSeenAt = new Date();
  }

  isActive(): boolean {
    return (
      this.state !== 'deleted' &&
      this.state !== 'expired' &&
      this.state !== 'failed'
    );
  }

  // ---- serialization ------------------------------------------------------

  serialize(): SessionSerialized {
    return {
      session_id: this.sessionId,
      state: this.state,
      own_id: this.ownId,
      display_name: this.displayName,
      qr_base64: this.qrBase64,
      qr_expires_at: this.qrExpiresAt?.toISOString() ?? null,
      last_connected_at: this.lastConnectedAt?.toISOString() ?? null,
      last_seen_at: this.lastSeenAt?.toISOString() ?? null,
      error_message: this.errorMessage,
      inbox_id: this.inboxId,
    };
  }
}
