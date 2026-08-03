# Called when Node publishes session_ready after QR scan success.
# Flips the DB session status, records own_id on the channel, and primes
# Redis so the frontend polling endpoint can short-circuit the next status
# read from whichever web worker happens to serve it.
class Zalo::ConfirmSessionReadyJob < ApplicationJob
  queue_as :default

  def perform(event)
    session = ZaloSession.find_by(session_id: event['session_id'])
    return unless session

    session.update!(status: 'ready', last_connected_at: Time.current, last_seen_at: Time.current)

    if event['own_id'].present? && session.channel_zalo.zalo_own_id.blank?
      session.channel_zalo.update!(
        zalo_own_id: event['own_id'],
        display_name: event['display_name'].presence || session.channel_zalo.display_name
      )
    end

    Redis::Alfred.setex(
      format(Redis::RedisKeys::ZALO_SESSION_STATUS, session_id: session.session_id),
      'ready',
      5.minutes
    )
  end
end
