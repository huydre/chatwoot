# Outbound circuit breaker per Zalo session.
#
# Opens the circuit when the caller registers 3 consecutive failures within
# 60 seconds and refuses further sends for 5 minutes. Once the cool-down
# passes, the circuit half-opens and the next send is allowed through — a
# success closes it, a failure re-opens.
#
# State lives in Redis so all Rails workers see the same breaker state.
# On Redis errors we fail open (allow the send) so a Redis hiccup does not
# take down outbound traffic.
class Zalo::CircuitBreaker
  FAILURE_THRESHOLD = 3
  FAILURE_WINDOW = 60
  COOLDOWN = 5 * 60

  def self.open?(session_id)
    new(session_id).open?
  end

  def self.record_failure(session_id)
    new(session_id).record_failure
  end

  def self.record_success(session_id)
    new(session_id).record_success
  end

  def initialize(session_id)
    @state_key = "zalo:cb:state:#{session_id}"
    @fail_key = "zalo:cb:fails:#{session_id}"
  end

  def open?
    redis.get(@state_key) == 'open'
  rescue ::Redis::BaseError
    false
  end

  def record_failure
    fails = redis.incr(@fail_key)
    redis.expire(@fail_key, FAILURE_WINDOW) if fails == 1

    if fails >= FAILURE_THRESHOLD
      redis.set(@state_key, 'open', ex: COOLDOWN)
      redis.del(@fail_key)
      Rails.logger.warn("[Zalo CB] circuit opened for session")
    end
  rescue ::Redis::BaseError => e
    Rails.logger.warn("[Zalo CB] redis error recording failure: #{e.message}")
  end

  def record_success
    redis.del(@state_key)
    redis.del(@fail_key)
  rescue ::Redis::BaseError
    # noop
  end

  private

  def redis
    @redis ||= ::Redis.new(url: ENV.fetch('REDIS_URL', 'redis://localhost:6379'))
  end
end
