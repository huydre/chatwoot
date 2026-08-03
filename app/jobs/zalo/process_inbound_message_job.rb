# Dispatches a parsed Zalo message event onto the IncomingMessageService.
# The upstream subscriber (ZaloEventSubscriber) already decoded the JSON, so
# this job receives a plain Ruby hash.
class Zalo::ProcessInboundMessageJob < ApplicationJob
  queue_as :default

  def perform(event)
    session_id = event['session_id']
    return if session_id.blank?

    channel = find_channel(session_id)
    return unless channel
    return unless channel.account&.active?
    return unless channel.inbox # inbox might have been deleted mid-flight

    Zalo::IncomingMessageService.new(inbox: channel.inbox, payload: event['payload'] || {}).perform
  rescue ActiveRecord::Encryption::Errors::Decryption => e
    # Corrupted cookies from a restored DB backup or mismatched keys.
    # Mark the session expired so the admin is prompted to re-scan QR.
    Rails.logger.error("[Zalo Inbound] decryption failed for #{session_id}: #{e.message}")
    ZaloSession.where(session_id: session_id).update_all(status: 'expired')
  end

  private

  def find_channel(session_id)
    ZaloSession.find_by(session_id: session_id)&.channel_zalo
  end
end
