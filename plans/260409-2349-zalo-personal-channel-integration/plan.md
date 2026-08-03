---
name: Zalo Personal Channel Integration
status: implemented
created: 2026-04-09
owner: hnam
blockedBy: []
blocks: []
tags: [channel, zalo, enterprise, multi-process]
---

# Zalo Personal Channel — Native Chatwoot Integration

## Goal

Tích hợp **Zalo Personal** như 1 native channel trong Chatwoot (giống Telegram/Line). User thêm inbox Zalo → scan QR trong UI dashboard → tin nhắn đi/đến hoạt động như channel native. Tự detect account bị logout và prompt re-login.

## Non-Goals

- **Không** hỗ trợ Zalo OA (Official Account) — plan riêng sau
- **Không** viết lại `zca-js` bằng Ruby
- **Không** multi-tenant SaaS scaling (>50 accounts đồng thời) — kiến trúc cho phép mở rộng nhưng không hardening cho scale đó
- **Không** sửa upstream `zca-js` — dùng nguyên version pinned

## Architecture Summary

```
┌──────────────────────── 1 Chatwoot repo / 1 deploy ───────────────────────┐
│                                                                            │
│  Procfile.dev (thêm 1 dòng)                                                │
│  └─ zalo: node zalo_service/dist/index.js                                  │
│                                                                            │
│  ┌────────────────────────┐        ┌────────────────────────────────────┐ │
│  │ Rails (Ruby)           │        │ zalo_service/ (Node.js)            │ │
│  │                        │        │                                    │ │
│  │ • Channel::Zalo        │◄──Redis stream────┤ zca-js wrapper          │ │
│  │ • Zalo controllers     │                   │ Multi-session manager   │ │
│  │ • Zalo services        │   HTTP (outbound) │ QR login service        │ │
│  │ • Vue QR UI            ├──────────────────►│ Session heartbeat       │ │
│  │ • Sidekiq jobs         │                   │ Postgres session store  │ │
│  └────────────────────────┘                   └────────────────────────┘ │
│                     │                                      │              │
│                     └──────────────┬───────────────────────┘              │
│                                    ▼                                      │
│                     Postgres + Redis (share với Chatwoot)                 │
└────────────────────────────────────────────────────────────────────────────┘
```

**Key insight:** Rails cannot talk to Zalo directly (protocol needs Node). Thay vì chạy 2 service tách rời, embed Node service trong monorepo như 1 Procfile process — user vẫn chỉ chạy `overmind start`.

**Communication pattern:**
- **Node → Rails** (inbound): Redis stream `zalo.events` + consumer group `chatwoot-rails` → enqueue Sidekiq job. Was pub/sub; changed for red team C1, since pub/sub fanned out to every pod and dropped events published while no subscriber was attached.
- **Rails → Node** (outbound): HTTP POST internal `localhost:4567/send` (not exposed)

## Status — 2026-08-03

All phases are implemented and the branch is `feat/zalo-personal`. The phase
table below was never updated as work landed, so treat its checkboxes as
historical rather than current.

Red team H1 was right about the estimate: the plan said 2-3 weeks against a
scope that had already grown, and the review's 7-9 week figure was closer.
All four CRITICAL findings and the HIGH findings are now resolved, declined
with reasoning, or documented — see
[the red team review](./reports/red-team-260410-0015-plan-review.md) for
the current state of each. MEDIUM and LOW remain open.

Not yet exercised: the QR login flow against a real Zalo account.

## Phase Overview

| # | Phase | Status | File |
|---|---|---|---|
| 01 | Node service foundation (zca-js wrapper, HTTP API, Redis publisher) | 🔲 Todo | [phase-01-node-service-foundation.md](./phase-01-node-service-foundation.md) |
| 02 | Multi-session manager + Postgres session store + QR login flow | 🔲 Todo | [phase-02-session-manager-qr-login.md](./phase-02-session-manager-qr-login.md) |
| 03 | Rails `Channel::Zalo` model, migration, routes, permissions | 🔲 Todo | [phase-03-rails-channel-model.md](./phase-03-rails-channel-model.md) |
| 04 | Rails services: send/incoming/QR proxy + Redis listener | 🔲 Todo | [phase-04-rails-services-listener.md](./phase-04-rails-services-listener.md) |
| 05 | Vue UI: Zalo channel card + QR scan component + add-inbox flow | 🔲 Todo | [phase-05-vue-ui-qr-flow.md](./phase-05-vue-ui-qr-flow.md) |
| 06 | Logout detection, reconnect flow, session health monitor | 🔲 Todo | [phase-06-logout-detection-reconnect.md](./phase-06-logout-detection-reconnect.md) |
| 07 | Edge case coverage (attachments, groups, rate limits, race conditions) | 🔲 Todo | [phase-07-edge-cases.md](./phase-07-edge-cases.md) |
| 08 | Procfile/Dockerfile integration + docs + smoke test | 🔲 Todo | [phase-08-deployment-integration.md](./phase-08-deployment-integration.md) |
| 09 | Tests: RSpec backend + Vitest frontend + E2E happy path | 🔲 Todo | [phase-09-tests.md](./phase-09-tests.md) |

## Key Dependencies

- `zca-js` (unofficial Zalo Web library) — pinned version, read-only
- `ioredis` (Node Redis client) — share Redis với Chatwoot
- `pg` (Node Postgres client) — share DB với Chatwoot, hoặc gọi qua Rails API
- Rails already: ActiveRecord encryption, Sidekiq, Vue 3, Tailwind, Vuelidate

## Success Criteria (Definition of Done)

1. ✅ User thêm inbox mới → chọn "Zalo" → thấy card + mô tả
2. ✅ Click → hiện QR code → scan bằng Zalo app → login thành công → tạo Inbox + Channel
3. ✅ Customer gửi tin Zalo → hiện trong Chatwoot conversation < 3s
4. ✅ Agent reply → customer nhận < 3s
5. ✅ Attachments (ảnh) đi/đến OK
6. ✅ Restart Chatwoot → session vẫn còn, không cần re-login
7. ✅ Zalo session expire/logout → UI hiện warning, prompt re-scan QR
8. ✅ Captain AI hoạt động với Zalo channel (incoming message trigger AssistantResponse)
9. ✅ Automation rules hoạt động
10. ✅ Test coverage ≥ 70% cho Ruby, ≥ 60% cho Node service
11. ✅ 1 command `overmind start -f Procfile.dev` up toàn bộ
12. ✅ 1 command `docker compose up` up toàn bộ

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Zalo ban account | HIGH | Rate limit, proxy support (optional), warmup accounts, **clear TOS warning to user** |
| `zca-js` breaking change | MEDIUM | Pin version, abstract wrapper, monitor upstream |
| Session cookie leak | HIGH | AR encryption at rest, internal port only, no log of cookies |
| Rails/Node sync drift (dual language) | MEDIUM | TypeScript types mirror Rails schema; single source of truth in zod schema |
| Race: 2 messages same time → duplicate contact | MEDIUM | Idempotency via Zalo msg_id, DB unique constraint |
| Node service crash → lost events | MEDIUM | Redis persistent queue, zca-js auto-reconnect, Sidekiq at-least-once |
| QR expired mid-scan | LOW | Auto-regenerate every 60s in UI |
| Chatwoot webhook fails when Node forwards | LOW | Retry via Sidekiq, DLQ after N retries |

## Placement Decision

**OSS vs EE:** Place in **OSS** (`app/`) initially — no license restriction, users expect this. Enterprise can override specific behaviors via `prepend_mod_with` if needed later. Personal Zalo TOS warning lives in UI, not code location.

## Decisions (chốt 2026-04-10)

1. **Proxy support** → **UI v1** — user quản lý proxy pool qua UI, gán per session. Thêm table `zalo_proxies`, CRUD settings page, proxy selector trong QR login flow.
2. **Group chat** → **v1 support** — thread_type=1 tạo conversation tương tự 1:1, contact = bot profile của group, metadata chứa group_id, member list. UI hiển thị nhãn "Group".
3. **Rate limit** → **configurable** per-account và global. Default từ env, override qua inbox settings. Store trong `channel_zalo.rate_limit_per_minute`.
4. **Re-login UX** → **auto banner** + manual button. Banner hiện trong dashboard khi có session expired.
5. **Multi-session per Chatwoot account** → **yes**, unlimited number of Zalo numbers per account, each = separate Channel::Zalo + Inbox.
6. **Encryption** → **mandatory**. Refuse create Channel::Zalo if `Chatwoot.encryption_configured?` false. Clear error message + setup docs.
7. **Node version** → **24 LTS** (aligns with .nvmrc 24.13.0).

## Impact on phases

- **Phase 02**: QR login API accepts `proxy_id`; group thread handling in message listener
- **Phase 03**: add `zalo_proxies` table + model + migration; add `rate_limit_per_minute` col to `channel_zalo`; enforce encryption hard check
- **Phase 04**: incoming service handles group thread (thread_type=1) → create group conversation; proxy CRUD controller; rate limit uses channel config
- **Phase 05**: proxy management UI (settings page), proxy selector in Zalo.vue QR flow, group conversation UI label
- **Phase 06**: banner component persistent trong dashboard shell
- **Phase 07**: group chat edge cases promoted from "skip" to "handle" (member left, member joined, group renamed, large groups)

## Next Steps

1. Review plan này với user → confirm phạm vi + unresolved questions
2. Phase 01 → Node service foundation
3. Phase 02-09 sequential
4. Red team review sau khi xong Phase 04 (backend core) — trước khi build UI
5. Smoke test E2E cuối Phase 08
