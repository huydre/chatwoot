# Zalo Personal Channel

> ⚠️ **Unofficial integration.** Zalo Personal is NOT an official Zalo API. This integration uses [zca-js](https://github.com/RFS-ADRENO/zca-js) to reverse-engineer Zalo Web. Using it **violates Zalo's Terms of Service** and your account **may be banned**. For production customer support, use Zalo Official Account (OA) + Zalo Business API instead. Use this only at your own risk.

## Overview

The Zalo Personal channel lets Chatwoot receive and send messages through a personal Zalo account by logging in via QR code, the same way Zalo Web works. It is implemented as a Node.js sidecar (`zalo_service/`) embedded in this monorepo, bridged to Rails via Redis pub/sub and localhost HTTP.

From the user's perspective, Zalo is a native channel like Telegram or Line.

## Architecture

```
┌──────────────────────── 1 Chatwoot deployment ──────────────────────────┐
│                                                                          │
│  Procfile processes:                                                     │
│    backend  (Rails)                                                      │
│    worker   (Sidekiq)                                                    │
│    vite     (frontend dev)                                               │
│    zalo     (Node.js sidecar, zalo_service/)  ← new                      │
│    zalo_listener (Ruby Redis subscriber)      ← new                      │
│                                                                          │
│  ┌─────────────┐    Redis pub/sub    ┌──────────────────────┐            │
│  │ Rails       │◄─────────────────────┤ zalo_service (Node)  │            │
│  │             │  localhost HTTP      │                      │            │
│  │ Channel::   ├─────────────────────►│ • zca-js wrapper     │            │
│  │   Zalo      │                      │ • QR login flow      │            │
│  │ Sidekiq     │                      │ • Session manager    │            │
│  │   jobs      │                      │ • Reconnect manager  │            │
│  │             │                      │ • Heartbeat probe    │            │
│  └─────────────┘                      └──────┬───────────────┘            │
│                                              │                            │
│                                              ▼                            │
│                                      Zalo WebSocket                       │
└──────────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **Ruby 3.4.4** + **Node 24 LTS** (both required by base Chatwoot)
2. **Postgres 14+** and **Redis** running
3. **Active Record Encryption keys configured** — Zalo channels refuse to be created otherwise. Generate once:
   ```bash
   bundle exec rails db:encryption:init
   ```
   then copy the output into your `.env`:
   ```
   ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=...
   ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=...
   ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=...
   ```

## Environment variables

Set in `.env` (all required unless marked optional):

```bash
# Enable/disable Zalo service
ZALO_SERVICE_ENABLED=true

# URL Rails uses to reach the Node sidecar (localhost only)
ZALO_SERVICE_URL=http://127.0.0.1:4567
ZALO_SERVICE_HOST=127.0.0.1
ZALO_SERVICE_PORT=4567

# Shared secret — generate with: openssl rand -hex 32
ZALO_SERVICE_INTERNAL_TOKEN=<required, at least 16 chars>

# URL Node uses to call Rails internal API for session persistence
CHATWOOT_INTERNAL_URL=http://127.0.0.1:3000

# Hard cap on concurrent Zalo sessions per Node process (memory safety)
ZALO_MAX_SESSIONS_PER_PROCESS=50

# (Optional) default outbound rate limit per session, messages/minute
ZALO_OUTBOUND_RATE_LIMIT_PER_MINUTE=20

# (Optional) allow proxies to point at internal networks (dev only)
ZALO_PROXY_ALLOW_INTERNAL=false
```

## First run

```bash
# Install dependencies
bundle install
pnpm install
(cd zalo_service && pnpm install && pnpm build)

# Prepare database (runs all Zalo migrations)
bundle exec rails db:chatwoot_prepare

# Start everything (backend, worker, vite, zalo, zalo_listener)
overmind start -f Procfile.dev
```

Open http://localhost:3000 and log in as admin.

## Adding a Zalo inbox

1. Dashboard → **Settings → Inboxes → Add Inbox**
2. Click the **Zalo** card
3. Read the TOS warning, then click **Start QR Login**
4. A QR code appears. Scan it with the Zalo mobile app (Menu → Settings → Devices → Login on Computer)
5. Confirm the login on your phone when prompted
6. The inbox is created automatically and you are redirected to assign agents

## Session lifecycle

| State | Meaning |
|---|---|
| `pending` | Session created, waiting for QR generation |
| `qr_ready` | QR code available, waiting for scan |
| `scanning` | QR scanned, waiting for phone confirmation |
| `confirmed` | Login info received, persisting cookies |
| `ready` | Active and receiving messages |
| `disconnected` | Temporary disconnect, auto-reconnect in progress |
| `expired` | Cookies invalid or banned, manual re-login required |
| `failed` | Login flow failed before completion |

## Re-login (expired session)

If Zalo expires your cookies or you log out from another device, the session moves to `expired`. The admin sees a notification in the Chatwoot bell icon. To fix:

1. Settings → Inboxes → click your Zalo inbox
2. Click **Reconnect** (button added in Phase 06)
3. Scan the new QR with the same Zalo account

The existing conversation history is preserved — only the session cookies are refreshed.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "ActiveRecord encryption keys must be configured" on channel create | Missing encryption env vars | Run `rails db:encryption:init` and set the 3 env vars |
| `ServiceUnreachableError: zalo_service unreachable` | Node sidecar not running | Check `zalo` process in overmind, verify `ZALO_SERVICE_URL` |
| QR code never appears | Node can't reach Zalo (proxy, firewall) | Check `zalo` process logs for network errors |
| QR scans but stays in `scanning` forever | Phone never confirmed login | Tap "Confirm login" in Zalo mobile app, or retry |
| Session flips to `expired` immediately after login | Cookies rejected by Zalo | Zalo may have anti-bot flagged the IP; try a proxy |
| Messages stop arriving | Listener died silently | Check `zalo_listener` process logs + run `Zalo::HealthMonitorJob.perform_now` |
| Outbound send fails with `zalo_rate_limit_exceeded` | Too many messages in 60s | Adjust `ZALO_OUTBOUND_RATE_LIMIT_PER_MINUTE` or the channel override |
| Outbound send fails with `zalo_circuit_open` | 3 failures in 60s tripped the breaker | Investigate root cause, wait 5min for auto-reset, or force with `Zalo::CircuitBreaker.record_success(session_id)` |

## Known limitations (v1)

- **Not scalable across multiple Rails pods.** The Redis subscriber is single-process; deploying 2+ Rails replicas will duplicate inbound jobs. A post-v1 upgrade to Redis Streams + consumer groups is needed for HA (red team finding C1).
- **Personal account only.** No support for Zalo OA (Official Account).
- **Not E2E tested against a live Zalo account in CI.** Requires manual QR scan.
- **Group chat supported but with reduced feature set** — member list polish deferred.
- **Proxy management via env only.** Full CRUD UI for proxies deferred to Phase 05b.
- **Reconnect banner UI not yet implemented.** Admin sees a Chatwoot notification instead.

## Operational commands

```bash
# Check session health
bundle exec rails runner "ZaloSession.find_each { |s| puts \"#{s.session_id} #{s.status}\" }"

# Force health check for all ready sessions
bundle exec rails runner "Zalo::HealthMonitorJob.perform_now"

# Manually mark a session expired
bundle exec rails runner "ZaloSession.find_by(session_id: 'SID').update!(status: 'expired')"

# Reset circuit breaker for a session
bundle exec rails runner "Zalo::CircuitBreaker.record_success('SID')"

# Check rate limit budget
redis-cli get zalo:rate:SID
```

## Security notes

- Session cookies and IMEI are encrypted at rest via Active Record Encryption.
- The internal API between Rails and Node is token-authenticated and locked to localhost via route constraint.
- Cookies are transferred plaintext over localhost HTTP (documented red team finding C3); production hardening should add mTLS.
- SSRF-protected: proxies cannot point at loopback, RFC1918, link-local, CGNAT, or IPv6 ULA ranges unless `ZALO_PROXY_ALLOW_INTERNAL=true`.
- Pino log redaction strips cookies, IMEI, and internal tokens from Node logs.

## Compliance and legal

**Important**: Before enabling Zalo Personal for any customer-facing use:

1. Review [Zalo's Terms of Service](https://zalo.me/pc)
2. Understand that automating personal accounts is **prohibited** and may result in account bans
3. For legitimate customer support, use [Zalo Official Account](https://oa.zalo.me/) with their official API
4. Ensure your compliance team is aware of the integration
