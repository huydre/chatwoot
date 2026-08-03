# HTTP client for the Node zalo_service sidecar.
#
# All outbound calls from Rails to the Node process go through this wrapper so
# the token header, base URL, and error handling live in one place. The Node
# service only listens on localhost — no TLS, no certs, no DNS.
class Zalo::NodeApiClient
  include HTTParty

  class ServiceUnreachableError < StandardError; end

  DEFAULT_OPEN_TIMEOUT = 5
  DEFAULT_READ_TIMEOUT = 20

  def initialize(base_url: nil, token: nil)
    @base_url = (base_url || ENV.fetch('ZALO_SERVICE_URL', 'http://127.0.0.1:4567')).sub(%r{/$}, '')
    @token = token || ENV.fetch('ZALO_SERVICE_INTERNAL_TOKEN', '')
  end

  # Outbound — agent replies to Zalo customer.
  def send_message(session_id:, thread_id:, thread_type:, content:, attachments: [], reply_to: nil)
    post('/send', {
      session_id: session_id,
      thread_id: thread_id,
      thread_type: thread_type,
      content: content,
      attachments: attachments,
      reply_to: reply_to
    })
  end

  # Kick off QR login flow, returns { session_id, status }.
  def start_login(opts = {})
    post('/login/start', opts)
  end

  # Poll current login state, used by Rails QrLoginService to drive the UI.
  def login_status(session_id)
    get("/login/status/#{session_id}")
  end

  def session_health(session_id)
    get("/session/#{session_id}/health")
  end

  def delete_session(session_id)
    delete("/session/#{session_id}")
  end

  def start_sync(session_id, include_group_history: true)
    post("/session/#{session_id}/sync", include_group_history: include_group_history)
  end

  def sync_status(session_id)
    get("/session/#{session_id}/sync/status")
  end

  private

  def post(path, body)
    request(:post, path, body: body.to_json)
  end

  def get(path)
    request(:get, path)
  end

  def delete(path)
    request(:delete, path)
  end

  def request(method, path, **opts)
    HTTParty.send(
      method,
      "#{@base_url}#{path}",
      headers: headers,
      body: opts[:body],
      open_timeout: DEFAULT_OPEN_TIMEOUT,
      read_timeout: DEFAULT_READ_TIMEOUT
    )
  rescue HTTParty::Error, Errno::ECONNREFUSED, Net::OpenTimeout, Net::ReadTimeout, SocketError => e
    raise ServiceUnreachableError, "zalo_service unreachable: #{e.class}: #{e.message}"
  end

  def headers
    {
      'Content-Type' => 'application/json',
      'X-Zalo-Service-Token' => @token
    }
  end
end
