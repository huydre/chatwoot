# Periodic job that reconciles the Rails view of Zalo session health with
# what the Node sidecar actually reports.
#
# Schedule: run every 5 minutes via sidekiq-cron (see config/sidekiq_cron.yml
# if configured, otherwise enqueue manually from an admin action).
#
# Workflow:
#   1. Find sessions the Rails DB thinks are 'ready' but haven't been seen
#      in 10+ minutes (stale signal).
#   2. For each, ask the Node service for its current health snapshot.
#   3. If Node confirms ready, bump last_seen_at.
#   4. If Node disagrees or is unreachable, dispatch HandleDisconnectJob so
#      the DB reflects reality and the user gets a reconnect prompt.
class Zalo::HealthMonitorJob < ApplicationJob
  queue_as :scheduled_jobs

  STALE_THRESHOLD = 10.minutes

  def perform
    stale_sessions.find_each do |session|
      reconcile(session)
    end
  end

  private

  def stale_sessions
    ZaloSession.where(status: 'ready')
               .where('last_seen_at < ? OR last_seen_at IS NULL', STALE_THRESHOLD.ago)
  end

  def reconcile(session)
    response = Zalo::NodeApiClient.new.session_health(session.session_id)
    if response.success? && response.parsed_response['state'] == 'ready'
      session.update!(last_seen_at: Time.current)
      Rails.logger.debug { "[Zalo HealthMonitor] #{session.session_id} confirmed ready" }
    else
      dispatch_disconnect(session, 'health_check_failed')
    end
  rescue Zalo::NodeApiClient::ServiceUnreachableError => e
    Rails.logger.warn("[Zalo HealthMonitor] Node unreachable for #{session.session_id}: #{e.message}")
    dispatch_disconnect(session, 'node_unreachable')
  end

  def dispatch_disconnect(session, reason)
    Zalo::HandleDisconnectJob.perform_later(
      'session_id' => session.session_id,
      'reason' => reason,
      'recoverable' => false,
      'error_message' => "HealthMonitor: #{reason}"
    )
  end
end
