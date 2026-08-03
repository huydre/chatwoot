# Logs a message delivery failure surfaced by the Node sidecar. Real UX
# wiring (agent-visible toast, retry button) arrives later — for now we just
# record it so the inbox isn't silently lossy.
class Zalo::DeliveryErrorJob < ApplicationJob
  queue_as :default

  def perform(event)
    Rails.logger.warn(
      "[Zalo] delivery_error session=#{event['session_id']} thread=#{event['thread_id']} error=#{event['error']}"
    )
  end
end
