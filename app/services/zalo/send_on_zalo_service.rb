# Outbound: agent reply → Node sidecar → Zalo customer.
#
# Inherits the Chatwoot Base::SendOnChannelService so it shares validations
# with Telegram/Line/etc. The actual transport hop lives in Zalo::NodeApiClient.
#
# Pre-flight guards (Phase 07 hardening):
#   1. session_ready?     — DB row must be status=ready
#   2. content_valid?     — not blank, not oversized
#   3. circuit_closed?    — too many recent failures ⇒ refuse
#   4. rate_limit_allows? — respect per-session token bucket
#
# A failure increments the circuit breaker; a success clears it.
class Zalo::SendOnZaloService < Base::SendOnChannelService
  MAX_MESSAGE_LENGTH = 2000

  private

  def channel_class
    Channel::Zalo
  end

  def perform_reply
    return unless session_ready?
    return unless content_valid?
    return unless circuit_closed?
    return unless rate_limit_allows?

    response = Zalo::NodeApiClient.new.send_message(
      session_id: session.session_id,
      thread_id: conversation.additional_attributes['zalo_thread_id'],
      thread_type: conversation.additional_attributes['zalo_thread_type'] || 0,
      content: message.outgoing_content,
      attachments: serialized_attachments,
      reply_to: message.content_attributes['in_reply_to_external_id']
    )

    if response.success?
      message.update!(source_id: response.parsed_response['message_id'])
      Zalo::CircuitBreaker.record_success(session.session_id)
    else
      Zalo::CircuitBreaker.record_failure(session.session_id)
      mark_failed(response.parsed_response&.dig('error') || 'zalo_send_failed')
    end
  rescue Zalo::NodeApiClient::ServiceUnreachableError => e
    Zalo::CircuitBreaker.record_failure(session.session_id) if session
    mark_failed(e.message)
  end

  def content_valid?
    content = message.outgoing_content.to_s
    if content.strip.empty? && message.attachments.empty?
      mark_failed('zalo_empty_message')
      return false
    end
    if content.length > MAX_MESSAGE_LENGTH
      mark_failed("zalo_message_too_long (#{content.length} > #{MAX_MESSAGE_LENGTH})")
      return false
    end
    true
  end

  def circuit_closed?
    if Zalo::CircuitBreaker.open?(session.session_id)
      mark_failed('zalo_circuit_open')
      return false
    end
    true
  end

  def rate_limit_allows?
    limit = channel.effective_rate_limit
    unless Zalo::RateLimiter.allow?(session.session_id, limit: limit)
      mark_failed('zalo_rate_limit_exceeded')
      return false
    end
    true
  end

  def session
    @session ||= channel.zalo_session
  end

  def channel
    @channel ||= message.inbox.channel
  end

  def conversation
    @conversation ||= message.conversation
  end

  def session_ready?
    if session.nil? || session.status != 'ready'
      mark_failed('zalo_session_not_ready')
      return false
    end
    true
  end

  def mark_failed(reason)
    message.update!(status: :failed, external_error: reason.to_s.truncate(500))
  end

  def serialized_attachments
    message.attachments.filter_map do |att|
      {
        type: att.file_type,
        url: Rails.application.routes.url_helpers.rails_blob_url(
          att.file,
          host: ENV.fetch('FRONTEND_URL', 'http://localhost:3000')
        ),
        filename: att.file.filename.to_s
      }
    rescue StandardError
      # If URL generation fails (e.g., missing host), skip this attachment
      # rather than blocking the whole message.
      nil
    end
  end
end
