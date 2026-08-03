# Processes a single thread_list_item event published by the Node sync
# service. Creates a Contact + placeholder Conversation so the dashboard
# sidebar shows every thread the Zalo account has ever chatted with,
# even before any new messages arrive.
#
# Idempotent: relies on ContactInboxWithContactBuilder which dedupes by
# (inbox_id, source_id). Running sync multiple times is safe.
class Zalo::ProcessThreadListItemJob < ApplicationJob
  queue_as :default

  def perform(event)
    session_id = event['session_id']
    return if session_id.blank?

    channel = ZaloSession.find_by(session_id: session_id)&.channel_zalo
    return unless channel
    return unless channel.inbox
    return unless channel.account&.active?

    thread_type = event['thread_type'].to_i
    source_id = event['thread_id'].to_s
    return if source_id.blank?

    contact_inbox = ::ContactInboxWithContactBuilder.new(
      source_id: source_id,
      inbox: channel.inbox,
      contact_attributes: contact_attributes(event)
    ).perform

    # Save avatar URL on the Contact so the Chatwoot sidebar renders
    # the group/contact picture sourced from Zalo. We set it directly
    # via avatar_url (Chatwoot fetches it async via AvatarFromUrlJob).
    backfill_avatar(contact_inbox.contact, event['avatar_url'])

    ensure_placeholder_conversation(contact_inbox, event, thread_type)
  end

  def backfill_avatar(contact, avatar_url)
    return if avatar_url.blank?
    return if contact.avatar.attached?

    ::Avatar::AvatarFromUrlJob.perform_later(contact, avatar_url)
  end

  private

  def contact_attributes(event)
    {
      name: event['display_name'].presence || "Zalo User #{event['thread_id'].to_s.last(6)}",
      additional_attributes: {
        social_zalo_user_id: event['zalo_user_id'] || event['thread_id'],
        social_zalo_thread_type: event['thread_type'],
        social_zalo_member_count: event['member_count']
      }.compact
    }
  end

  def ensure_placeholder_conversation(contact_inbox, event, thread_type)
    existing = contact_inbox.conversations.where.not(status: :resolved).last
    return existing if existing

    conv = ::Conversation.create!(
      account_id: contact_inbox.inbox.account_id,
      inbox_id: contact_inbox.inbox.id,
      contact_id: contact_inbox.contact_id,
      contact_inbox_id: contact_inbox.id,
      additional_attributes: {
        zalo_thread_id: event['thread_id'],
        zalo_thread_type: thread_type,
        zalo_group: thread_type == 1,
        synced_placeholder: true
      }
    )

    # Chatwoot's message panel gets stuck in an infinite loading state
    # when a conversation has zero messages (the v3 UI keeps requesting
    # older pages). Insert a single activity message so the panel has
    # something to render and terminate the fetch loop.
    seed_activity_message(conv, thread_type)

    conv
  end

  def seed_activity_message(conv, thread_type)
    label = thread_type == 1 ? 'nhóm Zalo' : 'Zalo'
    conv.messages.create!(
      account_id: conv.account_id,
      inbox_id: conv.inbox_id,
      message_type: :activity,
      content: "Đã đồng bộ từ #{label}. Cuộc trò chuyện sẽ xuất hiện khi có tin nhắn mới."
    )
  rescue StandardError => e
    Rails.logger.warn("[Zalo thread sync] seed activity failed: #{e.message}")
  end
end
