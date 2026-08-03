# Long-running Ruby process that subscribes to the `zalo.events` Redis
# channel published by the Node zalo_service sidecar. Each event is routed
# to the appropriate Sidekiq job for actual processing so this loop stays
# lightweight and never blocks on business logic.
#
# Runs as its own Procfile process (`zalo_listener`). Single-instance by
# design — running multiple subscribers would duplicate every enqueued job.
# Horizontal scaling requires Redis Streams + consumer group instead, which
# is a post-v1 concern (see red team finding C1).
module ZaloEventSubscriber
  CHANNEL = 'zalo.events'.freeze

  class << self
    def start
      Rails.logger.info "[ZaloSubscriber] starting, channel=#{CHANNEL}"
      install_signal_handlers
      subscribe_loop
    end

    private

    def install_signal_handlers
      %w[INT TERM].each do |sig|
        Signal.trap(sig) do
          Rails.logger.info "[ZaloSubscriber] got SIG#{sig}, exiting"
          exit 0
        end
      end
    end

    def subscribe_loop
      redis_client.subscribe(CHANNEL) do |on|
        on.subscribe do |channel, _count|
          Rails.logger.info "[ZaloSubscriber] subscribed to #{channel}"
        end
        on.message do |_channel, payload|
          process_event(payload)
        end
      end
    rescue Redis::BaseConnectionError, StandardError => e
      Rails.logger.error "[ZaloSubscriber] crash: #{e.class}: #{e.message}"
      sleep 2
      retry
    end

    def process_event(raw)
      event = JSON.parse(raw)
      case event['type']
      when 'message'
        Zalo::ProcessInboundMessageJob.perform_later(event)
      when 'session_ready'
        Zalo::ConfirmSessionReadyJob.perform_later(event)
      when 'session_disconnected'
        Zalo::HandleDisconnectJob.perform_later(event)
      when 'qr_code'
        # Cache QR so the Rails proxy endpoint can short-circuit the next
        # poll from the Vue frontend without hitting Node again.
        Rails.cache.write(
          "zalo:qr:#{event['session_id']}",
          event['qr_base64'],
          expires_in: 120
        )
      when 'qr_expired'
        Rails.cache.delete("zalo:qr:#{event['session_id']}")
      when 'message_delivery_error'
        Zalo::DeliveryErrorJob.perform_later(event)
      when 'thread_list_item'
        Zalo::ProcessThreadListItemJob.perform_later(event)
      when 'sync_progress'
        Rails.logger.info(
          "[Zalo sync] session=#{event['session_id']} stage=#{event['stage']} " \
          "processed=#{event['processed']} total=#{event['total']}"
        )
        Rails.cache.write(
          "zalo:sync_progress:#{event['session_id']}",
          event.slice('stage', 'processed', 'total', 'error_message'),
          expires_in: 30.minutes
        )
      else
        Rails.logger.warn "[ZaloSubscriber] unknown event type=#{event['type']}"
      end
    rescue JSON::ParserError => e
      Rails.logger.error "[ZaloSubscriber] bad json: #{e.message}"
    rescue StandardError => e
      Rails.logger.error "[ZaloSubscriber] handler failed: #{e.class}: #{e.message}"
    end

    def redis_client
      @redis_client ||= Redis.new(url: ENV.fetch('REDIS_URL', 'redis://localhost:6379'))
    end
  end
end
