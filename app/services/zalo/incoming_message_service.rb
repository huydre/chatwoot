# Inbound: Node publishes Zalo message → Rails Sidekiq job → this service.
#
# Mirrors the Telegram::IncomingMessageService pattern:
#   1. Dedup by source_id (Zalo msgId)
#   2. Build or find contact via ContactInboxWithContactBuilder
#   3. Build or find conversation
#   4. Create message with content attributes + attachments
#
# Group chat (thread_type=1) is supported per the v1 decision — the
# conversation stores the group id and member who sent the message acts as
# the contact.
class Zalo::IncomingMessageService
  include Zalo::ParamHelpers
  pattr_initialize [:inbox!, :payload!]

  def perform
    @payload = payload.with_indifferent_access
    return if zalo_msg_id.blank?
    return if duplicate?

    set_contact
    set_conversation
    build_message
    @message.save!
  end

  private

  attr_reader :payload

  # Covers the echo of a message the agent sent from Chatwoot:
  # SendOnZaloService writes the Zalo msgId onto that row as source_id, so by
  # the time the echo arrives it is already known and gets dropped here.
  #
  # This used to be backed up by a self_echo? guard that skipped every live
  # message the account sent — which also threw away everything the user typed
  # in the Zalo app itself, so those never reached the agent's view. Dedup by
  # id is the whole check; a self message that is not a duplicate is one sent
  # from Zalo directly and belongs in the conversation as outgoing.
  def duplicate?
    inbox.messages.exists?(source_id: zalo_msg_id.to_s)
  end

  def set_contact
    # For group messages, the "contact" is the group itself (keyed by
    # threadId) so every member's message lands in the same Chatwoot
    # conversation. For 1:1 messages, keep the sender (uidFrom) as the
    # contact key.
    source_id = group_message? ? zalo_thread_id.to_s : zalo_from_id.to_s
    display_name = group_message? ? "Zalo Group #{zalo_thread_id.to_s.last(6)}" : zalo_from_name

    contact_inbox = ::ContactInboxWithContactBuilder.new(
      source_id: source_id,
      inbox: inbox,
      contact_attributes: {
        name: display_name,
        additional_attributes: {
          social_zalo_thread_id: zalo_thread_id,
          social_zalo_thread_type: zalo_thread_type,
          social_zalo_user_id: group_message? ? nil : zalo_from_id,
          social_zalo_user_name: group_message? ? nil : zalo_from_name
        }.compact
      }
    ).perform
    @contact_inbox = contact_inbox
    @contact = contact_inbox.contact
  end

  def set_conversation
    @conversation = if inbox.lock_to_single_conversation
                      @contact_inbox.conversations.last
                    else
                      @contact_inbox.conversations.where.not(status: :resolved).last
                    end
    return if @conversation

    @conversation = ::Conversation.create!(
      account_id: inbox.account_id,
      inbox_id: inbox.id,
      contact_id: @contact.id,
      contact_inbox_id: @contact_inbox.id,
      additional_attributes: {
        zalo_thread_id: zalo_thread_id,
        zalo_thread_type: zalo_thread_type,
        zalo_group: group_message?
      }
    )
  end

  def build_message
    # For group messages, store the sender name/id in content_attributes
    # since the conversation "contact" is the group, not the sender.
    extra_attrs = { zalo_thread_type: zalo_thread_type }
    if group_message?
      extra_attrs[:zalo_sender_id] = zalo_from_id
      extra_attrs[:zalo_sender_name] = zalo_from_name
    end

    # Preserve the real Zalo send timestamp so the chat history reads
    # in order. For live messages this equals wall clock; for historical
    # sync it is the actual time the sender said it in Zalo.
    sent_at = zalo_timestamp

    @message = @conversation.messages.build(
      content: message_display_content,
      account_id: inbox.account_id,
      inbox_id: inbox.id,
      message_type: self_echo_outgoing? ? :outgoing : :incoming,
      sender: @contact,
      source_id: zalo_msg_id.to_s,
      content_attributes: extra_attrs,
      created_at: sent_at,
      updated_at: sent_at
    )

    zalo_attachments.each do |att|
      @message.attachments.new(
        account_id: inbox.account_id,
        file_type: att['type'],
        external_url: att['url']
      )
    end
  end

  def message_display_content
    content = zalo_content
    # Prefix group messages with sender name so the agent knows who
    # said what even though all messages live in one group conversation.
    return content unless group_message?

    "**#{zalo_from_name}**: #{content}"
  end

  # Historical sync may include messages the account itself sent. We
  # still want to display them but marked as outgoing to preserve the
  # real author.
  def self_echo_outgoing?
    payload[:isSelf] == true || payload.dig(:data, :isSelf) == true || (payload[:historical] && payload.dig(:data, :uidFrom).to_s == own_id.to_s)
  rescue StandardError
    false
  end

  def own_id
    inbox.channel.zalo_own_id
  end
end
