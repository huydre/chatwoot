# Internal API consumed exclusively by the Node zalo_service sidecar.
#
# Auth: shared token via X-Zalo-Service-Token header (constant-time compare).
# Transport: HTTP over localhost only — enforced via route constraint.
#
# Red team findings still to address (tracked for post-v1 hardening):
#   - C2: no per-account scoping yet; token leak exposes all accounts
#   - C3: cookies are returned plaintext to Node — acceptable on localhost
class Internal::ZaloSessionsController < ActionController::API
  before_action :authenticate_zalo_service
  before_action :find_session, only: %i[show update destroy]

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
      cookies: params[:cookies],
      imei: params[:imei],
      user_agent: params[:user_agent],
      status: 'ready',
      last_connected_at: Time.current
    )
    session.save!

    render json: session.to_node_payload.merge(inbox_id: inbox.id), status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: 'validation_failed', details: e.record.errors.full_messages }, status: :unprocessable_entity
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

  def find_session
    @session = ZaloSession.find_by!(session_id: params[:session_id])
  rescue ActiveRecord::RecordNotFound
    render json: { error: 'session_not_found' }, status: :not_found
  end

  def find_or_initialize_channel
    if params[:existing_channel_id].present?
      Channel::Zalo.find(params[:existing_channel_id])
    else
      account_id = params[:account_id] || default_account_id
      raise ActiveRecord::RecordNotFound, 'account_id required for new channel' if account_id.blank?

      Channel::Zalo.find_or_initialize_by(zalo_own_id: params[:own_id]).tap do |ch|
        ch.account_id ||= account_id
      end
    end
  end

  # Fallback when Node has no account context — use the first account in the
  # system. Fine for single-tenant installs; multi-tenant must always pass
  # account_id explicitly from the frontend.
  def default_account_id
    Account.first&.id
  end

  def session_params
    params.permit(:cookies, :imei, :user_agent, :status, :last_seen_at, metadata: {})
  end
end
