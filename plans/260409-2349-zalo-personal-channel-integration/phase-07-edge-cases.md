# Phase 07 — Edge Cases & Hardening

## Context Links
- Plan: [plan.md](./plan.md)
- Prev: [phase-06-logout-detection-reconnect.md](./phase-06-logout-detection-reconnect.md)
- Next: [phase-08-deployment-integration.md](./phase-08-deployment-integration.md)

## Overview
- **Priority:** P1
- **Status:** Todo
- **Description:** Cover tất cả edge case đã identify ở các phase trước + edge case mới phát sinh từ hardening thực tế. Mỗi edge case → test case → mitigation code.

## Edge Case Catalog

### Category 1: Message Delivery

| # | Edge Case | Impact | Mitigation |
|---|---|---|---|
| 1.1 | Duplicate inbound message (Zalo gửi 2 lần) | Duplicate conversation entries | Dedup by `source_id` = Zalo `msg_id`; unique index on `(inbox_id, source_id)` in `messages` table |
| 1.2 | Out-of-order messages arrive | UI shows wrong order | Use Zalo `ts` (timestamp) for ordering, not arrival time; store in `messages.created_at` |
| 1.3 | Message sent before session ready | Fail silently | Queue outbound in Sidekiq, retry when session ready; max wait 5 min → fail |
| 1.4 | Outbound fail due to Zalo rate limit | Subsequent sends also fail | Circuit breaker: if 3 fails in 60s → pause outbound 5 min, mark messages queued |
| 1.5 | Customer deletes message on Zalo side | Chatwoot still shows it | Subscribe `message_recalled` event → soft delete in Chatwoot with indicator |
| 1.6 | Customer edits message | Chatwoot shows old version | Subscribe `message_edited` → update existing message `content` + flag `edited: true` |
| 1.7 | Long message (>2000 chars) | Zalo rejects | Split into chunks or fail with clear error |
| 1.8 | Empty message (attachment-only) | Build fail: content blank | Use placeholder or set content_type accordingly |
| 1.9 | Message from deleted thread | Contact orphaned | Gracefully create contact, flag thread as stale |
| 1.10 | Agent sends while customer typing | UX concern only | No-op; Chatwoot doesn't show typing to Zalo |

### Category 2: Attachments

| # | Edge Case | Impact | Mitigation |
|---|---|---|---|
| 2.1 | Large file (>25MB) | Memory blow | Stream download + upload, reject > Chatwoot limit |
| 2.2 | Unsupported media type (Zalo sticker) | Crash parser | Map to `file_type: image` with URL, or fallback text `[Sticker]` |
| 2.3 | Attachment URL expires before download | Missing file | Download immediately in Node, cache locally temp file, then forward |
| 2.4 | Voice message | Audio handling | `file_type: audio`, ffmpeg convert if needed |
| 2.5 | GIF vs image | Display issue | `file_type: image`, browser handles GIF natively |
| 2.6 | Location share | Non-media | `file_type: location`, store lat/long in attachment meta |
| 2.7 | Contact card share | Non-media | `file_type: contact`, store name/phone in meta |
| 2.8 | File with special chars in name | S3 URL encoding issues | Sanitize filename via `ActiveStorage::Filename` |
| 2.9 | Attachment download timeout from Zalo CDN | Missing file | Timeout 60s, mark message with error attachment |
| 2.10 | Outbound attachment > Zalo limit (20MB) | Send fail | Pre-check file size before POST to Node |

### Category 3: Contact & Conversation

| # | Edge Case | Impact | Mitigation |
|---|---|---|---|
| 3.1 | Same Zalo user → 2 different Chatwoot accounts | Duplicate contact | Scope contacts per inbox (already standard) |
| 3.2 | Customer changes display name on Zalo | Stale name in Chatwoot | Update on each incoming if differs + flag |
| 3.3 | Customer changes avatar | Stale avatar | Refresh avatar every 7 days via job |
| 3.4 | Group chat (thread_type=1) | **v1 supported** | Create conversation with `additional_attributes.zalo_thread_type=1`, sender = member who sent, UI labels as "Group" |
| 3.5 | Group member joined | Missing contact | Subscribe `group_member_added` event → update conversation metadata |
| 3.5a | Group member left | Stale list | Subscribe `group_member_removed` → update metadata |
| 3.5b | Group renamed | Stale title | Subscribe `group_name_changed` → update conversation title |
| 3.5c | Group with 100+ members | UI perf | Paginate member list display, lazy load |
| 3.5d | Agent reply to group | Who to attribute | Post as Zalo own user, appears to all members |
| 3.5e | Mention in group | Need notification | Parse `@mention` in content, add `has_mention` flag |
| 3.6 | Conversation resolved then reopen on new msg | Chatwoot has `lock_to_single_conversation` | Use existing mechanism |
| 3.7 | Contact has no name | Blank display | Fallback `Zalo User #{own_id.last(6)}` |
| 3.8 | Conversation with self (Zalo allows) | Infinite loop | Ignore `msg.isSelf === true` in listener |
| 3.9 | Phone number not exposed | Missing contact data | Use `zalo_user_id` as `identifier`, phone optional |
| 3.10 | Two-way linked bot account | Infinite echo | Strict `isSelf` filter + message_type source check |

### Category 4: Session & Auth

| # | Edge Case | Impact | Mitigation |
|---|---|---|---|
| 4.1 | Cookie corruption in DB | Can't decrypt | Catch DecryptionError → mark expired → force re-login |
| 4.2 | Cookie size exceeds column size | Save fail | Use `TEXT` column (unlimited) |
| 4.3 | 2 users scan QR simultaneously (race) | 1 wins, 1 sees ghost session | Lock sessionId, reject 2nd scan gracefully |
| 4.4 | QR code scanned by wrong Zalo account (not intended one) | Inbox linked to wrong account | Show `own_id` in UI before confirm "Save" step |
| 4.5 | Scan QR but never confirm on phone | Session stuck `scanning` | Timeout 120s total, force expire |
| 4.6 | Session restored but cookies work for ~1 call then fail | Intermittent | Classifier detects 401 → mark expired on first auth fail |
| 4.7 | Multiple Node instances race on startup restore | Duplicate session connections | Redis lock: `SET zalo:session:<id>:lock NX EX 60` before attach |
| 4.8 | Account deleted but session still running | Orphan listener | On channel delete → DELETE session (cascade trigger) |
| 4.9 | IMEI mismatch on re-login | Zalo rejects | Persist stable IMEI per session; generate once |
| 4.10 | User disables account (Chatwoot) | Session keeps running | HealthMonitor skips disabled accounts; Chatwoot auto-stop |

### Category 5: Concurrency & Race

| # | Edge Case | Impact | Mitigation |
|---|---|---|---|
| 5.1 | 2 inbound messages from new contact simultaneously | 2 contact records | DB unique constraint on `(inbox_id, source_id)` for contact; retry on conflict |
| 5.2 | Send + disconnect race | Message marked sent but not delivered | Ack via Zalo response; fallback: message status 'sending' → Sidekiq retry |
| 5.3 | Reconnect triggers while health check running | Both attempt to re-auth | Mutex per session in Node |
| 5.4 | Rails job retry runs after session deleted | Error cascading | Guard at job start: `return unless ZaloSession.exists?` |
| 5.5 | Multiple Rails subscribers (scaled) | Each processes same event | Redis pub/sub is broadcast — use single subscriber OR use consumer group (Streams) → **v1: single subscriber process**, no HA |
| 5.6 | Sidekiq worker crash mid-job | Message lost | Sidekiq retry semantics; idempotency by source_id |
| 5.7 | Clock skew between Node and Rails | Wrong timestamps | Use server time (Rails.current_time) not Node time |
| 5.8 | User deletes inbox during active conversation | Dangling ZaloSession | Cascade delete; confirm dialog on delete |

### Category 6: Rate Limiting & Resource

| # | Edge Case | Impact | Mitigation |
|---|---|---|---|
| 6.1 | Outbound burst → Zalo rate limit | Account flag | Token bucket: max 20 msg/min/session configurable |
| 6.2 | Many sessions on 1 Node process | Memory exhaustion | Max 50 sessions/process cap (hard limit via env) |
| 6.3 | QR login abuse (DoS) | Service overwhelmed | Rate limit POST /login/start: max 5/min/account |
| 6.4 | Heartbeat storm on startup | Hammer Zalo | Jitter startup checks over 60s |
| 6.5 | Redis pub/sub flood | Message loss | Use Redis Streams in v2, v1 accept loss risk |
| 6.6 | Sidekiq queue backlog | Processing lag | Monitor queue depth, alert if > 1000 |

### Category 7: Network & Transport

| # | Edge Case | Impact | Mitigation |
|---|---|---|---|
| 7.1 | Node crash between receive and publish | Message lost | Accept loss (document); v2 add outbox pattern |
| 7.2 | Rails restart during event processing | Sidekiq job in-flight lost | Sidekiq retry (3x default) |
| 7.3 | Partial JSON in Redis pub (fragmented) | Parse fail | Redis guarantees atomic publish; still try/catch |
| 7.4 | Zalo server maintenance | Wide-scale disconnect | Catch + alert; auto-recovery when up |
| 7.5 | DNS resolution fail for Zalo CDN | Attachment miss | Retry with backoff, fallback to text note |
| 7.6 | Proxy misconfigured | Session stuck | Clear error msg, disable proxy on retry |

### Category 8: Security

| # | Edge Case | Impact | Mitigation |
|---|---|---|---|
| 8.1 | XSS in Zalo message content | UI attack | Chatwoot default sanitization |
| 8.2 | SQL injection via name field | DB compromise | ActiveRecord params whitelisting |
| 8.3 | Path traversal in attachment filename | FS attack | Sanitize + store via ActiveStorage (UUID filename) |
| 8.4 | SSRF via custom proxy URL | Internal network access | Validate proxy URL scheme + host; deny RFC1918 unless explicit |
| 8.5 | Internal token leaked in logs | Service compromise | Log redaction rules (Phase 01) |
| 8.6 | Cookie leaked via error message | Account compromise | Sanitize error messages before return to UI |
| 8.7 | Zalo message contains malicious link | Phishing | Display as-is; Chatwoot doesn't auto-fetch |
| 8.8 | Inbox JSON leaks cookies | Data leak | `as_json(except: [:cookies, :imei])` enforced |

## Implementation Strategy

### Phase-by-phase hardening
1. **Pass 1 (during phase 1-6):** implement happy path + obvious guards
2. **Pass 2 (this phase):** walk through the edge case catalog, fix gaps
3. **Pass 3 (red team in phase 9):** invite hostile review, fix findings

### Test strategy per category
- **Category 1-2**: integration tests with mocked zca-js events
- **Category 3**: factory-based model tests
- **Category 4**: manual + scripted session lifecycle tests
- **Category 5**: concurrent job tests (RSpec + Sidekiq inline)
- **Category 6**: load tests (k6 or artillery against Node service)
- **Category 7**: chaos testing (kill processes mid-flow)
- **Category 8**: security audit via static analysis + manual review

## Related Code Files

### To create
- `app/services/zalo/rate_limiter.rb` — token bucket for outbound
- `zalo_service/src/utils/rate-limiter.ts` — per-session rate limit
- `zalo_service/src/utils/attachment-size-guard.ts`
- `zalo_service/src/utils/proxy-validator.ts`
- `zalo_service/src/utils/session-lock.ts` — Redis-based distributed lock
- `spec/services/zalo/edge_cases_spec.rb` — table-driven edge case tests

### To modify
- `db/migrate/<ts>_add_unique_index_messages_source_id.rb` (if not exists) — enforce 1.1
- `app/services/zalo/incoming_message_service.rb` — add dedup, order, edit/recall handling
- `app/services/zalo/send_on_zalo_service.rb` — add rate limit check, circuit breaker, pre-flight validation
- `zalo_service/src/zalo/zalo-message-listener.ts` — handle message_edited, message_recalled events
- `zalo_service/src/sessions/session-bootstrap.ts` — use Redis lock for dedup
- `zalo_service/src/http/routes/send-routes.ts` — enforce rate limit + size
- `zalo_service/src/http/routes/login-routes.ts` — rate limit login start

## Implementation Steps

1. **Dedup inbound**:
   - Add unique index `(inbox_id, source_id)` (partial where source_id not null)
   - In `IncomingMessageService`: `return if inbox.messages.exists?(source_id: payload['msg_id'])`

2. **Order by Zalo timestamp**:
   - Pass `created_at: Time.at(payload['ts'])` when building Message
   - Preserve ordering via DB index

3. **Long message split**:
   - `Zalo::SendOnZaloService#perform_reply`: if `content.length > 2000` → split → send N parts → update source_id with first part id

4. **Attachment handling**:
   - Add `AttachmentDownloadService` with streaming (Down gem already used by Chatwoot)
   - Size guard before upload
   - Filename sanitization via ActiveStorage default

5. **Rate limiter (outbound)**:
   ```ruby
   class Zalo::RateLimiter
     KEY_TTL = 60
     def self.allow?(session_id, limit = 20)
       key = "zalo:rate:#{session_id}"
       count = Redis.current.incr(key)
       Redis.current.expire(key, KEY_TTL) if count == 1
       count <= limit
     end
   end
   ```

6. **Circuit breaker**:
   - Track fail count in Redis; if > 3 in 60s → set `zalo:circuit:#{session_id}` = open with TTL 5 min
   - SendOnZaloService checks circuit before send

7. **Message recall/edit**:
   - Node listener subscribes `message_recalled`, `message_edited`
   - Publish Redis events `zalo.events.message_recalled`, `.message_edited`
   - Rails job update existing Message row

8. **isSelf filter**:
   - Node listener: `if (msg.isSelf) return;` (prevent echo)
   - Verify Zalo events don't include messages we sent via API

9. **Session lock for HA restore**:
   - On startup restore, `SET lock:zalo_restore:${sessionId} ${nodeId} NX EX 60`
   - Only one Node instance attaches listener per session

10. **Proxy validator**:
    - Parse URL, allow only http/https/socks5, disallow internal IPs unless explicit env override

11. **Attachment size guard**:
    - Before download: check Content-Length header
    - Before upload to Zalo: check file size

12. **Test harness**:
    - Table-driven edge case spec in RSpec
    - Mock Zalo API with stubbed responses
    - Each row in catalog → at least 1 assertion

## Todo List

### Inbound edge cases
- [ ] 1.1 Dedup — unique index + service guard
- [ ] 1.2 Timestamp ordering
- [ ] 1.5 Message recall handling
- [ ] 1.6 Message edit handling
- [ ] 1.9 Graceful contact for stale thread
- [ ] 3.2 Name update on incoming
- [ ] 3.3 Avatar refresh job (weekly)
- [ ] 3.4 Group skip + log
- [ ] 3.7 Fallback name
- [ ] 3.8 isSelf filter

### Outbound edge cases
- [ ] 1.3 Queue outbound until ready, retry
- [ ] 1.4 Circuit breaker
- [ ] 1.7 Long message split or reject
- [ ] 1.8 Empty message handling
- [ ] 2.10 Pre-flight file size check
- [ ] 6.1 Token bucket rate limit

### Session edge cases
- [ ] 4.1 Decryption error → mark expired
- [ ] 4.3 QR race lock
- [ ] 4.4 Show own_id before confirm
- [ ] 4.5 120s total scan timeout
- [ ] 4.7 Redis lock for HA restore
- [ ] 4.8 Cascade delete
- [ ] 4.9 Stable IMEI per session

### Attachment edge cases
- [ ] 2.1 Streaming + size limit
- [ ] 2.2 Sticker fallback
- [ ] 2.3 Immediate download + cache
- [ ] 2.4 Voice handling
- [ ] 2.6 Location attachment
- [ ] 2.7 Contact card
- [ ] 2.8 Filename sanitize
- [ ] 2.9 Download timeout

### Concurrency
- [ ] 5.1 Contact uniqueness constraint
- [ ] 5.3 Mutex per session in Node
- [ ] 5.4 Job guards
- [ ] 5.6 Idempotency via source_id
- [ ] 5.8 Cascade + confirm dialog

### Rate/Resource
- [ ] 6.2 Max sessions per Node env cap
- [ ] 6.3 Login start rate limit
- [ ] 6.4 Jitter startup
- [ ] 6.6 Queue depth monitoring

### Network
- [ ] 7.2 Sidekiq retry semantics verified
- [ ] 7.5 Attachment fetch retry + fallback

### Security
- [ ] 8.2 Param whitelisting verified
- [ ] 8.3 Path traversal blocked
- [ ] 8.4 SSRF proxy validator
- [ ] 8.5 Log redaction verified
- [ ] 8.6 Error message sanitization
- [ ] 8.8 JSON serializer excludes secrets

### Testing
- [ ] Table-driven edge case spec (8 categories)
- [ ] Integration test for recall + edit flow
- [ ] Load test: 10 sessions, 50 msg/min each
- [ ] Chaos test: kill Node mid-send
- [ ] Security scan: brakeman for Rails, npm audit for Node

## Success Criteria

1. All 60+ edge cases have explicit handling or documented acceptance
2. Edge case spec: ≥ 90% pass
3. No silent data loss under chaos (kill process) testing
4. Rate limit triggers under burst, recovers cleanly
5. Security scan clean (no HIGH severity)
6. Dedup test: send 100 duplicate messages, only 1 row in DB

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Edge case list incomplete | Red team review in Phase 09; user acceptance testing |
| Over-engineered guards slow hot path | Benchmark before/after critical cases |
| Security fix breaks functionality | Each security fix has paired test |

## Decisions (finalized 2026-04-10)

1. Group chat v1 — **Yes**, full support (see Category 3 updates)
2. Message recall — **Soft delete** with UI indicator
3. Message edit history — **Overwrite** with `edited: true` flag
4. Rate limit — **Per-account config** (col on `channel_zalo.rate_limit_per_minute`), falls back to env default
5. Circuit breaker — **Auto-reset 5 min**, manual admin override via rails console

## Next Steps

→ **Phase 08**: Procfile/Dockerfile integration, docs, smoke test E2E
