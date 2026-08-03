# Red Team Review — Zalo Personal Channel Integration Plan

**Date:** 2026-04-10
**Plan:** `plans/260409-2349-zalo-personal-channel-integration/`
**Reviewer role:** Hostile. Goal: kill the plan.

## TL;DR

Plan is **thoughtful but optimistic**. Major structural issues: **HA is an afterthought**, **account isolation is broken on internal API**, **several assumptions about zca-js API are unverified**, **effort massively underestimated post-decision-updates**, **several security holes**, **many new edge cases uncovered**. Not a blocker for start, but **~30 findings must be addressed before production**.

**Recommendation:** Do NOT ship to production as-is. Fix HIGH findings before Phase 04. Fix MEDIUM before Phase 08. LOW can be logged as follow-up.

---

## CRITICAL (blocks start)

### C1. Multi-Rails-pod deployment breaks entire inbound flow
**Where:** Phase 04
**Issue:** `ZaloEventSubscriber` is a single process, but Chatwoot in production runs **N Rails pods** (horizontal scale). Plan assumes 1 Rails instance. If deployed with 3 replicas:
- Either 3 subscribers → 3× duplicate job enqueue → 3× duplicate messages (dedup only works partially because jobs race on `source_id` uniqueness check)
- Or 1 subscriber on 1 pod → that pod down → all inbound Zalo dead silently

**Why it's critical:** This is the default deployment model for Chatwoot users at any scale. Plan silently breaks them.

**Fix:** Use **Redis Streams + consumer group** instead of pub/sub (at-least-once with single-consumer-per-group guarantee). Or leader election via Redis lock for pub/sub approach. Either way, must be in Phase 04 not v2.

### C2. Internal API has NO account authorization
**Where:** Phase 03, `Internal::ZaloSessionsController`
**Issue:** Auth is just a shared token. Any holder of the token can:
- Read cookies of ANY session across ALL accounts
- Modify session status of any session
- Delete any account's session

Plan says "localhost constraint + token" but that's defense against external attackers. **Insider threat** (compromised dev machine, leaked token in repo, CI/CD pipeline) = account boundary gone.

**Why it's critical:** Multi-tenant Chatwoot installations mix multiple customers. Token leak = all Zalo accounts exposed.

**Fix:**
- Include `account_id` + HMAC signature in every request
- Per-session scoped tokens (generated per session, not shared global)
- Audit log every internal API call

### C3. `to_node_payload` returns cookies in plaintext over HTTP
**Where:** Phase 03 model code
**Issue:** `ZaloSession#to_node_payload` returns `cookies: cookies` which triggers AR decryption. Over localhost HTTP (plain). Any process on host reading network = full cookie leak.

**Fix:** 
- Either encrypt in transit (HTTPS even localhost, mTLS)
- Or Node holds cookies in memory only, never round-trip
- Or re-encrypt with ephemeral key per request

### C4. zca-js API assumptions unverified
**Where:** Phase 01, 02, 06
**Issue:** Plan uses `api.listener.on('message')`, `api.listener.on('close')`, `api.listener.on('error')`, `api.getUserInfo(ownId)`, `zalo.loginQR({ onQrcodeGenerated, ... })`. **None verified against actual zca-js source/docs.** If any signature differs, Phase 01-06 rewrites.

**Fix:** Before Phase 01 code, spawn research task: read zca-js source + README + multizlogin usage + existing bridge projects → document actual API surface. Pin version.

---

## HIGH

### H1. Effort massively underestimated
**Where:** plan.md ("2-3 weeks")
**Issue:** Original estimate was for reduced scope (no proxy UI, no group chat, optional encryption). After user decisions: +proxy management UI + group chat full support + mandatory encryption + reconnect banner. These each add significant work.

**Realistic estimate (brutal):**
- Phase 01: 2d
- Phase 02: 4-5d (zca-js verification + multi-session + QR flow real)
- Phase 03: 2-3d (+ proxy model + encryption enforcement)
- Phase 04: 4-5d (+ group handling + config rate limit + circuit breaker)
- Phase 05: 6-8d (QR UI + proxy CRUD UI + reconnect banner + group labels + ActionCable subscription)
- Phase 06: 3-4d (logout detection + auto-reconnect + heartbeat + health monitor)
- Phase 07: 5-7d (60+ edge cases actually implemented, not just listed)
- Phase 08: 2-3d (Dockerfile multi-stage + docs)
- Phase 09: 5-7d (tests for all above)

**Total: 33-44 days = 7-9 weeks** for 1 senior dev. 2-3 weeks is delusional.

**Fix:** Update plan timeline. Consider v1 MVP scope reduction.

### H2. Startup circular dependency
**Where:** Phase 02, 04
**Issue:** Node boots → wants to restore sessions → calls Rails internal API → Rails may not be ready (still loading gems, running migrations). Plan says "retry with backoff" but:
- Max retries not defined → infinite loop if Rails never responds
- Rails migration pending = `zalo_sessions` table doesn't exist yet → Rails returns 500 → Node treats as transient → retries forever
- No ordering in Procfile → Rails and Node start concurrently

**Fix:** Node MUST:
- Wait for Rails `/api/v1/health` before starting restore
- Hard timeout 60s → fail fast
- Separate "ready but empty" state vs "restore complete" state

### H3. Regex classifier is fragile
**Where:** Phase 06
**Issue:** `if (/401|403|unauthorized/...)` matches string errors from zca-js. zca-js may throw structured errors with `code` field. Regex may match user content ("unauthorized access" in customer message). On first Zalo error message change (locale, wording), classification breaks → everything "unknown" → treated recoverable → retry storm.

**Fix:** Classify by structured error code or exception class, not message text. Fallback to "unknown" → treat as non-recoverable to prevent loops.

### H4. Heartbeat amplifies ban risk
**Where:** Phase 06
**Issue:** Every 60s, call `api.getUserInfo(ownId)` per session. 20 sessions = 20 req/min = 28,800 req/day per Zalo account. Plus message traffic. Zalo sees predictable polling pattern → **fingerprint for bot detection**. Plan's ban mitigation (proxy) only hides IP, not behavior.

**Fix:** 
- Heartbeat via WebSocket ping (no HTTP call)
- Randomize interval 60-120s
- Only active probe if suspicious signal (no message in X hours)

### H5. Migration to `channel_zalo.zalo_own_id UNIQUE` blocks multi-account Chatwoot setup
**Where:** Phase 03
**Issue:** Unique index on `zalo_own_id` globally. But decision 5 says "multi-session per Chatwoot account = yes". What about 2 different Chatwoot accounts wanting to share 1 Zalo business phone (e.g., dev env + prod env testing)? Unique constraint blocks.

**Fix:** Composite unique `(account_id, zalo_own_id)`.

### H6. Node child process memory leaks = Procfile restart loop
**Where:** Phase 01, 08
**Issue:** zca-js keeps WS state, event listeners, response buffers per session. If leak → Node OOM → Procfile restarts → sessions restore → leak again. No memory limit, no restart rate limit, no alert. Silent death.

**Fix:**
- Monitor heap with `process.memoryUsage()`
- Hard restart policy: max 3 restarts in 10 min → alert + stop trying
- Separate Procfile entry with exponential backoff

### H7. Re-login with different Zalo account collision
**Where:** Phase 06
**Issue:** User clicks "Reconnect" on Channel::Zalo (own_id=A), but scans QR with Zalo account B by mistake. Node tries to update existing ZaloSession → but `channel_zalo.zalo_own_id` is A, new login is B → unique constraint violation OR silent accept wrong account.

**Fix:**
- Display expected `own_id` before confirming re-login
- Detect mismatch → reject with clear error, require "Replace account" confirmation

### H8. Proxy SSRF validator is hard to get right
**Where:** Phase 05, 07
**Issue:** Plan says "deny RFC1918 unless explicit". Missing: link-local 169.254/16, loopback 127/8 + ::1, multicast 224/4, CGNAT 100.64/10, IPv6 ULA fc00::/7, cloud metadata 169.254.169.254. Also DNS rebinding: validate at save time, attacker changes DNS at use time.

**Fix:** Use vetted library (e.g., `ssrf_filter` gem already in Gemfile!). Validate both at save AND at connection time.

### H9. Multiple subscribers / scaling breaks without warning
**Where:** Phase 04
**Issue:** Even with C1 fixed, if admin naively scales `zalo_listener` process to 2 → both subscribe to same channel → duplicate processing. Plan doesn't document "do not scale this process" anywhere.

**Fix:** Document loudly. Add runtime check on start: register in Redis with unique key, exit if duplicate found.

### H10. Rails cache backend assumption
**Where:** Phase 04
**Issue:** `Rails.cache.write("zalo:qr:#{session_id}", qr_base64, ...)` — assumes Rails.cache is Redis-backed. If deploy uses `file_store` or `memory_store`, frontend polling from different web worker won't see the cached QR. Chatwoot default varies by install.

**Fix:** Either bypass cache + always query Node (adds 1 HTTP hop but reliable), or write directly to Redis with `Redis.current` explicitly.

---

## MEDIUM

### M1. Monorepo structure not defined
**Where:** Phase 01
**Issue:** `pnpm --filter zalo_service build` implies pnpm workspace. But Chatwoot doesn't have `pnpm-workspace.yaml`. Adding it affects ALL existing frontend builds. Or make `zalo_service/` standalone pnpm project, but then `bin/setup` must cd+install separately.

**Fix:** Standalone `zalo_service/` with own lockfile, no workspace changes. Document in Phase 08.

### M2. Dev mode tsx watch drops Zalo sessions on every file save
**Where:** Phase 01, 08
**Issue:** `pnpm dev` with `tsx watch` restarts Node on file save. Active Zalo WS sessions die → user re-scans QR during development → very painful.

**Fix:** Dev mode should NOT auto-restart when `src/sessions/*` or `src/zalo/*` change. Or use nodemon with ignore patterns.

### M3. Group chat scope underestimated
**Where:** Phase 07 group edge cases
**Issue:** v1 group chat now supported, but:
- Chatwoot's conversation model assumes 1 contact per conversation. Group = N members. How are they represented?
- Contact identity for group members across conversations?
- Agent replies as bot → how to attribute in UI?
- Member list storage: inline JSON on conversation or separate table?
- Active Chatwoot features (assignment, labels, SLA) may not fit group semantics

Plan lists edge cases but doesn't design the data model. **This is a separate subsystem**.

**Fix:** Write dedicated design doc for group chat data model. Maybe defer to v1.5.

### M4. Proxy UI management = extra phase worth of work
**Where:** Phase 05
**Issue:** CRUD page + form + validation + "test connection" button + status badges + encrypted password handling = non-trivial Vue component. Estimate allocates it to Phase 05 alongside QR flow + reconnect banner = Phase 05 bloated.

**Fix:** Split into `phase-05a-qr-flow.md` and `phase-05b-proxy-management.md`.

### M5. No observability plan
**Where:** All phases
**Issue:** Zero metrics defined. No Prometheus exporter, no StatsD, no tracing. Phase 06 mentions "dashboard" generically. Production debugging will be log-grep.

**Fix:** Add Phase 10 or fold into 08: metrics spec (messages/sec/session, reconnect count, latency histograms, queue depth, error rate).

### M6. No runbook
**Where:** Phase 08 docs
**Issue:** Admin docs say "how to setup". Missing: "how to debug when it breaks". Runbook should cover: session stuck in pending, duplicate messages, lost messages, Node crash loop, Rails session reconcile, how to force-delete stuck session.

**Fix:** Add runbook section to docs.

### M7. No audit log
**Where:** Phase 03, 06
**Issue:** Who created Channel::Zalo? Who triggered re-login? Who deleted? No audit trail. GDPR/compliance gap.

**Fix:** Use `audited` gem (Chatwoot may already have) or custom audit events on model callbacks.

### M8. ActionCable auth not specified
**Where:** Phase 06
**Issue:** Reconnect banner subscribes to `account_#{id}` channel. How is ActionCable authenticated in Chatwoot? Not verified. May broadcast cookies inadvertently.

**Fix:** Audit payload → only send non-sensitive status. Never put session cookies in broadcast.

### M9. Backup/restore scenario
**Where:** Missing
**Issue:** Postgres restored from backup → cookies encrypted with old key or stale cookies → Zalo rejects → all sessions fail silently → admin scratches head.

**Fix:** Document + add health check that detects stale session vs key mismatch.

### M10. Missing i18n for error messages
**Where:** Phase 06, 07
**Issue:** Error messages from zca-js are likely English/Vietnamese → users of other locales see untranslated text. Classification by regex also breaks on locale change.

**Fix:** Structured errors, not string matching. Translate via i18n keys.

### M11. Rails encryption initialization not in Procfile.dev setup flow
**Where:** Phase 08
**Issue:** New devs clone repo → run `bin/setup` → missing `ACTIVE_RECORD_ENCRYPTION_*` → try create Zalo channel → refuse with cryptic error. Plan says "refuse with clear message" but doesn't specify setup flow adds these keys automatically.

**Fix:** `bin/setup` runs `rails db:encryption:init` if not configured, writes keys to `.env` (with warning to rotate).

### M12. Edge case 4.3 (QR race) mitigation unclear
**Where:** Phase 07
**Issue:** "Lock sessionId" — where? In Node memory (lost on restart)? In Redis (TTL?)? In DB (slow)?

**Fix:** Specify: Redis SET NX with 130s TTL (> QR 120s + buffer).

### M13. Message recall data loss
**Where:** Phase 07
**Issue:** Message recall = soft delete. But if agent already read + responded, recall creates weird UX. Also audit/compliance: legal hold might require preserving all messages incl. recalled.

**Fix:** Config per account: recall handling = ignore | soft delete | flag only.

### M14. Dockerfile stage 2 copies node_modules blindly
**Where:** Phase 08
**Issue:** Copies `node_modules` from alpine build → into Debian/Ubuntu runtime → native modules (C++ addons in zca-js deps) may not match glibc → crash on start.

**Fix:** Run `pnpm install --prod` in stage 2 (runtime platform), not copy from stage 1.

### M15. Zca-js license unchecked
**Where:** All
**Issue:** zca-js may be GPL → incompatible with Chatwoot MIT. Or may have "no commercial use" clause. Legal risk if merged to upstream Chatwoot.

**Fix:** Verify zca-js LICENSE file + document in plan.

---

## LOW

### L1. Countdown 120s is slightly off from actual Zalo QR TTL
Real Zalo QR TTL unverified. Plan guesses 120s. Should measure + set shorter client-side for safety.

### L2. Polling 1.5s per user × many users stresses Rails
At 100 concurrent QR scans = 4000 req/min Rails. Acceptable but noted.

### L3. Attachment upload order not specified
If 3 attachments in 1 message, send order matters for UX. Plan doesn't say.

### L4. No rate limit on internal API from Rails → Node
Compromised Rails could flood Node with `POST /send`. Low priority (trust boundary).

### L5. Timestamp clock skew
Phase 07 says "use server time". But server time of what? Rails server? Node server? Zalo server? Different timezones/drift. Should use Zalo `ts` field when available, Rails `created_at` as fallback.

### L6. No Zalo API version pinning
Zalo Web protocol may change silently. Plan relies on zca-js keeping up. Add monitoring for "zca-js test suite pass rate" (external signal).

### L7. Procfile `zalo_listener` Ruby process = slow startup
Every Ruby process boots entire Rails env (~5-10s). 5 Ruby processes at Procfile = slow overmind start. Consider consolidating listener into Sidekiq.

### L8. Vue 2 remnants?
Chatwoot is migrating Vue 2 → 3. Plan assumes Vue 3 Composition API, which is current. Double-check component dir uses Vue 3 (most of settings/* now yes).

### L9. Frontend polling should use exponential backoff
When status stuck at `scanning`, frontend polls at same rate. Better: ramp down to 3-5s after 20s in scanning state.

### L10. Empty metadata JSONB column default
`metadata JSONB DEFAULT '{}'` in Postgres: every row stores `'{}'`. Fine, but consider `NULL` default if rarely used → index smaller.

---

## Missing Topics (add to plan)

### X1. Migration strategy from upstream Chatwoot
Chatwoot releases every 2-4 weeks. This fork will diverge. How to merge upstream?
- Keep `zalo_service/` + all changes in EE overlay → easier merge
- Namespace all new env vars `ZALO_*`
- Minimize changes to core files (routes.rb, inboxes_controller.rb have 1 line each)
- Document upstream merge process

### X2. Legal/brand risk
Using personal Zalo via zca-js is **Zalo TOS violation**. Chatwoot is an open-source brand. If this integration ships upstream:
- Zalo could send C&D to Chatwoot Inc
- Chatwoot users get accounts banned, blame Chatwoot
- Bad press

**Recommend:** Keep in fork (chattize) only, not upstream. Document legal position clearly.

### X3. Chaos testing
Kill Node mid-send. Kill Rails mid-subscribe. Kill Redis. Plan must verify recovery. Phase 09 mentions chaos test but no scenarios listed.

### X4. Load testing baseline
Before going to prod: 10 sessions, 100 msg/min each. Measure: latency P99, CPU, memory, queue depth, Zalo ban rate.

### X5. Data retention policy
Deleted sessions: keep cookies? For how long? Encrypted but still sensitive.

### X6. Feature flag to disable entirely
Admin should be able to disable Zalo channel globally without uninstalling. Plan has `ZALO_SERVICE_ENABLED=false` env, but need feature flag in Chatwoot UI too.

### X7. Multi-language message content
Zalo messages may contain Vietnamese with diacritics, Chinese, emoji. Encoding to Chatwoot DB (UTF-8 assumed but verify) + Captain AI (if enabled) understanding + search indexing.

---

## Positive Observations

Not all bad. What the plan does WELL:
- Clear phase breakdown with dependencies
- Edge case catalog is comprehensive (though needs implementation detail)
- Logout detection flow well thought out
- Preserves Channel::Zalo.id on re-login = good UX
- Embeds Node service in monorepo = good UX for user
- Uses existing Chatwoot patterns (Channelable, ActionCable, Sidekiq)
- Clear separation of concerns: Node = protocol, Rails = business logic, Vue = UI
- Mandatory encryption is right call
- Proxy + rate limit configurable = scale-ready
- Test plan scope reasonable

## Priority Fix Order

### Must fix before Phase 01 starts
- **C4**: Verify zca-js actual API (1-2h research)
- **X2**: Decide legal scope (fork-only vs upstream)

### Must fix in Phase 03
- **C1**: Redis Streams + consumer group (not pub/sub)
- **C2**: Per-session scoped tokens + account validation
- **C3**: Don't send plaintext cookies over HTTP
- **H5**: Composite unique index

### Must fix before Phase 08 (production)
- **H1**: Update timeline estimate → 7-9 weeks
- **H2**: Startup dependency ordering + hard timeout
- **H3**: Structured error classification
- **H4**: Heartbeat via WS ping + jitter
- **H6**: Memory monitoring + restart policy
- **H7**: Re-login account mismatch detection
- **H8**: Use `ssrf_filter` gem
- **H9**: Duplicate listener detection on start
- **H10**: Bypass Rails.cache for QR
- **M5**: Observability spec
- **M6**: Runbook
- **M7**: Audit log
- **M14**: Dockerfile native modules

### Nice to fix v1, can defer
- All M others
- All L
- X3-X7

---

## Unresolved Questions from Red Team

1. Is zca-js license compatible? (LICENSE file check needed)
2. Is this fork-only or upstream PR target?
3. What's actual Chatwoot deployment scale (1 pod vs N pods)?
4. Is Rails.cache Redis-backed in target deployment?
5. Does Chatwoot already have audit log infra (gem `audited`)?
6. What's the actual zca-js API surface vs plan assumptions?
7. Memory budget per Node process in production?
8. How does Chatwoot auth ActionCable? Cookie-based? Token?
9. Group chat — where does member list live? Needs separate design.
10. What's the acceptable message loss rate? 0%? 0.01%? Determines at-least-once vs exactly-once.

---

## Verdict

**Plan grade: B-**

Solid foundation, thoughtful structure, but **multiple CRITICAL issues** (HA, account isolation, cookie transport, unverified zca-js). **Underestimated effort** means schedule slip + feature cuts. **Missing operational concerns** (observability, runbook, audit, chaos) means production surprise.

**Greenlight to start Phase 01 IF:**
1. Legal scope decided (fork-only recommended)
2. zca-js API verified (spawn research task first)
3. Timeline re-baselined to 7-9 weeks
4. Criticals C1-C3 planned for Phase 03/04 explicitly

**Red flag:** If user pushes "let's just ship in 2 weeks" → this plan becomes tech debt generator. Budget realistic time or cut scope (drop group chat OR proxy UI OR reconnect banner).

---

**Status:** DONE
**Summary:** Adversarial review found 4 CRITICAL, 10 HIGH, 15 MEDIUM, 10 LOW findings + 7 missing topics. Most impactful: multi-pod HA broken (C1), account isolation broken on internal API (C2), cookie plaintext over HTTP (C3), unverified zca-js API assumptions (C4), effort underestimated 3x (H1). Plan is not fatally flawed but requires 30+ fixes before production. Recommend re-baseline timeline to 7-9 weeks, verify zca-js API before Phase 01, make fork-only decision explicit.
