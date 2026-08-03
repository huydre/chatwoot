# Dashboard-facing API for the Zalo QR login flow.
# Called by the Vue Zalo.vue component during inbox setup.
class Api::V1::Accounts::Channels::ZaloController < Api::V1::Accounts::BaseController
  before_action :check_authorization

  def start_login
    result = Zalo::QrLoginService.new(account: Current.account).start(
      user_agent: params[:user_agent],
      language: params[:language]
    )
    render json: result
  rescue Zalo::NodeApiClient::ServiceUnreachableError => e
    render json: { error: 'zalo_service_unreachable', detail: e.message }, status: :service_unavailable
  rescue StandardError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  def login_status
    result = Zalo::QrLoginService.new(account: Current.account).status(params[:session_id])
    render json: result
  rescue Zalo::NodeApiClient::ServiceUnreachableError => e
    render json: { error: 'zalo_service_unreachable', detail: e.message }, status: :service_unavailable
  end

  def relogin
    channel = Channel::Zalo.find(params[:channel_id])
    authorize_channel!(channel)
    result = Zalo::QrLoginService.new(account: Current.account).relogin(channel)
    render json: result
  end

  def destroy_session
    Zalo::QrLoginService.new(account: Current.account).delete_session(params[:session_id])
    head :no_content
  rescue Zalo::NodeApiClient::ServiceUnreachableError => e
    render json: { error: 'zalo_service_unreachable', detail: e.message }, status: :service_unavailable
  end

  # Kicks off an async sync of thread list + group chat history through
  # the Node sidecar. Rails returns immediately — progress events are
  # published via Redis and cached for the UI to poll.
  def sync
    channel = Channel::Zalo.find(params[:channel_id])
    authorize_channel!(channel)
    session = channel.zalo_session
    unless session&.status == 'ready'
      return render json: { error: 'session_not_ready' }, status: :unprocessable_entity
    end

    response = Zalo::NodeApiClient.new.start_sync(
      session.session_id,
      include_group_history: params[:include_group_history] != false
    )
    render json: response.parsed_response, status: response.code
  rescue Zalo::NodeApiClient::ServiceUnreachableError => e
    render json: { error: 'zalo_service_unreachable', detail: e.message }, status: :service_unavailable
  end

  def sync_status
    channel = Channel::Zalo.find(params[:channel_id])
    authorize_channel!(channel)
    session = channel.zalo_session
    cached = Rails.cache.read("zalo:sync_progress:#{session&.session_id}")
    render json: cached || { stage: 'idle' }
  end

  private

  def check_authorization
    authorize(Inbox, :create?)
  end

  def authorize_channel!(channel)
    return if channel.account_id == Current.account.id

    raise Pundit::NotAuthorizedError, 'Channel does not belong to current account'
  end
end
