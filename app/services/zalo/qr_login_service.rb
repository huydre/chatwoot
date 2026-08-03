# Thin proxy between the dashboard Vue component and the Node QR login flow.
# The UI never talks to Node directly — it always goes through Rails so we
# can attach account context + authorization + Rails-side caching.
class Zalo::QrLoginService
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

    response.parsed_response
  end

  def status(session_id)
    cached = Rails.cache.read("zalo:qr:#{session_id}")
    cached_status = Rails.cache.read("zalo:session_status:#{session_id}")

    return { 'status' => 'qr_ready', 'qr_base64' => cached } if cached && cached_status != 'ready'

    response = node_client.login_status(session_id)
    return { 'status' => 'unreachable' } unless response.success?

    response.parsed_response
  end

  def relogin(channel)
    node_client.start_login(
      account_id: @account.id,
      existing_channel_id: channel.id
    ).parsed_response
  end

  def delete_session(session_id)
    node_client.delete_session(session_id)
  end

  private

  def node_client
    @node_client ||= Zalo::NodeApiClient.new
  end
end
