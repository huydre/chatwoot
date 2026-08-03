# Processes a single thread_list_item event published by the Node sync
# service, creating the Contact behind a Zalo thread.
#
# It used to also create a placeholder Conversation per thread. On a real
# account that meant one empty conversation for every person in the address
# book — 197 of them on the first test, each holding a single "synced from
# Zalo" activity message and each firing auto-assignment, against 2 real
# messages. The inbox was unusable.
#
# Conversations are now created by IncomingMessageService when a message
# actually arrives. Contacts still sync, so agents can search for someone
# and start a conversation before that person has written.
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
  end

  private

  def backfill_avatar(contact, avatar_url)
    return if avatar_url.blank?
    return if contact.avatar.attached?

    ::Avatar::AvatarFromUrlJob.perform_later(contact, avatar_url)
  end

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
end
