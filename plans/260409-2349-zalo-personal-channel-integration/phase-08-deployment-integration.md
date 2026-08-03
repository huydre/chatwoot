# Phase 08 — Deployment Integration (Procfile, Docker, Docs)

## Context Links
- Plan: [plan.md](./plan.md)
- Prev: [phase-07-edge-cases.md](./phase-07-edge-cases.md)
- Next: [phase-09-tests.md](./phase-09-tests.md)

## Overview
- **Priority:** P0 (blocks merge)
- **Status:** Todo
- **Description:** Consolidate deployment — Procfile dev/prod, multi-stage Dockerfile, env sample, first-run setup script, docs cho user. Goal: `overmind start -f Procfile.dev` và `docker compose up` đều up toàn bộ không cần bước riêng.

## Key Insights
- Chatwoot image hiện tại chỉ chạy Rails — cần thêm Node runtime + build step
- Multi-stage Dockerfile: stage 1 build Node service, stage 2 build Rails, stage 3 slim runtime
- Dev: `zalo` process dùng `tsx` watch mode
- Prod: `zalo` process chạy compiled `dist/`
- Keep Node service optional: nếu `ZALO_SERVICE_ENABLED=false` → Procfile skip + Rails skip initializer

## Requirements

### Functional
- `overmind start -f Procfile.dev` → 5 process: backend, worker, vite, zalo, zalo_listener
- `docker compose up` → same
- `bin/setup` hoặc `make bootstrap` → setup initial (node deps + DB + env template)
- `.env.example` có đầy đủ Zalo env vars + comments
- Docs: `docs/integrations/zalo-personal.md` cho admin

### Non-Functional
- Build time increase acceptable (<2 min extra)
- Image size increase (<200MB extra for Node runtime)
- Zero breaking change cho user không dùng Zalo

## Architecture

### Procfile.dev update
```
backend: bin/rails s -p 3000
worker:  dotenv bundle exec sidekiq -C config/sidekiq.yml
vite:    bin/vite dev
zalo:    cd zalo_service && pnpm dev
zalo_listener: bundle exec rake zalo:subscribe
```

### Procfile (production)
```
web:  bundle exec rails s -p ${PORT:-3000}
worker: bundle exec sidekiq -C config/sidekiq.yml
zalo: node /app/zalo_service/dist/index.js
zalo_listener: bundle exec rake zalo:subscribe
```

### Dockerfile (multi-stage)
```dockerfile
# Stage 1: build zalo_service
FROM node:24-alpine AS zalo-builder
WORKDIR /build/zalo_service
RUN corepack enable
COPY zalo_service/package.json zalo_service/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY zalo_service/ ./
RUN pnpm build && pnpm prune --prod

# Stage 2: Rails + Node runtime
FROM ruby:3.4.4 AS app
# ... existing Chatwoot setup ...

# Copy built zalo_service
COPY --from=zalo-builder /build/zalo_service/dist /app/zalo_service/dist
COPY --from=zalo-builder /build/zalo_service/node_modules /app/zalo_service/node_modules
COPY --from=zalo-builder /build/zalo_service/package.json /app/zalo_service/package.json

# Install Node runtime (already needed by Chatwoot for assets)
# Node 24 via nodesource or apt

CMD ["./docker-entrypoint.sh"]
```

### docker-compose.yaml update
- No new service needed — process runs inside `rails` container via Procfile
- OR optional: split `zalo` into separate service for scaling

### .env.example addition
```bash
# ===========================
# Zalo Personal Channel
# ===========================
# Enable Zalo channel integration (requires Node.js service)
ZALO_SERVICE_ENABLED=true

# URL to reach Zalo Node service from Rails (usually localhost)
ZALO_SERVICE_URL=http://127.0.0.1:4567

# Port the Node service listens on
ZALO_SERVICE_PORT=4567

# Shared secret between Rails and Node service
# Generate with: openssl rand -hex 32
ZALO_SERVICE_INTERNAL_TOKEN=

# URL Rails exposes for Node to call back (session persistence)
CHATWOOT_INTERNAL_URL=http://127.0.0.1:3000

# Max Zalo sessions per Node process (hard cap for memory safety)
ZALO_MAX_SESSIONS_PER_PROCESS=50

# Outbound rate limit per session (messages per minute)
ZALO_OUTBOUND_RATE_LIMIT_PER_MINUTE=20

# Default proxy (optional, per-session override via UI)
# ZALO_DEFAULT_PROXY=http://user:pass@host:port
```

## Related Code Files

### To create
- `docs/integrations/zalo-personal.md` — admin setup guide
- `zalo_service/README.md` — developer guide for zalo_service
- `zalo_service/Dockerfile` (alternative standalone build)
- `bin/zalo_service_build` — helper script to build before Rails deploys

### To modify
- `Procfile.dev`
- `Procfile` (production)
- `docker/Dockerfile` (main Chatwoot Dockerfile)
- `docker-compose.yaml`
- `.env.example`
- `bin/setup` — add `pnpm install + build zalo_service` step
- `README.md` — mention Zalo channel in features list

## Implementation Steps

1. **Update Procfile.dev**:
   - Add `zalo` and `zalo_listener` lines
   - Verify overmind starts all 5 processes

2. **Create production Procfile** if not exists
   - Same format but compiled paths

3. **Update main Dockerfile** with multi-stage:
   - Stage 1: Node builder for zalo_service
   - Stage 2: Rails + copy artifacts from stage 1
   - Ensure Node runtime available in final image

4. **`bin/setup` update**:
   - After `bundle install && pnpm install`:
     ```bash
     if [ -f zalo_service/package.json ]; then
       echo "Installing zalo_service dependencies..."
       (cd zalo_service && pnpm install && pnpm build)
     fi
     ```

5. **`.env.example`** — add Zalo section

6. **User-facing docs** (`docs/integrations/zalo-personal.md`):
   - Introduction + TOS warning
   - Prerequisites (encryption keys, Node.js)
   - Setup steps: env vars, first run, scan QR
   - Troubleshooting: session expired, can't connect, rate limited
   - Known limitations: no group chat v1, ban risk
   - Re-login flow

7. **Developer docs** (`zalo_service/README.md`):
   - Architecture diagram
   - How to run standalone (dev debugging)
   - How to add new event type
   - How to update zca-js version
   - Testing guide

8. **Smoke test checklist:**
   - [ ] Fresh clone → `bin/setup` → `overmind start -f Procfile.dev` → all 5 process up
   - [ ] Fresh `docker compose up --build` → Rails responds, Node responds
   - [ ] Add Zalo inbox via UI → QR shown → scan → success
   - [ ] Send/receive message → visible in both directions
   - [ ] Restart `docker compose restart` → session restored, no re-login needed
   - [ ] Kill Node container → Rails detects disconnect → notification
   - [ ] Restart Node → session restored

9. **Performance check:**
   - Docker image size before/after
   - Startup time before/after
   - Memory footprint per Node process with 5 sessions

10. **Cleanup:**
    - Ensure all new env vars documented
    - Remove any dev-only hacks
    - Verify `rubocop` + `eslint` clean
    - Verify `brakeman` clean

## Todo List

- [ ] Update `Procfile.dev` with zalo + zalo_listener
- [ ] Create/update production `Procfile`
- [ ] Update `docker/Dockerfile` multi-stage
- [ ] Update `docker-compose.yaml` if needed
- [ ] Update `.env.example` with Zalo section
- [ ] Update `bin/setup` with zalo_service install step
- [ ] Write `docs/integrations/zalo-personal.md`
- [ ] Write `zalo_service/README.md`
- [ ] Run smoke test checklist end-to-end
- [ ] Image size before/after comparison
- [ ] Benchmark startup time
- [ ] Verify zero regression when `ZALO_SERVICE_ENABLED=false`
- [ ] Update root `README.md` features list

## Success Criteria

1. `overmind start -f Procfile.dev` launches 5 processes (4 existing + zalo)
2. `docker compose up --build` works from clean state
3. `.env.example` has all Zalo vars documented
4. Admin can follow `docs/integrations/zalo-personal.md` and succeed
5. `ZALO_SERVICE_ENABLED=false` → Rails skips Zalo init, no errors
6. Docker image size increase < 200MB
7. Startup time increase < 10s
8. Smoke test 100% pass

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Node runtime conflict với Chatwoot asset build | Use same Node version (.nvmrc) |
| Dockerfile breaks Chatwoot upstream merge | Minimal diff, document clearly |
| Procfile process ordering | Order matters: Redis/DB first, then Rails, then Zalo |
| Windows dev compat | Document Linux/Mac only for Zalo service (known Chatwoot limitation anyway) |

## Security Considerations

- `.env.example` has placeholder tokens, never real
- Docs warn about TOS + ban risk prominently
- Documented how to rotate internal token

## Next Steps

→ **Phase 09**: Comprehensive tests (unit, integration, E2E)
