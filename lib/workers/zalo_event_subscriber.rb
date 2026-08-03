# Long-running Ruby process that consumes the `zalo.events` Redis stream
# published by the Node zalo_service sidecar. Each event is routed to the
# appropriate Sidekiq job for actual processing so this loop stays
# lightweight and never blocks on business logic.
#
# Runs as its own Procfile process (`zalo_listener`), and is safe to run on
# every Rails pod: all consumers join one group, so Redis hands each event
# to exactly one of them, and unacked events are reclaimed if a consumer
# dies. This replaces the original pub/sub loop, which both duplicated
# events across pods and dropped everything published while no subscriber
# was attached (red team finding C1).
module ZaloEventSubscriber
  STREAM = 'zalo.events'.freeze
  GROUP = 'chatwoot-rails'.freeze
  BLOCK_MS = 5_000
  BATCH_SIZE = 50
  # An event still unacked after this long means its consumer died mid-flight.
  CLAIM_IDLE_MS = 60_000

  class << self
    def start
      Rails.logger.info "[ZaloSubscriber] starting, stream=#{STREAM} group=#{GROUP} consumer=#{consumer_name}"
      install_signal_handlers
      ensure_group
      consume_loop
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

    # MKSTREAM so the listener can boot before the sidecar has published
    # anything. BUSYGROUP just means another pod created the group first.
    def ensure_group
      redis_client.xgroup(:create, STREAM, GROUP, '$', mkstream: true)
    rescue Redis::CommandError => e
      raise unless e.message.include?('BUSYGROUP')
    end

    def consume_loop
      loop do
        reclaim_stalled
        read_batch.each_value do |entries|
          entries.each { |id, fields| handle_entry(id, fields) }
        end
      end
    rescue Redis::BaseConnectionError, StandardError => e
      Rails.logger.error "[ZaloSubscriber] crash: #{e.class}: #{e.message}"
      sleep 2
      retry
    end

    def read_batch
      redis_client.xreadgroup(GROUP, consumer_name, STREAM, '>', count: BATCH_SIZE, block: BLOCK_MS) || {}
    end

    # Takes over events whose original consumer died before acking, so a pod
    # crash delays delivery rather than losing it.
    def reclaim_stalled
      claimed = redis_client.xautoclaim(STREAM, GROUP, consumer_name, CLAIM_IDLE_MS, '0-0', count: BATCH_SIZE)
      claimed['entries'].each { |id, fields| handle_entry(id, fields) }
    rescue Redis::CommandError => e
      Rails.logger.error "[ZaloSubscriber] xautoclaim failed: #{e.message}"
    end

    # Ack regardless of handler outcome: process_event already swallows and
    # logs its own failures, and the real work happens in Sidekiq, which has
    # its own retries. Leaving it unacked would only replay the same failure.
    def handle_entry(id, fields)
      process_event(fields['payload'])
    ensure
      redis_client.xack(STREAM, GROUP, id)
    end

    def consumer_name
      @consumer_name ||= "#{Socket.gethostname}-#{Process.pid}"
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
        Redis::Alfred.setex(
          format(Redis::RedisKeys::ZALO_QR_CODE, session_id: event['session_id']),
          event['qr_base64'],
          2.minutes
        )
      when 'qr_expired'
        Redis::Alfred.delete(format(Redis::RedisKeys::ZALO_QR_CODE, session_id: event['session_id']))
      when 'message_delivery_error'
        Zalo::DeliveryErrorJob.perform_later(event)
      when 'thread_list_item'
        Zalo::ProcessThreadListItemJob.perform_later(event)
      when 'sync_progress'
        Rails.logger.info(
          "[Zalo sync] session=#{event['session_id']} stage=#{event['stage']} " \
          "processed=#{event['processed']} total=#{event['total']}"
        )
        Redis::Alfred.setex(
          format(Redis::RedisKeys::ZALO_SYNC_PROGRESS, session_id: event['session_id']),
          event.slice('stage', 'processed', 'total', 'error_message').to_json,
          30.minutes
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
