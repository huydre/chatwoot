# Phase 06 — Logout Detection, Reconnect Flow, Session Health Monitor

## Context Links
- Plan: [plan.md](./plan.md)
- Prev: [phase-05-vue-ui-qr-flow.md](./phase-05-vue-ui-qr-flow.md)
- Next: [phase-07-edge-cases.md](./phase-07-edge-cases.md)

## Overview
- **Priority:** P0 (user explicit requirement)
- **Status:** Todo
- **Description:** Detect Zalo account bị logout/banned/cookie expire → update session status → notify admin → cho phép re-login từ UI mà không mất Inbox/conversation history. Health monitor chạy định kỳ check từng session còn sống không. Dashboard badge warning khi có session down.

## Key Insights

### Các nguyên nhân session "down" thực tế
1. **Cookie expired** — Zalo session cookie hết hạn tự nhiên (sau vài ngày-tuần không activity)
2. **Manual logout** — user logout Zalo Web từ device khác
3. **Account banned** — Zalo flag account do bot activity
4. **Multi-device conflict** — Zalo limit số session đồng thời, device mới push out device cũ
5. **Network blip** — WS disconnect tạm thời (recoverable)
6. **Node crash/restart** — service die, cần restore
7. **Password changed** — force logout all sessions
8. **Zalo server maintenance** — temporary

### Detection signals
- **From zca-js library**:
  - `api.listener.on('close')` — WS closed
  - `api.listener.on('error', err)` — auth errors từ Zalo API
  - Error codes: 401/403 khi gọi API → invalid session
- **Heartbeat active probe**: định kỳ gọi lightweight API (`getUserInfo(self)`), timeout → suspicious
- **Missing message echo**: user send message, Zalo không echo back trong X giây → suspect dead
- **Rails watchdog**: `last_seen_at` > threshold (5 min) → force health check

### Reconnect strategies
- **Auto-reconnect** (transient): cookie còn valid, chỉ network blip → zca-js built-in WS reconnect
- **Cookie refresh** (soft fail): session expired nhưng chưa banned → attempt re-auth với cookie cũ → có thể work
- **Full re-login** (hard fail): phải scan QR lại → UI hiện banner + CTA button

## Requirements

### Functional

**Node side:**

1. **Disconnect listener on every session:**
   - Wire `api.listener.on('close')` và `api.listener.on('error')` khi attach listener
   - On close: classify reason (transient vs terminal)
   - Publish Redis event `session_disconnected` với classification:
     ```json
     {
       "type": "session_disconnected",
       "session_id": "...",
       "reason": "cookie_expired|banned|network|manual|unknown",
       "recoverable": true|false,
       "timestamp": "..."
     }
     ```

2. **Auto-reconnect loop (for recoverable):**
   - If `recoverable=true` → wait backoff (5s, 15s, 60s, 300s) → retry `zalo.login(cookies)` up to 5 times
   - If all retries fail → escalate to `cookie_expired` non-recoverable → emit hard disconnect event
   - Max 5 retries per session per hour (rate limit to avoid flooding Zalo)

3. **Active heartbeat (every 60s):**
   - For each `ready` session: call `api.getUserInfo(ownId)` (lightweight)
   - Timeout 10s
   - On fail twice in a row → mark disconnected
   - Success → update `last_seen_at` via internal API

4. **Startup recovery:**
   - On boot → Rails returns all `ready` sessions → re-auth each → if fail → mark disconnected
   - **NOT** auto-prompt re-login; let user manually trigger from UI

**Rails side:**

5. **`Zalo::HandleDisconnectJob`** (extend Phase 04 stub):
   - Update `ZaloSession.status` based on reason:
     - `transient/network` → `disconnected` (auto-recovery in progress)
     - `cookie_expired/banned/manual` → `expired` (needs re-login)
   - Emit ActionCable broadcast to account admins
   - Create `Notification` record → in-app notification bell
   - Send email to account admin (optional, configurable)

6. **Re-login flow:**
   - `POST /api/v1/accounts/:id/channels/zalo/:channel_id/relogin`
   - Does NOT delete Channel::Zalo or ZaloSession row
   - Creates NEW session_id in Node, tied to same Channel::Zalo
   - On login success, Node updates existing Channel::Zalo (same `id`) with new cookies → old conversations stay linked
   - Frontend: same QR flow UI, chỉ extra param `channel_id`

7. **Session health monitor (Sidekiq cron):**
   - `Zalo::HealthMonitorJob` — runs every 5 min
   - Query `ZaloSession.where(status: 'ready').where('last_seen_at < ?', 10.minutes.ago)`
   - For each → call Node `GET /session/:id/health` → if unreachable/unhealthy → mark disconnected
   - Wire via `config/schedule.yml` hoặc `sidekiq-cron`

**UI side:**

8. **Disconnect banner in inbox list:**
   - In `SettingsContent.vue` or inbox card → show red badge + "Reconnect" button if session.status in [disconnected, expired]
   - Fetch session status via inbox details API (extend Rails to return `zalo_session_status`)

9. **Inbox settings page (Zalo tab):**
   - Show connection status + last connected at + own_id + phone number
   - Button "Reconnect" → trigger relogin flow → redirect to QR scan
   - Button "Disconnect" → confirm dialog → DELETE session (kills Zalo connection but keeps Inbox)
   - Button "Delete Inbox" → standard inbox delete

10. **Real-time UI update:**
    - ActionCable channel → account dashboard subscribes
    - When session status changes → push notification + badge refresh
    - Use existing `ConversationTypingStatus` pattern as reference

### Non-Functional
- Reconnect must not block inbound event processing for other sessions
- Auto-reconnect must not amplify load (rate limit)
- Log every state transition with timestamps
- Health check CPU overhead < 1% per 10 sessions

## Architecture

### Disconnect classification (Node)

```ts
function classifyDisconnect(error: unknown): {
  reason: string;
  recoverable: boolean;
} {
  const msg = String(error?.message || error || '');
  
  if (/401|403|unauthorized|invalid.*cookie/i.test(msg))
    return { reason: 'cookie_expired', recoverable: false };
  if (/banned|suspended|blocked/i.test(msg))
    return { reason: 'banned', recoverable: false };
  if (/password.*changed|force.*logout/i.test(msg))
    return { reason: 'manual', recoverable: false };
  if (/ECONNRESET|ETIMEDOUT|network|socket/i.test(msg))
    return { reason: 'network', recoverable: true };
  
  return { reason: 'unknown', recoverable: true }; // assume recoverable, try once
}
```

### Reconnect state machine

```
┌─────────┐  disconnect  ┌──────────────────┐
│ ready   │─────────────►│ reconnecting     │
└─────────┘              └────────┬─────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                │ recoverable     │ non-recoverable │
                ▼                 │                 ▼
         ┌─────────────┐          │          ┌──────────┐
         │ retrying    │          │          │ expired  │
         │ (backoff)   │          │          │ (await   │
         └─────┬───────┘          │          │  user)   │
               │                  │          └──────────┘
       ┌───────┼───────┐          │
       │ success       │ fail     │
       │               │ 5x       │
       ▼               ▼          │
  ┌─────────┐    ┌──────────┐     │
  │  ready  │    │ expired  │     │
  └─────────┘    └──────────┘     │
```

### ActionCable broadcast

```ruby
# app/channels/account_channel.rb — already exists for Chatwoot
# Broadcast zalo event:
ActionCable.server.broadcast(
  "account_#{account.id}",
  {
    event: 'zalo.session.disconnected',
    data: {
      inbox_id: inbox.id,
      channel_id: channel.id,
      session_status: 'expired',
      reason: 'cookie_expired',
      requires_relogin: true
    }
  }
)
```

## Related Code Files

### To create (Node)
- `zalo_service/src/reconnect/reconnect-manager.ts` — auto-reconnect logic
- `zalo_service/src/reconnect/disconnect-classifier.ts`
- `zalo_service/src/reconnect/heartbeat-service.ts` — periodic health probe
- `zalo_service/tests/reconnect-manager.spec.ts`
- `zalo_service/tests/disconnect-classifier.spec.ts`

### To create (Rails)
- `app/jobs/zalo/health_monitor_job.rb` — sidekiq cron
- `app/jobs/zalo/notification_job.rb` — send in-app + email
- `app/services/zalo/relogin_service.rb`
- `app/javascript/dashboard/components/channels/zalo/ZaloConnectionBadge.vue`
- `app/javascript/dashboard/components/channels/zalo/ZaloInboxSettings.vue`

### To modify
- `zalo_service/src/zalo/zalo-message-listener.ts` — wire disconnect handler
- `zalo_service/src/sessions/session-manager.ts` — integrate reconnect manager
- `app/jobs/zalo/handle_disconnect_job.rb` — extend with classification + notification
- `app/controllers/api/v1/accounts/channels/zalo_controller.rb` — add `relogin` action
- `app/javascript/dashboard/routes/dashboard/settings/inbox/SettingsContent.vue` — surface Zalo status
- `config/schedule.yml` or `config/sidekiq.yml` — cron entry for health monitor
- `app/views/api/v1/models/inbox/_inbox.json.jbuilder` — include `zalo_session_status` field

## Implementation Steps

1. **Classifier** (`disconnect-classifier.ts`) — pure function, unit testable

2. **Reconnect manager** (`reconnect-manager.ts`)
   - `onDisconnect(sessionCtx, error)`:
     - Classify → if recoverable → schedule retry with exponential backoff
     - If non-recoverable → mark expired, emit event, stop retries
   - Rate limit via in-memory counter `Map<sessionId, { count, resetAt }>`
   - Max 5 retries/hour/session

3. **Heartbeat service** (`heartbeat-service.ts`)
   - `setInterval(60_000, checkAll)`
   - For each ready session → call lightweight API, timeout 10s
   - On 2 consecutive failures → trigger onDisconnect(ctx, 'heartbeat_failed')

4. **Wire into session-manager** — whenever new session becomes `ready` → register with heartbeat + reconnect

5. **Rails `HandleDisconnectJob`** full implementation:
   ```ruby
   class Zalo::HandleDisconnectJob < ApplicationJob
     def perform(event)
       session = ZaloSession.find_by(session_id: event['session_id'])
       return unless session
       
       new_status = event['recoverable'] ? 'disconnected' : 'expired'
       session.update!(
         status: new_status,
         last_seen_at: Time.current,
         metadata: session.metadata.merge(
           last_disconnect_reason: event['reason'],
           last_disconnect_at: Time.current.iso8601
         )
       )
       
       return if event['recoverable'] # auto-recover in progress, don't bother user
       
       notify_admins(session, event['reason'])
       broadcast_status_change(session)
     end
     
     private
     
     def notify_admins(session, reason)
       account = session.channel_zalo.account
       account.administrators.each do |admin|
         Notification.create!(
           account: account,
           user: admin,
           notification_type: 'zalo_session_expired',
           primary_actor_type: 'Channel::Zalo',
           primary_actor_id: session.channel_zalo_id,
           secondary_actor_type: 'ZaloSession',
           secondary_actor_id: session.id,
           push_message_title: I18n.t('notifications.zalo.session_expired', 
             inbox: session.channel_zalo.inbox&.name, reason: reason)
         )
       end
     end
     
     def broadcast_status_change(session)
       account = session.channel_zalo.account
       ActionCable.server.broadcast(
         "account_#{account.id}",
         {
           event: 'zalo.session.disconnected',
           data: {
             inbox_id: session.channel_zalo.inbox&.id,
             session_status: session.status,
             reason: session.metadata['last_disconnect_reason'],
             requires_relogin: true
           }
         }
       )
     end
   end
   ```

6. **`Zalo::HealthMonitorJob`** — sidekiq cron
   ```ruby
   class Zalo::HealthMonitorJob < ApplicationJob
     queue_as :scheduled_jobs
     
     def perform
       stale = ZaloSession.where(status: 'ready')
                         .where('last_seen_at < ? OR last_seen_at IS NULL', 10.minutes.ago)
       stale.find_each do |session|
         check_session_health(session)
       end
     end
     
     private
     
     def check_session_health(session)
       response = Zalo::NodeApiClient.new.request(:get, "/session/#{session.session_id}/health")
       if response.success? && response.parsed_response['status'] == 'ready'
         session.update!(last_seen_at: Time.current)
       else
         Zalo::HandleDisconnectJob.perform_later(
           'session_id' => session.session_id,
           'reason' => 'health_check_failed',
           'recoverable' => false
         )
       end
     rescue => e
       Rails.logger.warn "[Zalo HealthMonitor] #{session.session_id}: #{e.message}"
     end
   end
   ```

7. **Sidekiq cron** — add to `config/schedule.yml` (sidekiq-cron format):
   ```yaml
   zalo_health_monitor:
     cron: '*/5 * * * *'
     class: 'Zalo::HealthMonitorJob'
     queue: scheduled_jobs
   ```

8. **`Zalo::ReloginService`** — for manual re-login from UI
   ```ruby
   class Zalo::ReloginService
     def initialize(channel:)
       @channel = channel
     end
     
     def perform
       # Start new QR session but tied to existing channel
       response = Zalo::NodeApiClient.new.start_login(
         account_id: @channel.account_id,
         existing_channel_id: @channel.id
       )
       response.parsed_response
     end
   end
   ```
   Node side: when `existing_channel_id` present → after QR success → PUT existing session instead of POST new.

9. **Zalo controller `relogin` action**
   ```ruby
   def relogin
     channel = Channel::Zalo.find(params[:channel_id])
     authorize! :update, channel.inbox
     render json: Zalo::ReloginService.new(channel: channel).perform
   end
   ```
   Route: `POST /api/v1/accounts/:id/channels/zalo/:channel_id/relogin`

10. **UI components**
    - `ZaloConnectionBadge.vue` — badge hiện status (green/yellow/red)
    - `ZaloInboxSettings.vue` — integrated into inbox settings tab
    - Listen ActionCable event via existing cable system, update local state

11. **Extend inbox JSON serializer** — include zalo session status in `/api/v1/inboxes/:id` response

12. **Test scenarios:**
    - Kill Node process → Rails detect stale session → mark disconnected
    - Zalo cookie expired (simulate) → classifier → mark expired → notification
    - Network blip → auto-reconnect succeeds → session back to ready
    - 5 failures → escalate to expired
    - User click Reconnect → new QR → scan → continuity (same inbox, same conversations)

## Todo List

### Node
- [ ] Implement `disconnect-classifier.ts` + tests
- [ ] Implement `reconnect-manager.ts` with backoff + rate limit
- [ ] Implement `heartbeat-service.ts`
- [ ] Wire disconnect handlers in `zalo-message-listener.ts`
- [ ] Integrate heartbeat into session lifecycle (start on ready, stop on delete)
- [ ] Unit tests for reconnect logic

### Rails
- [ ] Extend `HandleDisconnectJob` with classification + notification + ActionCable
- [ ] Implement `Zalo::HealthMonitorJob`
- [ ] Add sidekiq cron schedule entry
- [ ] Implement `Zalo::ReloginService`
- [ ] Add `relogin` action in zalo controller + route
- [ ] Extend inbox JSON serializer
- [ ] Add i18n for notification messages
- [ ] Request specs for controller + job

### UI
- [ ] Implement `ZaloConnectionBadge.vue`
- [ ] Implement `ZaloInboxSettings.vue`
- [ ] Integrate badge into inbox list
- [ ] Add ActionCable subscriber for zalo events
- [ ] Add i18n keys for new strings
- [ ] Test full re-login flow in UI

## Success Criteria

1. Manually kill Node → health monitor catches within 15 min → session marked disconnected
2. Simulate cookie expire → classifier mark `cookie_expired` → session status `expired` → admin sees notification
3. Network blip → auto-reconnect succeeds → session stays `ready`, admin NOT notified
4. User click Reconnect → scan new QR → existing Inbox + conversations preserved
5. Badge red khi `expired`, green khi `ready`, yellow khi `disconnected` (auto-retry)
6. Email notification sent to admin if configured
7. Real-time UI update via ActionCable, no page refresh needed

## Risk Assessment

| Risk | Mitigation |
|---|---|
| False positive disconnect (flaky network) | Require 2 consecutive fail before mark |
| Notification spam | Dedup: max 1 notification/session/hour |
| Reconnect loop infinite | Hard cap 5/hour/session |
| Race: user click Reconnect while auto-retry in progress | Cancel auto-retry when manual relogin starts |
| ActionCable Redis channel name conflict | Scope `zalo.*` prefix |
| Health check overwhelming Node | Only check ready sessions, batch with limit |
| Lost conversations on relogin | Keep Channel::Zalo.id stable, only rotate session cookies |

## Security Considerations

- Don't expose disconnect reason details (might leak Zalo internal) — map to safe user-friendly messages
- Re-login preserves conversation ownership — check authz on channel before allow relogin

## Next Steps

→ **Phase 07**: Edge cases (attachments, groups, rate limits, race conditions, message ordering, delivery guarantee)
