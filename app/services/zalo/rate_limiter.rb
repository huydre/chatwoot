# Per-session outbound rate limiter backed by Redis.
#
# Simple fixed-window token bucket — counts outbound messages per session
# within a rolling 60-second window. Once the cap is reached, the next
# `allow?` call returns false and the caller (SendOnZaloService) is
# expected to either queue or fail the message.
#
# The limit value comes from Channel::Zalo#effective_rate_limit which
# falls back to the ZALO_OUTBOUND_RATE_LIMIT_PER_MINUTE env var. This lets
# an account override the default without a code change.
#
# The bucket is fixed-window (not sliding) because fixed is cheap, easy to
# reason about, and the v1 use case (small shops, <50 msg/min/account)
# does not need sub-second fairness.
class Zalo::RateLimiter
  WINDOW_SECONDS = 60

  def self.allow?(session_id, limit:)
    new(session_id).allow?(limit)
  end

  def initialize(session_id)
    @key = "zalo:rate:#{session_id}"
  end

  def allow?(limit)
    count = ::Redis.new(url: ENV.fetch('REDIS_URL', 'redis://localhost:6379')).then do |redis|
      current = redis.incr(@key)
      redis.expire(@key, WINDOW_SECONDS) if current == 1
      current
    end
    count <= limit
  rescue ::Redis::BaseError => e
    Rails.logger.warn("[Zalo RateLimiter] Redis error, failing open: #{e.message}")
    true
  end

  def reset!
    ::Redis.new(url: ENV.fetch('REDIS_URL', 'redis://localhost:6379')).del(@key)
  rescue ::Redis::BaseError
    # noop
  end
end
