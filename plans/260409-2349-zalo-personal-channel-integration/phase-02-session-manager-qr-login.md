# Phase 02 — Multi-Session Manager + QR Login

## Context Links
- Plan: [plan.md](./plan.md)
- Prev: [phase-01-node-service-foundation.md](./phase-01-node-service-foundation.md)
- Next: [phase-03-rails-channel-model.md](./phase-03-rails-channel-model.md)

## Overview
- **Priority:** P0
- **Status:** Todo
- **Description:** Implement multi-session manager quản lý N Zalo sessions đồng thời. Mỗi session persist cookie/imei vào Postgres (encrypted). QR login flow end-to-end: Rails call → Node generate QR → user scan → login success → emit ready event.

## Key Insights

- **zca-js login flow** (tham khảo code multizlogin + zca-js README):
  1. `new Zalo({ selfListen: false })` → tạo instance
  2. `zalo.loginQR({ userAgent, language, qrPath? })` → returns `{ code, ... }` + emit QR events
  3. QR event có base64 image → bridge emit cho frontend poll
  4. User scan → zca-js emit `got login info` → cookies/imei sẵn sàng
  5. Store cookies/imei/ua → re-login lần sau: `zalo.login({ cookie, imei, userAgent })`
- Mỗi session = 1 WebSocket connection → resource nặng → cần cleanup khi DELETE
- Postgres schema share với Rails (same DB), bảng riêng `zalo_sessions`
- **Encryption:** dùng Rails-generated keys (env `ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY`). Node cũng đọc env này và encrypt symmetric với cùng key → hoặc đơn giản hơn: **Node ghi plain, Rails đọc và re-encrypt trước khi expose**. Decision: **Node encrypt bằng `crypto` module với key từ env** (shared với Rails convention).

**Simpler alternative:** Node **không trực tiếp write DB**. Tất cả session writes/reads đi qua HTTP gọi Rails internal endpoint. Rails handle encryption. → Trade-off: thêm 1 round-trip nhưng tránh duplicate encryption logic. **Chọn cách này** (KISS, single source of truth).

## Requirements

### Functional

- `POST /login/start` body `{ proxy?: string, user_agent?: string }`
  - Create `session_id` (UUID)
  - Invoke zca-js QR login in background
  - Return `{ session_id, status: 'pending' }` immediately
  - Emit Redis event `{ type: 'qr_code', session_id, qr_base64 }` khi có QR
  - Khi login xong → call Rails endpoint `PUT /internal/zalo_sessions/:session_id` với cookies/imei/ua → emit `session_ready` event

- `GET /login/status/:session_id` → trả current state:
  - `pending` (just created, chưa có QR)
  - `qr_ready` + `qr_base64`
  - `scanning` (user scanned, waiting confirm)
  - `confirmed` (logged in, persisting)
  - `ready` (persisted, active)
  - `expired` (QR timeout 2 phút)
  - `failed` + error message

- **Session bootstrap on startup:**
  - Node startup → GET Rails `/internal/zalo_sessions?status=active`
  - For each → call `zalo.login({ cookies, imei, ua })` in parallel (with concurrency limit 5)
  - Emit `session_ready` hoặc `session_disconnected` nếu fail

- **Session manager in-memory registry:**
  - `Map<session_id, ZaloSessionContext>`
  - Context: `{ api, status, last_seen_at, own_id, login_context }`
  - Thread-safe operations (Node single-thread → không cần lock)

- `DELETE /session/:session_id`:
  - Logout zca-js (if has method) or just close WS
  - Remove from in-memory map
  - Call Rails `PATCH /internal/zalo_sessions/:session_id` → set `status='deleted'`

### Non-Functional

- Concurrent login: support 10+ simultaneous QR flows
- Session startup: parallel với concurrency limit (avoid thundering herd)
- QR regeneration: auto every 60s nếu chưa scan
- Memory: mỗi session ~10-50MB in Node heap (zca-js WS state)

## Architecture

### Files

```
zalo_service/src/
├── sessions/
│   ├── session-manager.ts           # Central registry + lifecycle
│   ├── session-context.ts           # State class per session
│   ├── session-bootstrap.ts         # Startup: restore from Rails
│   └── session-persistence-client.ts # HTTP client → Rails internal API
├── zalo/
│   ├── zalo-login-flow.ts           # QR login state machine
│   ├── zalo-message-listener.ts     # on(message) → publish Redis
│   └── zalo-disconnect-detector.ts  # heartbeat + error observer
└── http/routes/
    ├── login-routes.ts              # POST /login/start, GET /login/status
    └── session-routes.ts            # DELETE, GET health
```

### SessionContext state machine

```
┌─────────┐  loginQR()  ┌──────────┐  emit QR  ┌───────────┐
│ created │────────────►│ pending  │──────────►│ qr_ready  │
└─────────┘             └──────────┘           └─────┬─────┘
                                                     │ user scan
                              ┌──────────────────────┘
                              ▼
                        ┌───────────┐  got cookies  ┌───────────┐
                        │ scanning  │──────────────►│ confirmed │
                        └───────────┘               └─────┬─────┘
                                                          │ persist
                                                          ▼
                                                    ┌───────────┐
                                                    │   ready   │
                                                    └─────┬─────┘
                                                          │ lost WS / logout event
                                                          ▼
                                                    ┌──────────────┐
                                                    │ disconnected │──► emit event
                                                    └──────────────┘

Error transitions:
  * → failed (QR timeout, network error)
  * → expired (QR code tuổi thọ 2 phút)
```

### Rails internal API (contract cho Node consume)

```
POST   /internal/zalo_sessions              (body: session_id, own_id, cookies, imei, ua)
GET    /internal/zalo_sessions              (query: status=active)
GET    /internal/zalo_sessions/:session_id
PUT    /internal/zalo_sessions/:session_id  (body: cookies, imei, ua)
PATCH  /internal/zalo_sessions/:session_id  (body: status, last_seen_at)
DELETE /internal/zalo_sessions/:session_id
```

Auth: shared token `ZALO_SERVICE_INTERNAL_TOKEN` (reverse direction so Node ↔ Rails dùng cùng secret). Host: `localhost` only.

**Routes sẽ được implement ở Phase 03 (Rails side).** Phase này assume contract.

## Related Code Files

### To create
- `zalo_service/src/sessions/session-manager.ts`
- `zalo_service/src/sessions/session-context.ts`
- `zalo_service/src/sessions/session-bootstrap.ts`
- `zalo_service/src/sessions/session-persistence-client.ts`
- `zalo_service/src/zalo/zalo-login-flow.ts`
- `zalo_service/src/zalo/zalo-message-listener.ts`
- `zalo_service/src/zalo/zalo-disconnect-detector.ts`
- `zalo_service/src/http/routes/login-routes.ts`
- `zalo_service/src/http/routes/session-routes.ts`
- `zalo_service/tests/session-manager.spec.ts`
- `zalo_service/tests/zalo-login-flow.spec.ts`

### To modify
- `zalo_service/src/index.ts` — bootstrap session restore after startup
- `zalo_service/src/schemas/event-schemas.ts` — add `qr_code` event variant

## Implementation Steps

1. **`session-context.ts`** — class đại diện 1 session state
   - Fields: `sessionId`, `status`, `ownId?`, `api?` (zca-js api handle), `lastSeenAt`, `error?`
   - Methods: `markReady()`, `markDisconnected(reason)`, `markFailed(error)`
   - Emit events via internal EventEmitter

2. **`session-manager.ts`** — registry + CRUD
   - `Map<string, SessionContext>`
   - `create(sessionId)`, `get(sessionId)`, `delete(sessionId)`, `getAll()`
   - `size()` cho health endpoint

3. **`zalo-login-flow.ts`** — QR login wrapper
   - `startQrLogin(sessionId, options): Promise<void>`
   - Internally: `new Zalo()` → `loginQR({ onQrcodeGenerated, onQrcodeScanned, onLoggedIn })`
   - zca-js callbacks → update SessionContext state → publish Redis event
   - QR timeout: 120s → mark expired → cleanup

4. **`session-persistence-client.ts`** — HTTP client cho Rails internal API
   - Axios instance, base URL `process.env.CHATWOOT_INTERNAL_URL` (default `http://127.0.0.1:3000`)
   - Header `X-Zalo-Service-Token: ${internalToken}`
   - Methods match contract above
   - Retry exponential backoff 3x for 5xx
   - Timeout 10s

5. **`zalo-message-listener.ts`** — subscribe zca-js events
   - `attachListener(sessionCtx)`:
     - `api.listener.on('message', (msg) => { publish(...) })`
     - `api.listener.on('error', (err) => { ctx.markDisconnected(err) })`
     - `api.listener.start()`

6. **`zalo-disconnect-detector.ts`** — heartbeat
   - Every 30s: check each session's `last_seen_at`
   - If stale > 5 min → ping by calling `api.getContext()` or similar lightweight
   - If ping fails → mark disconnected → emit event → call Rails to update status

7. **`session-bootstrap.ts`** — startup restore
   - On Node start: GET Rails `/internal/zalo_sessions?status=active`
   - For each row: `pLimit(5)(() => restoreSession(row))`
   - `restoreSession`: `zalo.login({ cookies, imei, ua })` → if success → attach listener → mark ready
   - If fail: emit `session_disconnected` so Rails flags channel

8. **`login-routes.ts`**
   - `POST /login/start` → manager.create() → trigger startQrLogin async → return sessionId
   - `GET /login/status/:id` → return ctx.serialize()

9. **`session-routes.ts`**
   - `DELETE /session/:id` → detach listener → remove from manager → call Rails update
   - `GET /session/:id/health` → `{ status, last_seen_at, own_id }`

10. **Event schemas update** — add `qr_code`, `qr_expired` variants

11. **Smoke test manual:**
    - curl `POST /login/start` → get session_id
    - Poll `GET /login/status/:id` → thấy qr_ready + base64
    - Paste base64 vào online decoder → thấy QR
    - Scan bằng Zalo app → state → scanning → confirmed → ready
    - Send tin từ Zalo khác → Node log ghi nhận + publish Redis event

12. **Tests**:
    - `session-manager.spec.ts`: CRUD ops, concurrent access
    - `zalo-login-flow.spec.ts`: mock zca-js, verify state transitions
    - `session-persistence-client.spec.ts`: nock/msw HTTP mocks

## Todo List

- [ ] Design SessionContext state enum + transitions
- [ ] Implement `session-context.ts`
- [ ] Implement `session-manager.ts`
- [ ] Implement `session-persistence-client.ts` với retry
- [ ] Implement `zalo-login-flow.ts` (QR flow)
- [ ] Implement `zalo-message-listener.ts`
- [ ] Implement `zalo-disconnect-detector.ts` (heartbeat)
- [ ] Implement `session-bootstrap.ts` (startup restore)
- [ ] Implement `login-routes.ts`
- [ ] Implement `session-routes.ts`
- [ ] Update event schemas (add qr_code, qr_expired)
- [ ] Manual QR test end-to-end (cần 1 Zalo account test)
- [ ] Unit test session manager, login flow, persistence client
- [ ] Integration test: full QR flow with mocked zca-js

## Success Criteria

1. Create session → get QR base64 → scan → ready state trong < 30s
2. Publish event `session_ready` sau khi login thành công
3. Restart Node service → sessions restore automatically (cần Phase 03 done)
4. Delete session → in-memory cleanup + Rails marked deleted
5. Heartbeat detect dead session → emit disconnect
6. 5 concurrent QR logins không crash

## Risk Assessment

| Risk | Mitigation |
|---|---|
| zca-js QR API signature khác version | Pin zca-js version, wrap in abstraction |
| Memory leak per session | Cleanup on delete, heartbeat detect orphan |
| Rails internal API down khi Node startup | Retry with backoff, fail gracefully, run without sessions until Rails alive |
| 2 Node instances (HA) cùng restore 1 session | Add unique constraint + locking ở Phase 06 |
| Cookies leak via log | pino redact rules |
| Long-running QR consume slot | Timeout 120s aggressive cleanup |

## Security Considerations

- Cookies in transit Node→Rails over HTTP localhost only (NOT over network)
- Internal token required
- No QR base64 in log (large, not sensitive but clutter)
- Rate limit `POST /login/start`: max 5/minute per IP

## Next Steps

→ **Phase 03**: Rails side — `Channel::Zalo` model + `zalo_sessions` table + internal API contract implement
