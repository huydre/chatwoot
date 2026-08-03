# Phase 01 — Node Service Foundation

## Context Links
- Plan: [plan.md](./plan.md)
- Related: [phase-02-session-manager-qr-login.md](./phase-02-session-manager-qr-login.md)
- Reference pattern: `app/services/telegram/` (Ruby-side), but Node service = new layer

## Overview
- **Priority:** P0 (blocker cho mọi phase khác)
- **Status:** Todo
- **Description:** Dựng Node.js service skeleton tại `zalo_service/` trong monorepo. Dùng zca-js, expose HTTP API cho Rails, publish events qua Redis. Chưa cần multi-session — chỉ cần single-session POC để verify zca-js hoạt động.

## Key Insights
- **zca-js bắt buộc Node** → không có đường đi tắt bằng Ruby
- **Embed như 1 process Procfile** → user vẫn 1 command up toàn bộ
- **Share Redis với Chatwoot** → không duplicate infra
- **Session store qua Postgres** (không dùng file system) → HA-ready

## Requirements

### Functional
- Expose HTTP server trên port từ env `ZALO_SERVICE_PORT` (default 4567, **không** expose public, bind `127.0.0.1`)
- Endpoints:
  - `POST /login/start` → trả `{ session_id, qr_url }` (base64 PNG hoặc URL)
  - `GET /login/status/:session_id` → trả `{ status: 'pending'|'scanning'|'confirmed'|'ready'|'expired'|'failed', own_id?, error? }`
  - `POST /send` → body `{ session_id, thread_id, thread_type, content, attachments?, reply_to? }` → trả `{ message_id, timestamp }`
  - `DELETE /session/:session_id` → logout + cleanup
  - `GET /session/:session_id/health` → trả `{ status, last_seen_at, queue_depth }`
  - `GET /healthz` → liveness probe
- Publish Redis channel `zalo.events` với JSON:
  - `{ type: 'message', session_id, payload }` — tin mới
  - `{ type: 'session_disconnected', session_id, reason }` — mất kết nối
  - `{ type: 'session_ready', session_id, own_id }` — login thành công
  - `{ type: 'message_delivery_error', session_id, thread_id, error }` — gửi fail
- Internal auth: header `X-Zalo-Service-Token` (shared secret trong env `ZALO_SERVICE_INTERNAL_TOKEN`)
- Graceful shutdown on SIGTERM: close WS sessions, drain queue, exit 0

### Non-Functional
- TypeScript strict mode
- Structured logging via `pino` JSON (compat với Chatwoot log pipeline)
- Request ID propagation (from Rails → Node via header)
- No cookie/imei in log output (scrub via pino redact config)
- Startup < 3s (lazy load sessions)

## Architecture

```
zalo_service/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts                  # bootstrap: load config, start express, wire routes
│   ├── config.ts                 # zod-validated env loader
│   ├── logger.ts                 # pino factory, redaction rules
│   ├── http/
│   │   ├── server.ts             # express app, middlewares (auth, request-id, error handler)
│   │   ├── auth-middleware.ts    # internal token check
│   │   └── routes/
│   │       ├── login-routes.ts
│   │       ├── send-routes.ts
│   │       ├── session-routes.ts
│   │       └── health-routes.ts
│   ├── zalo/
│   │   ├── zalo-client-factory.ts   # wraps zca-js Zalo class, single session creation
│   │   ├── session-context.ts       # in-memory session state per session_id
│   │   └── event-dispatcher.ts      # zca-js listener → internal emitter
│   ├── redis/
│   │   ├── redis-client.ts       # ioredis factory, connection reuse
│   │   └── event-publisher.ts    # publish helper with schema validation
│   ├── schemas/
│   │   └── event-schemas.ts      # zod schemas for outgoing/incoming events
│   └── utils/
│       ├── error-codes.ts        # typed error codes
│       └── request-id.ts
├── dist/                         # built output (git-ignored)
└── tests/
    ├── http.spec.ts              # supertest
    ├── zalo-client-factory.spec.ts
    └── event-publisher.spec.ts
```

### Dependency choices

| Package | Version | Why |
|---|---|---|
| `zca-js` | latest pinned | Core Zalo library |
| `express` | ^4 | Battle-tested, simple |
| `ioredis` | ^5 | Pub/sub + retry built-in |
| `pino` + `pino-pretty` (dev) | ^9 | JSON log, fast |
| `zod` | ^3 | Schema validation env + events |
| `typescript` + `tsx` + `tsc-alias` | latest | TS runtime + build |
| `vitest` + `supertest` | ^2 | Test |

**KHÔNG dùng:** Nest.js, Fastify, Koa, async_hooks, express-jwt, helmet (KISS).

## Related Code Files

### To create
- `zalo_service/package.json`
- `zalo_service/tsconfig.json`
- `zalo_service/.env.example`
- `zalo_service/src/index.ts`
- `zalo_service/src/config.ts`
- `zalo_service/src/logger.ts`
- `zalo_service/src/http/server.ts`
- `zalo_service/src/http/auth-middleware.ts`
- `zalo_service/src/http/routes/health-routes.ts` (foundation only — other routes in Phase 02)
- `zalo_service/src/redis/redis-client.ts`
- `zalo_service/src/redis/event-publisher.ts`
- `zalo_service/src/schemas/event-schemas.ts`
- `zalo_service/tests/*.spec.ts`
- `zalo_service/.gitignore` (dist, node_modules, .env)

### To modify
- `Procfile.dev` — add `zalo: node zalo_service/dist/index.js` (dev build pre-step: `pnpm --filter zalo_service build` OR use `tsx` for dev watch)
- `.env.example` (Chatwoot root) — add:
  ```
  ZALO_SERVICE_PORT=4567
  ZALO_SERVICE_URL=http://127.0.0.1:4567
  ZALO_SERVICE_INTERNAL_TOKEN=changeme_shared_secret
  ```
- `.gitignore` root — add `zalo_service/dist/` and `zalo_service/node_modules/`

### Reference (read-only)
- `app/services/telegram/send_on_telegram_service.rb` — pattern tham khảo cho send flow
- `Procfile.dev` hiện tại — xem format 3 process sẵn có

## Implementation Steps

1. **Init package**
   - `cd chattize && mkdir zalo_service && cd zalo_service`
   - `pnpm init`, set `"type": "module"`, `"scripts"`: `build`, `dev` (tsx watch), `start`, `test`
   - `pnpm add zca-js express ioredis pino zod`
   - `pnpm add -D typescript tsx vitest supertest @types/express @types/node pino-pretty tsc-alias`

2. **TypeScript config**
   - Strict mode, target ES2022, module NodeNext, outDir `dist/`, rootDir `src/`
   - Path alias `@/*` → `src/*`

3. **Config loader** (`src/config.ts`)
   - Zod schema: `PORT`, `REDIS_URL`, `INTERNAL_TOKEN`, `LOG_LEVEL`, `NODE_ENV`
   - Throw early nếu thiếu env required
   - Export typed `config` object

4. **Logger** (`src/logger.ts`)
   - Pino factory, redact paths: `req.headers["x-zalo-service-token"]`, `req.body.cookies`, `*.imei`, `*.accessToken`
   - Pretty print dev, JSON prod

5. **Redis client** (`src/redis/redis-client.ts`)
   - Singleton ioredis instance, `enableReadyCheck: true`, `maxRetriesPerRequest: null`
   - Separate pub connection (ioredis không cho share pub/sub connection)

6. **Event publisher** (`src/redis/event-publisher.ts`)
   - `publishEvent(event: ZaloEvent)` → validate schema → `publish('zalo.events', JSON.stringify(event))`
   - Log + swallow error (không crash service nếu Redis down — Rails sẽ retry qua health check)

7. **Event schemas** (`src/schemas/event-schemas.ts`)
   - Zod union `ZaloEvent`: message, session_ready, session_disconnected, message_delivery_error
   - Export TS types via `z.infer`

8. **HTTP server** (`src/http/server.ts`)
   - Express app, `express.json({ limit: '10mb' })` cho attachment base64
   - Middlewares: request-id, auth, structured error handler
   - Mount routes: `/healthz` (no auth), `/login/*`, `/send`, `/session/*` (auth required)

9. **Auth middleware** (`src/http/auth-middleware.ts`)
   - Check header `X-Zalo-Service-Token` match `config.internalToken`
   - Return 401 nếu không match

10. **Health route** (`src/http/routes/health-routes.ts`)
    - `GET /healthz` → `{ ok: true, uptime, redis_ok, session_count }`
    - Foundation only — session count = 0 trong phase này

11. **Bootstrap** (`src/index.ts`)
    - Load config → init logger → init Redis → start server
    - Listen SIGTERM → graceful shutdown (close server, Redis quit, exit 0)
    - Log "ready" với port

12. **Smoke test**
    - `curl http://127.0.0.1:4567/healthz` → 200 OK
    - `curl -H "X-Zalo-Service-Token: wrong" http://127.0.0.1:4567/session/foo/health` → 401

13. **Procfile integration**
    - Dev: `zalo: cd zalo_service && pnpm dev` (watch mode)
    - Alternative: pre-build step in `bin/setup` or `Makefile`
    - Verify `overmind start -f Procfile.dev` spawn 4 process

14. **Basic tests**
    - Vitest setup
    - `tests/http.spec.ts`: test /healthz, test auth middleware reject/accept
    - `tests/event-publisher.spec.ts`: mock Redis, verify schema validation

## Todo List

- [ ] Scaffold `zalo_service/` với package.json + tsconfig
- [ ] Install deps (zca-js, express, ioredis, pino, zod + dev deps)
- [ ] Implement `config.ts` với zod validation
- [ ] Implement `logger.ts` với redaction rules
- [ ] Implement `redis-client.ts` (pub connection riêng)
- [ ] Implement `event-publisher.ts` + zod schemas
- [ ] Implement `http/server.ts` + auth middleware
- [ ] Implement `health-routes.ts`
- [ ] Implement `index.ts` bootstrap + graceful shutdown
- [ ] Smoke test curl manual
- [ ] Update `Procfile.dev` thêm `zalo` process
- [ ] Update `.env.example` (Chatwoot root) thêm 3 env vars
- [ ] Update `.gitignore`
- [ ] Viết test `http.spec.ts`, `event-publisher.spec.ts`
- [ ] Verify `overmind start -f Procfile.dev` chạy OK cả 4 process
- [ ] Test Redis pub: manual publish event → verify Rails sẽ receive ở Phase 04

## Success Criteria

1. `pnpm --filter zalo_service build` compile no errors
2. `pnpm --filter zalo_service test` all pass
3. `overmind start -f Procfile.dev` → 4 process up (backend, worker, vite, zalo)
4. `curl http://127.0.0.1:4567/healthz` trả JSON `{ok: true, ...}`
5. Auth middleware reject request không có token
6. Publish event dummy qua Redis CLI → service log ghi nhận
7. SIGTERM graceful shutdown không leave orphan process

## Risk Assessment

| Risk | Mitigation |
|---|---|
| zca-js có breaking change giữa versions | Pin exact version trong package.json, ghi chú upgrade path |
| Port 4567 conflict | Config qua env, default ít dùng |
| Redis connection flap | ioredis auto-retry built-in, log warnings |
| TypeScript build lỗi ESM/CommonJS | Use `"type": "module"` + `tsc-alias` cho path alias |

## Security Considerations

- HTTP server bind `127.0.0.1` — không expose public
- Internal token auth cho mọi endpoint trừ `/healthz`
- Log redaction cho sensitive fields (cookie, imei, token)
- No shell command execution
- JSON body limit 10mb (tránh DoS)

## Next Steps

→ **Phase 02**: Multi-session manager, Postgres session store, QR login thật sự (phase này chỉ foundation, chưa touch zca-js session logic)
