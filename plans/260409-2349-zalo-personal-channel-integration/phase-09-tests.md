# Phase 09 — Tests & QA

## Context Links
- Plan: [plan.md](./plan.md)
- Prev: [phase-08-deployment-integration.md](./phase-08-deployment-integration.md)

## Overview
- **Priority:** P0 (blocks merge)
- **Status:** Todo
- **Description:** Comprehensive test suite for Zalo integration — backend (RSpec), Node service (Vitest), frontend (Vitest + Vue Test Utils), E2E happy path. Target coverage: Ruby ≥ 70%, Node ≥ 60%, UI components ≥ 50%.

## Test Matrix

### Backend (RSpec)

| File | Cases |
|---|---|
| `spec/models/channel/zalo_spec.rb` | create, associations, send_message delegate |
| `spec/models/zalo_session_spec.rb` | enum, encryption round-trip, scope active, validations |
| `spec/controllers/internal/zalo_sessions_controller_spec.rb` | auth pass/fail, localhost constraint, CRUD |
| `spec/controllers/api/v1/accounts/channels/zalo_controller_spec.rb` | start_login, status, relogin, destroy, authz |
| `spec/services/zalo/node_api_client_spec.rb` | request signing, retry, timeout, error handling |
| `spec/services/zalo/send_on_zalo_service_spec.rb` | success → source_id, failure → external_error, circuit breaker |
| `spec/services/zalo/incoming_message_service_spec.rb` | contact create, conversation create, message create, attachment, dedup, isSelf filter, group skip |
| `spec/services/zalo/qr_login_service_spec.rb` | start, status (cache hit/miss) |
| `spec/services/zalo/relogin_service_spec.rb` | preserves channel_id, new session_id |
| `spec/services/zalo/rate_limiter_spec.rb` | token bucket, reset |
| `spec/jobs/zalo/process_inbound_message_job_spec.rb` | dispatch to service, guard checks |
| `spec/jobs/zalo/handle_disconnect_job_spec.rb` | status update, notification, ActionCable |
| `spec/jobs/zalo/confirm_session_ready_job_spec.rb` | status update, own_id set |
| `spec/jobs/zalo/health_monitor_job_spec.rb` | stale detection, dispatch disconnect |
| `spec/lib/workers/zalo_event_subscriber_spec.rb` | event dispatch by type, parse error handling |

### Node service (Vitest)

| File | Cases |
|---|---|
| `tests/config.spec.ts` | env validation, missing → throw |
| `tests/logger.spec.ts` | redaction of cookies, imei, token |
| `tests/redis-client.spec.ts` | connection, pub/sub separation |
| `tests/event-publisher.spec.ts` | schema validation, Redis error swallowing |
| `tests/http/auth-middleware.spec.ts` | token match, reject |
| `tests/http/health-route.spec.ts` | status response |
| `tests/http/login-routes.spec.ts` | start, status, expired, race |
| `tests/http/send-route.spec.ts` | success, rate limit, size guard |
| `tests/sessions/session-manager.spec.ts` | CRUD, concurrent access |
| `tests/sessions/session-bootstrap.spec.ts` | restore from Rails, parallel limit, partial failure |
| `tests/sessions/session-persistence-client.spec.ts` | HTTP mocks, retry, error |
| `tests/zalo/zalo-login-flow.spec.ts` | state transitions, QR events, timeout |
| `tests/zalo/zalo-message-listener.spec.ts` | event emit, isSelf filter, edit/recall |
| `tests/reconnect/disconnect-classifier.spec.ts` | all classifications |
| `tests/reconnect/reconnect-manager.spec.ts` | backoff, rate limit, success, give-up |
| `tests/reconnect/heartbeat-service.spec.ts` | periodic check, consecutive fail |
| `tests/utils/rate-limiter.spec.ts` | token bucket |
| `tests/utils/session-lock.spec.ts` | Redis lock, expiry |

### Frontend (Vitest + Vue Test Utils)

| File | Cases |
|---|---|
| `app/javascript/dashboard/routes/dashboard/settings/inbox/channels/Zalo.spec.js` | state machine, polling, retry, redirect |
| `app/javascript/dashboard/components/channels/zalo/ZaloQrDisplay.spec.js` | render, countdown |
| `app/javascript/dashboard/components/channels/zalo/ZaloLoginStatus.spec.js` | state → text mapping |
| `app/javascript/dashboard/components/channels/zalo/ZaloConnectionBadge.spec.js` | color per status |
| `app/javascript/dashboard/api/inboxes.spec.js` | new methods |

### Integration (RSpec request specs + real Redis)

| File | Cases |
|---|---|
| `spec/integration/zalo/full_inbound_flow_spec.rb` | Redis pub → Sidekiq → message row created |
| `spec/integration/zalo/full_outbound_flow_spec.rb` | Rails send → Node receive HTTP (stubbed) |
| `spec/integration/zalo/relogin_flow_spec.rb` | disconnect → relogin → continuity |

### E2E (manual, scripted smoke test)

| Scenario | Steps |
|---|---|
| Happy path | Setup → Add inbox → Scan QR → Send/receive → Logout → Re-login |
| Restart recovery | Send messages → `docker compose restart` → Send again |
| Disconnect detection | Kill Node → wait 15 min → verify notification |
| Rate limit | Burst 25 msgs → verify 5 queued |
| Attachment | Send image, voice, file each way |
| Failed send | Node down → Rails marks failed, visible in UI |

## Requirements

- RSpec: Rails 7.1 compatible, use `rails-controller-testing`, `webmock` for HTTP mocks
- Node: Vitest 2+, `supertest` for HTTP, `ioredis-mock` for Redis
- Frontend: existing Chatwoot Vitest setup
- Fixtures: `spec/fixtures/zalo/` with sample Zalo payloads (message, attachment, recall, edit)
- CI: add test tasks to `.github/workflows/ci.yml` or equivalent

## Implementation Steps

1. **Fixtures** — capture real Zalo payload shapes (via debug log) or use synthesized:
   - `spec/fixtures/zalo/incoming_text_message.json`
   - `spec/fixtures/zalo/incoming_image_message.json`
   - `spec/fixtures/zalo/incoming_sticker.json`
   - `spec/fixtures/zalo/incoming_recall.json`
   - `spec/fixtures/zalo/incoming_edit.json`
   - `spec/fixtures/zalo/session_ready_event.json`
   - `spec/fixtures/zalo/session_disconnected_event.json`

2. **Shared specs** — `spec/support/zalo_helpers.rb`:
   - `create_zalo_channel(account)`, `create_zalo_session(channel, status:)`
   - `mock_node_api_client` with canned responses
   - `publish_zalo_event(type, payload)` helper

3. **Model specs** — standard AR tests, focus on encryption round-trip

4. **Service specs** — mock external deps (Node API, Redis)

5. **Job specs** — use `Sidekiq::Testing.inline!` for integration tests

6. **Controller specs** — request specs with auth scenarios

7. **Node tests** — Vitest with mocks for zca-js, Redis, Postgres client

8. **Frontend tests** — mock API, assert state transitions

9. **Integration tests** — real Redis (test instance), real Postgres, stubbed Node HTTP

10. **Coverage reports:**
    - Ruby: `simplecov` (existing Chatwoot setup)
    - Node: `vitest --coverage`
    - Aggregate in CI

11. **E2E smoke script** (`bin/zalo_smoke_test.sh`):
    - Requires 1 test Zalo account + manual scan
    - Automates: start services, call login API, wait for manual scan, verify message flow

## Todo List

### Setup
- [ ] Create `spec/fixtures/zalo/` with sample payloads
- [ ] Create `spec/support/zalo_helpers.rb`
- [ ] Add `webmock` stubs for Node API
- [ ] Configure Vitest in `zalo_service/vitest.config.ts`

### Backend specs (RSpec)
- [ ] Model specs: channel/zalo, zalo_session
- [ ] Internal controller spec
- [ ] API controller spec
- [ ] Service specs (5 services)
- [ ] Job specs (4 jobs)
- [ ] Event subscriber spec
- [ ] Integration specs (3 flows)

### Node specs (Vitest)
- [ ] Config, logger, Redis tests
- [ ] HTTP server + routes tests
- [ ] Session manager + bootstrap tests
- [ ] Login flow + message listener tests
- [ ] Reconnect manager + classifier tests
- [ ] Utils tests (rate limit, lock)

### Frontend specs
- [ ] Zalo.vue component test
- [ ] Sub-component tests
- [ ] API layer test
- [ ] Badge test

### E2E
- [ ] Write smoke test script
- [ ] Run on dev machine
- [ ] Document results
- [ ] Capture screenshots for docs

### Coverage & CI
- [ ] Set up coverage reporting for Node
- [ ] Verify Ruby coverage meets 70%
- [ ] Verify Node coverage meets 60%
- [ ] Add test jobs to CI workflow
- [ ] Fix any flakey tests

## Success Criteria

1. All specs pass: RSpec, Vitest (Node), Vitest (frontend)
2. Coverage thresholds met (Ruby 70%, Node 60%, UI 50%)
3. No flaky tests in 10 consecutive runs
4. E2E smoke test pass on dev machine with real Zalo account
5. CI runs clean within time budget (< 5 min added)
6. All edge cases from Phase 07 have corresponding tests
7. `rubocop` + `eslint` + `brakeman` all clean

## Risk Assessment

| Risk | Mitigation |
|---|---|
| zca-js hard to mock | Use dependency injection + interface abstraction |
| Real Zalo account needed for E2E | Accept manual step, document clearly |
| Flaky tests due to timing | Fake timers in Vitest, `travel_to` in Rails specs |
| Redis shared state across tests | Unique prefixes, flush in before hook |
| Coverage gaming (useless tests) | Code review focus on assertion quality |

## Test Data Strategy

- Use `FactoryBot` factories: `zalo_channel_factory.rb`, `zalo_session_factory.rb`
- Payloads in JSON fixtures, loaded via `json_fixture('zalo/...')` helper
- Avoid hardcoded UUIDs — use `SecureRandom.uuid` in factories
- Mock external HTTP (Node API, Zalo CDN) via `webmock`
- Never hit real Zalo API in CI

## Next Steps

After Phase 09 complete:
1. **Red team review** (`/ck:plan red-team`) — adversarial review of full plan + implementation
2. **Validation interview** — user acceptance criteria check
3. **Docs sync** — update `docs/` with new channel info
4. **Journal entry** — `/ck:journal` document what was built + lessons
5. **Ship** — merge to develop, monitor, iterate

---

# End of Plan

All 9 phases complete. Ready for user review → approval → implementation kickoff from Phase 01.
