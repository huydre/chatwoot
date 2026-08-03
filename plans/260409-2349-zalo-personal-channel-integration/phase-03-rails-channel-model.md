# Phase 03 — Rails Channel Model + Migration + Internal API

## Context Links
- Plan: [plan.md](./plan.md)
- Prev: [phase-02-session-manager-qr-login.md](./phase-02-session-manager-qr-login.md)
- Next: [phase-04-rails-services-listener.md](./phase-04-rails-services-listener.md)
- Reference: `app/models/channel/telegram.rb` (pattern gần nhất)

## Overview
- **Priority:** P0
- **Status:** Todo
- **Description:** Tạo `Channel::Zalo` Rails model + migration bảng `channel_zalo` + `zalo_sessions` + internal API controller cho Node service gọi qua. Whitelist channel type trong inbox controller. Zero business logic in phase này — chỉ model + persistence.

## Key Insights

- Chatwoot pattern: mỗi channel = 1 table riêng + `include Channelable` + link với Inbox qua polymorphic
- Telegram dùng 1 bảng `channel_telegram` với `bot_token`. Zalo phức tạp hơn vì session state (cookies, imei, status).
- **Split 3 bảng:**
  - `channel_zalo` (1 row = 1 Chatwoot Channel) — điểm mấp mối với Inbox, chứa `rate_limit_per_minute` override
  - `zalo_sessions` (1 row = 1 zca-js session state) — 1-1 với channel_zalo, FK `zalo_proxy_id` nullable
  - `zalo_proxies` (N proxies per account, reusable across sessions) — UI-managed pool
- **AR Encryption**: **MANDATORY** — refuse create channel if not configured. `encrypts :cookies, :imei` trên ZaloSession; `encrypts :password` trên ZaloProxy.
- **Internal API**: routes under `/internal/zalo_sessions/*`, auth bằng header token, skip CSRF, skip user auth
- **Group chat**: ZaloSession metadata không đủ — group info stored ở conversation `additional_attributes`

## Requirements

### Functional

**`Channel::Zalo` model:**
- Fields: `id`, `account_id`, `zalo_own_id` (nullable until login done), `display_name`, `phone_number?`, `avatar_url?`, `created_at`, `updated_at`
- Relations: `has_one :zalo_session, dependent: :destroy`, `include Channelable`
- Methods: `name`, `send_message(message)` (delegate to `Zalo::SendOnZaloService`)

**`ZaloSession` model:**
- Fields: `id`, `channel_zalo_id` (FK), `session_id` (UUID, unique), `cookies` (encrypted jsonb), `imei` (encrypted string), `user_agent`, `proxy_url?`, `status` (enum), `last_connected_at`, `last_seen_at`, `metadata` (jsonb), `created_at`, `updated_at`
- Status enum: `pending`, `qr_ready`, `scanning`, `confirmed`, `ready`, `disconnected`, `expired`, `failed`, `deleted`
- `encrypts :cookies, :imei` (deterministic: false)
- Validations: `session_id` unique, `status` in enum
- Scope: `active` (status in [pending, qr_ready, scanning, confirmed, ready])

**Internal API endpoints** (for Node service):
- `POST /internal/zalo_sessions` — Node tells Rails "I have a new session, here's the cookies"
- `GET /internal/zalo_sessions?status=active` — Node queries on startup to restore
- `GET /internal/zalo_sessions/:session_id`
- `PUT /internal/zalo_sessions/:session_id` — update cookies (refresh scenario)
- `PATCH /internal/zalo_sessions/:session_id` — status only
- `DELETE /internal/zalo_sessions/:session_id` — mark deleted

**Inbox controller whitelist:**
- Add `'zalo' => Channel::Zalo` to `channel_type_from_params` mapping
- `EDITABLE_ATTRS = [:display_name]` (không cho edit cookies qua API external)

### Non-Functional

- Migration reversible
- Foreign key constraint with cascade on channel_zalo delete
- Index on `session_id` (unique), `status`, `channel_zalo_id`
- All internal API responses < 100ms

## Architecture

### Database schema

```sql
-- Migration 1: channel_zalo
CREATE TABLE channel_zalo (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  zalo_own_id VARCHAR(255),         -- from Zalo after login; nullable pre-login
  display_name VARCHAR(255),
  phone_number VARCHAR(32),
  avatar_url TEXT,
  rate_limit_per_minute INTEGER,    -- null = use global env default
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX idx_channel_zalo_own_id ON channel_zalo(zalo_own_id) WHERE zalo_own_id IS NOT NULL;
CREATE INDEX idx_channel_zalo_account ON channel_zalo(account_id);

-- Migration 2: zalo_proxies (managed via UI)
CREATE TABLE zalo_proxies (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,          -- user-friendly label
  scheme VARCHAR(16) NOT NULL,         -- http, https, socks5
  host VARCHAR(255) NOT NULL,
  port INTEGER NOT NULL,
  username VARCHAR(255),
  password TEXT,                       -- encrypted
  status VARCHAR(32) DEFAULT 'active', -- active, disabled, dead
  last_checked_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_zalo_proxies_account ON zalo_proxies(account_id);
CREATE INDEX idx_zalo_proxies_status ON zalo_proxies(status);

-- Migration 3: zalo_sessions
CREATE TABLE zalo_sessions (
  id BIGSERIAL PRIMARY KEY,
  channel_zalo_id BIGINT NOT NULL REFERENCES channel_zalo(id) ON DELETE CASCADE,
  zalo_proxy_id BIGINT REFERENCES zalo_proxies(id) ON DELETE SET NULL,
  session_id UUID NOT NULL UNIQUE,
  cookies TEXT,                    -- encrypted JSON string
  imei TEXT,                       -- encrypted
  user_agent VARCHAR(512),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  last_connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_zalo_sessions_channel ON zalo_sessions(channel_zalo_id);
CREATE INDEX idx_zalo_sessions_status ON zalo_sessions(status);
CREATE INDEX idx_zalo_sessions_proxy ON zalo_sessions(zalo_proxy_id);
```

### Encryption enforcement

```ruby
# app/models/channel/zalo.rb
class Channel::Zalo < ApplicationRecord
  validate :encryption_must_be_configured, on: :create
  
  private
  
  def encryption_must_be_configured
    return if Chatwoot.encryption_configured?
    errors.add(:base, I18n.t('errors.zalo.encryption_required'))
  end
end
```

### Routes

```ruby
# config/routes.rb — inside scope :api
namespace :internal do
  resources :zalo_sessions, param: :session_id, except: [:new, :edit]
end
```

Mount under root `/internal/zalo_sessions/*` — no account namespacing (system-level).

### Controller

```ruby
# app/controllers/internal/zalo_sessions_controller.rb
class Internal::ZaloSessionsController < ActionController::API
  before_action :authenticate_zalo_service
  before_action :find_session, only: [:show, :update, :destroy]
  
  def index
    sessions = ZaloSession.where(status: params[:status]) if params[:status].present?
    sessions ||= ZaloSession.active
    render json: sessions.map(&:to_node_payload)
  end
  
  def show
    render json: @session.to_node_payload
  end
  
  def create
    # Called when Node finished QR login
    channel = Channel::Zalo.find_or_initialize_by(zalo_own_id: params[:own_id])
    channel.account_id = params[:account_id] if channel.new_record?
    channel.display_name = params[:display_name]
    channel.save!
    
    session = channel.build_zalo_session(
      session_id: params[:session_id],
      cookies: params[:cookies],
      imei: params[:imei],
      user_agent: params[:user_agent],
      status: 'ready',
      last_connected_at: Time.current
    )
    session.save!
    render json: session.to_node_payload, status: :created
  end
  
  def update
    @session.update!(session_params)
    render json: @session.to_node_payload
  end
  
  def destroy
    @session.update!(status: 'deleted')
    head :no_content
  end
  
  private
  
  def authenticate_zalo_service
    token = request.headers['X-Zalo-Service-Token']
    head :unauthorized unless ActiveSupport::SecurityUtils.secure_compare(
      token.to_s, ENV.fetch('ZALO_SERVICE_INTERNAL_TOKEN', '')
    )
  end
  
  def find_session
    @session = ZaloSession.find_by!(session_id: params[:session_id])
  end
  
  def session_params
    params.permit(:cookies, :imei, :user_agent, :status, :last_seen_at, metadata: {})
  end
end
```

## Related Code Files

### To create
- `db/migrate/<timestamp>_create_channel_zalo.rb`
- `db/migrate/<timestamp>_create_zalo_proxies.rb`
- `db/migrate/<timestamp>_create_zalo_sessions.rb`
- `app/models/channel/zalo.rb`
- `app/models/zalo_session.rb`
- `app/models/zalo_proxy.rb`
- `app/controllers/internal/zalo_sessions_controller.rb`
- `app/controllers/api/v1/accounts/zalo_proxies_controller.rb`
- `config/initializers/zalo_channel.rb` (register in feature list if needed)

### To modify
- `config/routes.rb` — add `namespace :internal` block + mount route for Rails→Node event proxy (if needed for QR polling) — to be wired in Phase 04/05
- `app/controllers/api/v1/accounts/inboxes_controller.rb` — add `'zalo' => Channel::Zalo` to `channel_type_from_params` (line ~174)
- `config/features.yml` — add feature flag `zalo_personal` if gating is needed
- `app/models/inbox.rb` — no change (polymorphic via Channelable)

### Reference (read-only)
- `app/models/channel/telegram.rb` — pattern for `include Channelable`, encryption, methods
- `app/models/channel/line.rb` — secondary reference
- `db/migrate/*create_channel_telegram*.rb` — migration pattern
- `app/controllers/platform/api/v1/` — ActionController::API pattern

## Implementation Steps

1. **Generate migrations**
   ```bash
   bundle exec rails generate migration CreateChannelZalo
   bundle exec rails generate migration CreateZaloSessions
   ```
   Fill migration files theo schema trên.

2. **`app/models/channel/zalo.rb`**
   ```ruby
   class Channel::Zalo < ApplicationRecord
     include Channelable
     self.table_name = 'channel_zalo'
     
     EDITABLE_ATTRS = [:display_name].freeze
     
     has_one :zalo_session, dependent: :destroy
     
     validates :account_id, presence: true
     
     def name
       'Zalo'
     end
     
     def messaging_window_enabled?
       false
     end
     
     def send_message(message)
       Zalo::SendOnZaloService.new(message: message).perform
     end
     
     def active_session?
       zalo_session&.status == 'ready'
     end
   end
   ```

3. **`app/models/zalo_session.rb`**
   ```ruby
   class ZaloSession < ApplicationRecord
     belongs_to :channel_zalo, class_name: 'Channel::Zalo'
     
     encrypts :cookies if Chatwoot.encryption_configured?
     encrypts :imei if Chatwoot.encryption_configured?
     
     STATUSES = %w[pending qr_ready scanning confirmed ready disconnected expired failed deleted].freeze
     validates :status, inclusion: { in: STATUSES }
     validates :session_id, presence: true, uniqueness: true
     
     scope :active, -> { where(status: %w[pending qr_ready scanning confirmed ready]) }
     
     def to_node_payload
       {
         session_id: session_id,
         channel_zalo_id: channel_zalo_id,
         account_id: channel_zalo.account_id,
         zalo_own_id: channel_zalo.zalo_own_id,
         cookies: cookies,
         imei: imei,
         user_agent: user_agent,
         proxy_url: proxy_url,
         status: status,
         last_seen_at: last_seen_at
       }
     end
   end
   ```

4. **`app/controllers/internal/zalo_sessions_controller.rb`** — theo code snippet trên. Thêm logging mỗi action.

5. **Update `config/routes.rb`**
   - Tìm chỗ mount `namespace :api` — thêm `namespace :internal` block cùng level hoặc tách block mới
   - Constraint: only from localhost
     ```ruby
     constraints lambda { |req| req.remote_ip.in?(['127.0.0.1', '::1', 'localhost']) } do
       namespace :internal do
         resources :zalo_sessions, param: :session_id, except: [:new, :edit]
       end
     end
     ```

6. **Update `inboxes_controller.rb`**
   - Line 174 — add `'zalo' => Channel::Zalo` to hash
   - Verify `EDITABLE_ATTRS` propagate correctly

7. **Test in Rails console**
   ```ruby
   Channel::Zalo.create!(account_id: 1, display_name: 'Test')
   s = ZaloSession.create!(
     channel_zalo_id: 1,
     session_id: SecureRandom.uuid,
     cookies: { foo: 'bar' }.to_json,
     imei: 'abc123',
     user_agent: 'Mozilla/...',
     status: 'ready'
   )
   s.reload.cookies  # should decrypt transparently
   ```

8. **Test internal API with curl**
   ```bash
   curl -X GET http://localhost:3000/internal/zalo_sessions \
     -H "X-Zalo-Service-Token: $ZALO_SERVICE_INTERNAL_TOKEN"
   ```

9. **Migration down test** — `bundle exec rails db:rollback STEP=2` phải revert sạch

## Todo List

- [ ] Write migration `create_channel_zalo` (up + down)
- [ ] Write migration `create_zalo_sessions` (up + down, include encrypted cols)
- [ ] Run `rails db:migrate`, verify schema.rb updated
- [ ] Implement `Channel::Zalo` model
- [ ] Implement `ZaloSession` model với encryption
- [ ] Add routes cho `internal/zalo_sessions` with localhost constraint
- [ ] Implement `Internal::ZaloSessionsController`
- [ ] Add `zalo` to `inboxes_controller.rb` channel type map
- [ ] Test model in rails console
- [ ] Test internal API with curl (auth pass + fail)
- [ ] Rollback migration test
- [ ] Write unit specs for models (`spec/models/channel/zalo_spec.rb`, `spec/models/zalo_session_spec.rb`)
- [ ] Write request specs for internal controller
- [ ] Verify `rubocop` clean

## Success Criteria

1. Migration up/down no errors
2. `Channel::Zalo.new` + `ZaloSession.new` không throw
3. Encrypted cookies round-trip correctly
4. `POST /internal/zalo_sessions` with token → 201 Created, row trong DB
5. `GET` without token → 401
6. `GET` from non-localhost IP → blocked
7. Inbox create via `/api/v1/accounts/:id/inboxes` with `channel.type=zalo` → tạo Channel::Zalo + Inbox
8. RuboCop pass

## Risk Assessment

| Risk | Mitigation |
|---|---|
| AR Encryption chưa config | Guard với `if Chatwoot.encryption_configured?`, docs hướng dẫn user generate keys |
| Migration conflict với upstream | Use timestamp future-proof |
| Internal route leak public | Localhost constraint + token auth |
| `zalo_own_id` collision across accounts | Currently unique nullable — nếu multi-tenant đồng Zalo account thì cần composite key. Ship v1 unique. |

## Security Considerations

- Encryption for cookies/imei at rest
- Internal API token auth + localhost constraint (defense in depth)
- No cookie data in response to external API — only internal
- `EDITABLE_ATTRS` block cookies from user-facing edit

## Next Steps

→ **Phase 04**: Rails services (send, incoming, QR proxy) + Redis listener subscribing to `zalo.events`
