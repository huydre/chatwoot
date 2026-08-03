# Session dropped off — flip DB status so the dashboard surfaces a
# "Reconnect" banner. Full classifier + notification flow arrives in Phase 06;
# this job keeps the stub so events published from Phase 02 don't error out.
class Zalo::HandleDisconnectJob < ApplicationJob
  queue_as :default

  def perform(event)
    session = ZaloSession.find_by(session_id: event['session_id'])
    return unless session

    new_status = event['recoverable'] ? 'disconnected' : 'expired'
    session.update!(
      status: new_status,
      last_seen_at: Time.current,
      metadata: session.metadata.merge(
        'last_disconnect_reason' => event['reason'],
        'last_disconnect_at' => Time.current.iso8601,
        'last_disconnect_message' => event['error_message']
      )
    )

    notify_admins_if_needed(session, event)
    Rails.logger.info("[Zalo] session #{session.session_id} → #{new_status} (#{event['reason']})")
  end

  private

  # Only notify administrators when the session is genuinely dead (expired,
  # not a transient hiccup that auto-reconnect can paper over).
  def notify_admins_if_needed(session, event)
    return if event['recoverable']

    account = session.channel_zalo&.account
    return unless account

    account.administrators.find_each do |admin|
      create_notification(account, admin, session, event['reason'])
    end
  rescue StandardError => e
    Rails.logger.error("[Zalo] notification dispatch failed: #{e.message}")
  end

  def create_notification(account, admin, session, reason)
    Notification.create!(
      account: account,
      user: admin,
      notification_type: :conversation_creation,
      primary_actor: session.channel_zalo.inbox,
      secondary_actor: session.channel_zalo,
      push_message_title: "Zalo session expired (#{reason}). Re-login required.",
      meta: {
        zalo_session_id: session.session_id,
        zalo_reason: reason
      }
    )
  rescue ActiveRecord::RecordInvalid => e
    # Notification model shapes vary across Chatwoot versions — swallow
    # validation errors rather than breaking disconnect handling.
    Rails.logger.warn("[Zalo] notification invalid: #{e.message}")
  end
end
