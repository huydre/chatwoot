# zalo_service

Node.js sidecar that bridges `zca-js` (unofficial Zalo Web library) to Rails for the Chatwoot Zalo Personal channel.

Runs as a single process alongside Rails via Procfile. Not a standalone product.

## Why it exists

Chatwoot is Ruby/Rails. `zca-js` is Node.js and cannot be reimplemented in Ruby without months of effort reversing Zalo's protocol. Rather than running two services and complicating ops, we embed this Node process inside the same repo and launch it through Procfile, so the user experience is still "one repo, one deploy".

## Architecture

```
zalo_service/
├── src/
│   ├── index.ts                 # bootstrap + graceful shutdown
│   ├── config.ts                # zod-validated env loader
│   ├── logger.ts                # pino with redaction
│   ├── http/
│   │   ├── server.ts            # express app
│   │   ├── auth-middleware.ts   # shared token check
│   │   └── routes/
│   │       ├── health-routes.ts
│   │       ├── login-routes.ts   # POST /login/start, GET /login/status/:id
│   │       └── session-routes.ts # GET /session/:id/health, DELETE /session/:id
│   ├── redis/
│   │   ├── redis-client.ts      # ioredis singletons
│   │   └── event-publisher.ts   # schema-validated publish
│   ├── schemas/
│   │   └── event-schemas.ts     # zod discriminated union
│   ├── sessions/
│   │   ├── session-context.ts   # state machine per session
│   │   ├── session-manager.ts   # in-memory registry
│   │   ├── session-bootstrap.ts # startup restore from Rails
│   │   └── session-persistence-client.ts  # HTTP → Rails internal API
│   ├── zalo/
│   │   ├── zalo-client-factory.ts   # real zca-js adapter
│   │   ├── zalo-login-flow.ts        # QR login callback handler
│   │   └── zalo-message-listener.ts  # wires api.listener → Redis
│   └── reconnect/
│       ├── disconnect-classifier.ts  # pure error → classification
│       ├── reconnect-manager.ts      # exp backoff + rate limit
│       └── heartbeat-service.ts      # periodic passive probe
└── tests/
    └── *.spec.ts  # Vitest, mock Redis + zca-js
```

## Install and run

From the repo root:

```bash
cd zalo_service
pnpm install
pnpm build     # compile TS to dist/
pnpm start     # run compiled service
```

For development:

```bash
pnpm dev       # tsx watch
pnpm test      # vitest
pnpm typecheck # tsc --noEmit
```

## Required environment variables

See `.env.example` in this directory for the full list. Minimum to run:

```bash
ZALO_SERVICE_INTERNAL_TOKEN=<32+ chars, openssl rand -hex 32>
REDIS_URL=redis://localhost:6379
CHATWOOT_INTERNAL_URL=http://127.0.0.1:3000
```

Config is loaded via zod — missing or invalid values fail the service at startup with a readable error message.

## HTTP API

All routes except `/healthz` require the header `X-Zalo-Service-Token`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness probe |
| POST | `/login/start` | Kick off QR login, returns `{session_id}` |
| GET | `/login/status/:session_id` | Poll current state |
| GET | `/session/:session_id/health` | Single session health snapshot |
| DELETE | `/session/:session_id` | Tear down a session |
| POST | `/send` | (Phase 04 wiring from Rails — not implemented yet here) |

## Redis events published

Channel `zalo.events` — JSON envelopes validated against `src/schemas/event-schemas.ts`:

| Type | When |
|---|---|
| `qr_code` | QR image generated during login |
| `qr_expired` | QR TTL passed before scan |
| `session_ready` | Login successful, session stored |
| `session_disconnected` | Session dropped (reason + recoverable flag) |
| `message` | Incoming message from Zalo, full payload |
| `message_delivery_error` | Outbound send failed |

## Updating zca-js

`zca-js` is pinned to a specific version in `package.json`. Before upgrading:

1. Read the upstream changelog for breaking changes
2. Run the local test suite
3. Manually verify a QR login flow end-to-end
4. Commit the pin bump on a separate branch

The adapters in `src/zalo/` deliberately wrap zca-js behind small interfaces so upstream changes only touch a handful of files.

## Development notes

### Dev mode restarts

`pnpm dev` uses `tsx watch` which restarts the process on file changes. **This drops any active Zalo WebSocket sessions**, forcing a re-login. For long-running dev sessions, prefer `pnpm build && pnpm start` when testing session persistence.

### Testing without a real Zalo account

Tests mock `zca-js` entirely. The fake factory in `tests/zalo-login-flow.spec.ts` replays the full login callback event sequence synchronously so state machine transitions can be asserted without a network call.

For manual end-to-end testing you need a real Zalo account and the Zalo mobile app.

### Log redaction

`src/logger.ts` configures pino to redact sensitive fields. If you add new log calls with cookies/imei/tokens, make sure the redact path list covers them — do not rely on "I'll remember to not log that".

## Known limitations

- **Single process per deployment.** Running multiple zalo_service instances will cause duplicate sessions to fight over the same Zalo account (Zalo kicks the older session). HA requires leader election which is not implemented.
- **No persistent queue for events.** Published events are fire-and-forget. If Redis is down or crashes between the Zalo event and Rails subscriber processing, the event is lost. Acceptable for v1.
- **Heartbeat is passive-first.** We only actively probe a session when incoming message traffic has been absent for 10+ minutes. This minimises bot detection fingerprints but means some disconnects are detected slowly.

## Related docs

- [`docs/integrations/zalo-personal.md`](../docs/integrations/zalo-personal.md) — admin setup + troubleshooting
- [`plans/260409-2349-zalo-personal-channel-integration/`](../plans/260409-2349-zalo-personal-channel-integration/) — full phase plan + red team review
