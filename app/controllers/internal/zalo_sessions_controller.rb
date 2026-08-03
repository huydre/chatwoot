# Internal API consumed exclusively by the Node zalo_service sidecar.
#
# Auth: shared token via X-Zalo-Service-Token header (constant-time compare).
# Transport: HTTP over localhost only — enforced via route constraint.
#
# The sidecar is a single process serving every account, so `index` is
# deliberately global: it restores all live sessions on boot. Every other
# action is scoped to the `account_id` the caller names, so a leaked token
# cannot be pointed at a session the caller does not already know the
# account of. Each call is logged for audit.
class Internal::ZaloSessionsController < ActionController::API
  before_action :authenticate_zalo_service
  before_action :log_internal_call
  before_action :find_session, only: %i[show update destroy]

  # A payload that will not decrypt was forged, corrupted, or encrypted under a
  # different token — never something to persist.
  rescue_from Zalo::TransportCipher::DecryptionError do
    render json: { error: 'credential_decryption_failed' }, status: :bad_request
  end

  def index
    scope = ZaloSession.includes(:channel_zalo)
    scope = params[:status].present? ? scope.where(status: params[:status]) : scope.active
    render json: scope.map(&:to_node_payload)
  end

  def show
    render json: @session.to_node_payload
  end

  # Called by Node after a successful QR login to persist credentials.
  # Creates Channel::Zalo + Inbox + ZaloSession so the inbox appears in
  # the dashboard sidebar immediately after login.
  def create
    channel = find_or_initialize_channel
    channel.display_name = params[:display_name] if params[:display_name].present?
    channel.save!

    # Chatwoot's Channelable does not auto-create an inbox — every channel
    # type does this explicitly (see InboxesController#create). We only
    # create an inbox the first time this channel is persisted so repeat
    # logins (re-auth with same own_id) reuse the existing inbox and
    # preserve conversation history.
    inbox = channel.inbox || Inbox.create!(
      account_id: channel.account_id,
      channel: channel,
      name: params[:display_name].presence || "Zalo #{channel.zalo_own_id || channel.id}"
    )

    session = channel.zalo_session || channel.build_zalo_session
    session.assign_attributes(
      session_id: params[:session_id],
      cookies: Zalo::TransportCipher.decrypt(params[:cookies_encrypted]),
      imei: params[:imei],
      user_agent: params[:user_agent],
      status: 'ready',
      last_connected_at: Time.current
    )
    session.save!

    render json: session.to_node_payload.merge(inbox_id: inbox.id), status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: 'validation_failed', details: e.record.errors.full_messages }, status: :unprocessable_entity
  rescue ActiveRecord::RecordNotFound => e
    render json: { error: 'channel_not_found', detail: e.message }, status: :not_found
  rescue ActiveRecord::RecordNotUnique
    # zalo_own_id is globally unique, so this Zalo account is already linked
    # to a channel on another account. Previously the lookup found that
    # channel and quietly reused it, handing one account's inbox to another.
    render json: { error: 'zalo_account_already_linked' }, status: :conflict
  end

  def update
    @session.update!(session_params)
    render json: @session.to_node_payload
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: 'validation_failed', details: e.record.errors.full_messages }, status: :unprocessable_entity
  end

  def destroy
    @session.update!(status: 'deleted')
    head :no_content
  end

  private

  def authenticate_zalo_service
    token = request.headers['X-Zalo-Service-Token'].to_s
    expected = ENV.fetch('ZALO_SERVICE_INTERNAL_TOKEN', '')
    return head :unauthorized if expected.blank?
    return if ActiveSupport::SecurityUtils.secure_compare(token, expected)

    head :unauthorized
  end

  def log_internal_call
    Rails.logger.info(
      "[Internal::ZaloSessions] #{action_name} session_id=#{params[:session_id].inspect} " \
      "account_id=#{params[:account_id].inspect} ip=#{request.remote_ip}"
    )
  end

  # Scoped by account when the caller names one, so a caller holding the
  # shared token still cannot reach across accounts it does not know.
  def find_session
    scope = ZaloSession.where(session_id: params[:session_id])
    scope = scope.joins(:channel_zalo).where(channel_zalo: { account_id: params[:account_id] }) if params[:account_id].present?
    @session = scope.first!
  rescue ActiveRecord::RecordNotFound
    render json: { error: 'session_not_found' }, status: :not_found
  end

  def find_or_initialize_channel
    account_id = params[:account_id].presence
    raise ActiveRecord::RecordNotFound, 'account_id is required' if account_id.blank?

    return Channel::Zalo.find_by!(id: params[:existing_channel_id], account_id: account_id) if params[:existing_channel_id].present?

    Channel::Zalo.find_or_initialize_by(zalo_own_id: params[:own_id], account_id: account_id)
  end

  # Cookies arrive encrypted (see Zalo::TransportCipher) and are stored
  # decrypted, so Active Record can re-encrypt them at rest under its own key.
  def session_params
    permitted = params.permit(:cookies_encrypted, :imei, :user_agent, :status, :last_seen_at, metadata: {})
    cookies_encrypted = permitted.delete(:cookies_encrypted)
    return permitted if cookies_encrypted.blank?

    permitted.merge(cookies: Zalo::TransportCipher.decrypt(cookies_encrypted))
  end
end
