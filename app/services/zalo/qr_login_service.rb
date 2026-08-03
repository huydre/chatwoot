# Thin proxy between the dashboard Vue component and the Node QR login flow.
# The UI never talks to Node directly — it always goes through Rails so we
# can attach account context + authorization + Rails-side caching.
class Zalo::QrLoginService
  # A QR session only reaches the database once Node finishes the login, so
  # ownership is recorded at `start` and falls back to the row afterwards.
  # Long enough to outlive the QR flow, short enough that a stale binding
  # cannot outlive the session it names.
  #
  # Stored in Redis rather than Rails.cache deliberately: Chatwoot ships
  # null_store in dev/test and leaves cache_store unconfigured in production,
  # so a cache miss is the norm, not the exception — and a miss here would
  # deny a legitimate login rather than merely cost a lookup.
  SESSION_ACCOUNT_TTL = 1.hour

  def initialize(account:, existing_channel_id: nil)
    @account = account
    @existing_channel_id = existing_channel_id
  end

  def start(options = {})
    # Strip nil values — Node uses zod `.optional()` which rejects null
    # (it only permits undefined/missing keys).
    payload = options.merge(
      account_id: @account.id,
      existing_channel_id: @existing_channel_id
    ).compact

    response = node_client.start_login(payload)
    raise 'Zalo service unavailable' unless response.success?

    response.parsed_response.tap { |result| bind_session_to_account(result['session_id']) }
  end

  def status(session_id)
    authorize_session!(session_id)
    cached = Redis::Alfred.get(format(Redis::RedisKeys::ZALO_QR_CODE, session_id: session_id))
    cached_status = Redis::Alfred.get(format(Redis::RedisKeys::ZALO_SESSION_STATUS, session_id: session_id))

    return { 'status' => 'qr_ready', 'qr_base64' => cached } if cached && cached_status != 'ready'

    response = node_client.login_status(session_id)
    return { 'status' => 'unreachable' } unless response.success?

    response.parsed_response
  end

  def relogin(channel)
    result = node_client.start_login(
      account_id: @account.id,
      existing_channel_id: channel.id
    ).parsed_response
    bind_session_to_account(result['session_id'])
    result
  end

  def delete_session(session_id)
    authorize_session!(session_id)
    node_client.delete_session(session_id)
  end

  private

  def bind_session_to_account(session_id)
    return if session_id.blank?

    Redis::Alfred.setex(session_account_key(session_id), @account.id, SESSION_ACCOUNT_TTL)
  end

  # Denies unknown and foreign sessions identically so the response cannot be
  # used to probe which session ids exist on other accounts.
  def authorize_session!(session_id)
    return if owner_account_id(session_id) == @account.id

    raise Pundit::NotAuthorizedError, 'Session does not belong to current account'
  end

  def owner_account_id(session_id)
    persisted = ZaloSession.joins(:channel_zalo).where(session_id: session_id).pick('channel_zalo.account_id')
    persisted || Redis::Alfred.get(session_account_key(session_id))&.to_i
  end

  def session_account_key(session_id)
    format(Redis::RedisKeys::ZALO_SESSION_ACCOUNT, session_id: session_id)
  end

  def node_client
    @node_client ||= Zalo::NodeApiClient.new
  end
end
