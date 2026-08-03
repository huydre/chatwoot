# Phase 04 — Rails Services + Redis Listener

## Context Links
- Plan: [plan.md](./plan.md)
- Prev: [phase-03-rails-channel-model.md](./phase-03-rails-channel-model.md)
- Next: [phase-05-vue-ui-qr-flow.md](./phase-05-vue-ui-qr-flow.md)
- Reference: `app/services/telegram/incoming_message_service.rb`, `send_on_telegram_service.rb`

## Overview
- **Priority:** P0
- **Status:** Todo
- **Description:** Complete Rails-side business logic — send outbound tin Zalo (call Node HTTP), handle inbound tin (from Redis pub/sub), QR proxy API cho frontend poll. Wire Redis subscriber trong initializer để spawn background listener process (sidekiq-compatible).

## Key Insights

- **Telegram pattern** cho inbound (`Telegram::IncomingMessageService`): build contact → conversation → message → attachments. Sẽ mirror pattern này cho Zalo với `Zalo::IncomingMessageService`.
- **Redis subscriber** không thể chạy trong web process (blocking). **2 options:**
  - (A) Dedicated Sidekiq job với infinite loop + heartbeat
  - (B) Separate Procfile process `zalo_listener: bundle exec rails runner "ZaloEventSubscriber.start"`
  - **Choice: (B)** — cleaner isolation, auto restart via overmind
- **Outbound** dùng HTTParty (đã có trong Gemfile) → POST tới `ZALO_SERVICE_URL/send`
- **QR flow:** Frontend **không gọi Node trực tiếp**. Gọi Rails → Rails proxy tới Node. Lý do: Node không expose public, Rails đã có auth + session context.

## Requirements

### Functional

**Outbound services:**
- `Zalo::SendOnZaloService` (inherit `Base::SendOnChannelService`):
  - Build payload { session_id, thread_id, thread_type, content, attachments, reply_to }
  - POST `ZALO_SERVICE_URL/send` với internal token
  - Handle response: success → update `message.source_id`, failure → mark message failed + external_error
  - Retry on 5xx/timeout (3 attempts, exponential backoff)

**Inbound services:**
- `Zalo::IncomingMessageService(inbox:, payload:)`:
  - Build/find contact (via `ContactInboxWithContactBuilder`)
  - Build/find conversation
  - Build message with attachments
  - Handle edge cases: duplicate by `source_id` (Zalo msg_id), group vs 1:1, reactions

**QR proxy API** (for frontend):
- `POST /api/v1/accounts/:id/channels/zalo/login` → proxy to Node `POST /login/start`, return `{ session_id }`
- `GET /api/v1/accounts/:id/channels/zalo/login/:session_id` → proxy to Node `GET /login/status/:id`
- `POST /api/v1/accounts/:id/channels/zalo/:session_id/relogin` → trigger re-login flow
- `DELETE /api/v1/accounts/:id/channels/zalo/:session_id` → delete session
- Auth: standard Chatwoot user auth (agent/admin)

**Redis event subscriber:**
- Subscribe channel `zalo.events`
- On message: enqueue appropriate Sidekiq job
  - `zalo.events: { type: 'message' }` → `Zalo::ProcessInboundMessageJob.perform_later(payload)`
  - `zalo.events: { type: 'session_disconnected' }` → `Zalo::HandleDisconnectJob.perform_later(...)`
  - `zalo.events: { type: 'session_ready' }` → `Zalo::ConfirmSessionReadyJob.perform_later(...)`
  - `zalo.events: { type: 'qr_code' }` → cache in Redis with TTL 120s (frontend pull)
  - `zalo.events: { type: 'message_delivery_error' }` → log + notify agent
- Graceful shutdown on SIGTERM

### Non-Functional
- Outbound HTTP timeout: 15s
- Inbound job processing: < 500ms per message
- Redis subscriber: 1 single-threaded process, restart on crash via overmind
- At-least-once delivery (idempotent via Zalo msg_id)

## Architecture

### Files

```
app/services/zalo/
├── send_on_zalo_service.rb           # outbound
├── incoming_message_service.rb        # inbound main
├── node_api_client.rb                 # HTTParty wrapper cho zalo_service
├── qr_login_service.rb                # frontend-facing QR proxy
├── attachment_download_service.rb     # download attachment URL from Node/Zalo
└── param_helpers.rb                   # parse Node payload

app/controllers/api/v1/accounts/channels/
└── zalo_controller.rb                 # user-facing QR flow API

app/jobs/zalo/
├── process_inbound_message_job.rb
├── handle_disconnect_job.rb
├── confirm_session_ready_job.rb
└── delivery_error_job.rb

app/workers/
└── zalo_event_subscriber.rb           # Redis subscribe loop

config/initializers/
└── zalo_channel.rb                    # log warning if not encrypted, load config

lib/tasks/
└── zalo.rake                          # zalo:subscribe task for Procfile process
```

### Redis subscriber pattern

```ruby
# lib/workers/zalo_event_subscriber.rb
module ZaloEventSubscriber
  CHANNEL = 'zalo.events'.freeze
  
  def self.start
    Rails.logger.info "[ZaloSubscriber] starting"
    redis = Redis.new(url: ENV.fetch('REDIS_URL'))
    
    trap('TERM') { Rails.logger.info "[ZaloSubscriber] SIGTERM, exiting"; exit 0 }
    trap('INT')  { exit 0 }
    
    redis.subscribe(CHANNEL) do |on|
      on.message do |_channel, payload|
        process_event(payload)
      end
    end
  rescue StandardError => e
    Rails.logger.error "[ZaloSubscriber] crash: #{e.class}: #{e.message}"
    sleep 2
    retry
  end
  
  def self.process_event(raw)
    event = JSON.parse(raw)
    case event['type']
    when 'message'
      Zalo::ProcessInboundMessageJob.perform_later(event)
    when 'session_ready'
      Zalo::ConfirmSessionReadyJob.perform_later(event)
    when 'session_disconnected'
      Zalo::HandleDisconnectJob.perform_later(event)
    when 'qr_code'
      # Cache QR base64 for frontend poll
      Rails.cache.write("zalo:qr:#{event['session_id']}", event['qr_base64'], expires_in: 120)
    when 'message_delivery_error'
      Zalo::DeliveryErrorJob.perform_later(event)
    else
      Rails.logger.warn "[ZaloSubscriber] unknown event type: #{event['type']}"
    end
  rescue JSON::ParserError, StandardError => e
    Rails.logger.error "[ZaloSubscriber] process error: #{e.message}"
  end
end
```

### Procfile update (Phase 08 will consolidate):
```
zalo_listener: bundle exec rake zalo:subscribe
```

### Rake task wrapper:
```ruby
# lib/tasks/zalo.rake
namespace :zalo do
  desc 'Subscribe to Redis events from zalo_service'
  task subscribe: :environment do
    require Rails.root.join('lib/workers/zalo_event_subscriber')
    ZaloEventSubscriber.start
  end
end
```

## Related Code Files

### To create
- `app/services/zalo/send_on_zalo_service.rb`
- `app/services/zalo/incoming_message_service.rb`
- `app/services/zalo/node_api_client.rb`
- `app/services/zalo/qr_login_service.rb`
- `app/services/zalo/attachment_download_service.rb`
- `app/services/zalo/param_helpers.rb`
- `app/controllers/api/v1/accounts/channels/zalo_controller.rb`
- `app/jobs/zalo/process_inbound_message_job.rb`
- `app/jobs/zalo/handle_disconnect_job.rb`
- `app/jobs/zalo/confirm_session_ready_job.rb`
- `app/jobs/zalo/delivery_error_job.rb`
- `lib/workers/zalo_event_subscriber.rb`
- `lib/tasks/zalo.rake`
- `config/initializers/zalo_channel.rb`

### To modify
- `config/routes.rb` — add:
  ```ruby
  # inside namespace :api → namespace :v1 → resources :accounts
  scope :channels do
    post 'zalo/login', to: 'channels/zalo#start_login'
    get 'zalo/login/:session_id', to: 'channels/zalo#login_status'
    post 'zalo/:session_id/relogin', to: 'channels/zalo#relogin'
    delete 'zalo/:session_id', to: 'channels/zalo#destroy'
  end
  ```
- `Procfile.dev` — add `zalo_listener: bundle exec rake zalo:subscribe`

### Reference (read-only)
- `app/services/telegram/incoming_message_service.rb` — mirror pattern for contact/conversation builder
- `app/services/telegram/send_on_telegram_service.rb` — pattern for outbound
- `app/services/base/send_on_channel_service.rb` — parent class contract

## Implementation Steps

1. **`Zalo::NodeApiClient`** — HTTParty wrapper
   ```ruby
   class Zalo::NodeApiClient
     include HTTParty
     headers 'Content-Type' => 'application/json'
     open_timeout 5
     read_timeout 15
     
     def initialize
       @base = ENV.fetch('ZALO_SERVICE_URL', 'http://127.0.0.1:4567')
       @token = ENV.fetch('ZALO_SERVICE_INTERNAL_TOKEN')
     end
     
     def send_message(payload)
       post('/send', payload)
     end
     
     def start_login(opts = {})
       post('/login/start', opts)
     end
     
     def login_status(session_id)
       get("/login/status/#{session_id}")
     end
     
     def delete_session(session_id)
       request(:delete, "/session/#{session_id}")
     end
     
     private
     
     def post(path, body)
       request(:post, path, body: body.to_json)
     end
     
     def get(path)
       request(:get, path)
     end
     
     def request(method, path, **opts)
       opts[:headers] = { 
         'Content-Type' => 'application/json',
         'X-Zalo-Service-Token' => @token 
       }
       self.class.send(method, "#{@base}#{path}", **opts)
     end
   end
   ```

2. **`Zalo::SendOnZaloService`**
   ```ruby
   class Zalo::SendOnZaloService < Base::SendOnChannelService
     private
     
     def channel_class
       Channel::Zalo
     end
     
     def perform_reply
       payload = build_payload
       response = Zalo::NodeApiClient.new.send_message(payload)
       
       if response.success?
         message.update!(source_id: response.parsed_response['message_id'])
       else
         message.update!(status: :failed, external_error: response.parsed_response['error'])
       end
     rescue HTTParty::Error, Net::OpenTimeout, Errno::ECONNREFUSED => e
       message.update!(status: :failed, external_error: "zalo service unreachable: #{e.message}")
     end
     
     def build_payload
       {
         session_id: channel.zalo_session.session_id,
         thread_id: message.conversation.additional_attributes['zalo_thread_id'],
         thread_type: message.conversation.additional_attributes['zalo_thread_type'] || 0,
         content: message.outgoing_content,
         attachments: message.attachments.map { |a| serialize_attachment(a) },
         reply_to: message.content_attributes['in_reply_to_external_id']
       }
     end
     
     def serialize_attachment(attachment)
       {
         type: attachment.file_type,
         url: attachment.file_url,  # Active Storage URL, accessible by Node via HTTP
         filename: attachment.file.filename.to_s
       }
     end
     
     def channel
       @channel ||= message.inbox.channel
     end
   end
   ```

3. **`Zalo::IncomingMessageService`** — mirror Telegram pattern
   - `initialize(inbox:, payload:)`
   - `perform`: set_contact → set_conversation → build message → attach media
   - Dedup: `return if inbox.messages.exists?(source_id: payload['msg_id'])`
   - Group check: skip group messages trong v1 (thread_type != 0)

4. **`Zalo::ParamHelpers`** module — extract:
   - `zalo_msg_id`, `zalo_thread_id`, `zalo_thread_type`, `zalo_from_id`, `zalo_from_name`, `zalo_content`, `zalo_attachments`, `zalo_timestamp`
   - Works on parsed Node event payload

5. **`Zalo::ProcessInboundMessageJob`**
   ```ruby
   class Zalo::ProcessInboundMessageJob < ApplicationJob
     queue_as :default
     
     def perform(event)
       channel = Channel::Zalo.joins(:zalo_session)
                              .find_by(zalo_sessions: { session_id: event['session_id'] })
       return unless channel
       return unless channel.inbox && channel.account.active?
       
       Zalo::IncomingMessageService.new(inbox: channel.inbox, payload: event['payload']).perform
     end
   end
   ```

6. **`Zalo::ConfirmSessionReadyJob`**
   ```ruby
   class Zalo::ConfirmSessionReadyJob < ApplicationJob
     def perform(event)
       session = ZaloSession.find_by(session_id: event['session_id'])
       return unless session
       session.update!(status: 'ready', last_connected_at: Time.current)
       session.channel_zalo.update!(zalo_own_id: event['own_id']) if session.channel_zalo.zalo_own_id.blank?
       # Broadcast via ActionCable để UI update
       Rails.cache.write("zalo:session_status:#{session.session_id}", 'ready', expires_in: 5.minutes)
     end
   end
   ```

7. **`Zalo::HandleDisconnectJob`**
   ```ruby
   class Zalo::HandleDisconnectJob < ApplicationJob
     def perform(event)
       session = ZaloSession.find_by(session_id: event['session_id'])
       return unless session
       session.update!(status: 'disconnected', last_seen_at: Time.current)
       # Notify account admins via Chatwoot notification system
       Notification::ZaloSessionDisconnectedJob.perform_later(session)
       # See Phase 06 for full logout handling
     end
   end
   ```

8. **`Zalo::QrLoginService`** (frontend-facing proxy)
   ```ruby
   class Zalo::QrLoginService
     def initialize(account:)
       @account = account
     end
     
     def start(opts = {})
       response = Zalo::NodeApiClient.new.start_login(opts.merge(account_id: @account.id))
       raise 'Zalo service unavailable' unless response.success?
       response.parsed_response
     end
     
     def status(session_id)
       # Try cache first (populated by subscriber)
       cached_qr = Rails.cache.read("zalo:qr:#{session_id}")
       cached_status = Rails.cache.read("zalo:session_status:#{session_id}")
       
       if cached_qr && cached_status != 'ready'
         return { status: 'qr_ready', qr_base64: cached_qr }
       end
       
       # Fallback: query Node
       response = Zalo::NodeApiClient.new.login_status(session_id)
       response.parsed_response
     end
   end
   ```

9. **`Api::V1::Accounts::Channels::ZaloController`** — thin controller
   ```ruby
   class Api::V1::Accounts::Channels::ZaloController < Api::V1::Accounts::BaseController
     def start_login
       authorize! :create, ::Inbox
       result = Zalo::QrLoginService.new(account: Current.account).start
       render json: result
     end
     
     def login_status
       authorize! :create, ::Inbox
       result = Zalo::QrLoginService.new(account: Current.account).status(params[:session_id])
       render json: result
     end
     
     # relogin, destroy similar
   end
   ```

10. **Subscriber initializer**
    - `config/initializers/zalo_channel.rb`:
      ```ruby
      Rails.application.config.after_initialize do
        unless Chatwoot.encryption_configured?
          Rails.logger.warn '[Zalo] AR encryption not configured. Cookies will be stored plain. Set ACTIVE_RECORD_ENCRYPTION_* env vars.'
        end
      end
      ```

11. **Rake task + Procfile wire**

12. **Smoke test:**
    - Start Rails + Sidekiq + Node + listener
    - `redis-cli PUBLISH zalo.events '{"type":"message","session_id":"x","payload":{...}}'`
    - Verify Sidekiq job enqueue + process (log)

## Todo List

- [ ] Implement `Zalo::NodeApiClient`
- [ ] Implement `Zalo::SendOnZaloService`
- [ ] Implement `Zalo::ParamHelpers`
- [ ] Implement `Zalo::IncomingMessageService`
- [ ] Implement `Zalo::AttachmentDownloadService`
- [ ] Implement `Zalo::QrLoginService`
- [ ] Implement all 4 Sidekiq jobs
- [ ] Implement `ZaloEventSubscriber` + rake task
- [ ] Implement `Api::V1::Accounts::Channels::ZaloController`
- [ ] Add routes
- [ ] Add initializer with encryption warning
- [ ] Update `Procfile.dev` — thêm `zalo_listener` process
- [ ] Manual smoke test: pub event → job run → message created
- [ ] Unit tests for services + jobs
- [ ] Request specs for controller

## Success Criteria

1. Publish test event → Sidekiq process → Message record created in DB
2. Send outbound: create Message via Rails console → Node service receives HTTP POST
3. QR flow: frontend call → Rails → Node → cache → poll return QR
4. Session disconnect event → notification triggered
5. Subscriber restart gracefully on SIGTERM (test manually)
6. Encryption warning logged if env not set
7. All specs pass, RuboCop clean

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Subscriber process die silently | Overmind auto-restart, health check, log to stderr |
| Redis connection flap | Rescue + retry with sleep |
| Node service down when sending | Fail message with clear error, Sidekiq will retry |
| Duplicate inbound message | Dedup by Zalo `source_id` unique per inbox |
| Attachment URL from Rails → Node localhost → 401 | Node fetches via ActiveStorage public URL or signed URL (config). Use `url_for(attachment, host: FRONTEND_URL)` |
| Event payload schema drift | Version field in event, Rails validates shape before enqueue |

## Security Considerations

- Internal token on all Rails↔Node calls
- Don't log full payload (may contain PII from customer)
- QR base64 cached in Redis with short TTL (120s)
- Controller uses existing Pundit authorization

## Next Steps

→ **Phase 05**: Vue UI — channel card, QR scan component, polling, create-inbox redirect
