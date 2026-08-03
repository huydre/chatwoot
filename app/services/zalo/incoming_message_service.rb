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
    # A Chatwoot conversation maps to a Zalo thread, so the contact is keyed by
    # threadId: the group for group chats, the other party for 1:1.
    #
    # This used to key 1:1 on the sender (uidFrom), which only coincides with
    # the thread on messages the account *receives*. For a message the account
    # sends from the Zalo app, uidFrom is the account itself — so every such
    # message opened a conversation with the operator's own name on it instead
    # of landing in the recipient's thread.
    contact_inbox = ::ContactInboxWithContactBuilder.new(
      source_id: zalo_thread_id.to_s,
      inbox: inbox,
      contact_attributes: {
        name: contact_display_name,
        additional_attributes: {
          social_zalo_thread_id: zalo_thread_id,
          social_zalo_thread_type: zalo_thread_type,
          social_zalo_user_id: group_message? ? nil : zalo_thread_id,
          social_zalo_user_name: peer_name
        }.compact
      }
    ).perform
    @contact_inbox = contact_inbox
    @contact = contact_inbox.contact
  end

  # dName names the *sender*, so it only describes the peer on an inbound 1:1
  # message. Groups and self messages fall back to a placeholder that
  # Zalo::ProcessThreadListItemJob overwrites once the thread list resolves the
  # real title.
  def contact_display_name
    return "Zalo Group #{zalo_thread_id.to_s.last(6)}" if group_message?

    peer_name || "Zalo User #{zalo_thread_id.to_s.last(6)}"
  end

  def peer_name
    return nil if group_message? || self_message?

    zalo_from_name
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

  # For group messages, store the sender name/id here since the conversation
  # "contact" is the group, not the sender.
  def message_content_attributes
    attrs = { zalo_thread_type: zalo_thread_type }
    return attrs unless group_message?

    attrs.merge(zalo_sender_id: zalo_from_id, zalo_sender_name: zalo_from_name)
  end

  def build_message
    # Preserve the real Zalo send timestamp so the chat history reads
    # in order. For live messages this equals wall clock; for historical
    # sync it is the actual time the sender said it in Zalo.
    sent_at = zalo_timestamp
    outgoing = self_echo_outgoing?

    @message = @conversation.messages.build(
      content: message_display_content,
      account_id: inbox.account_id,
      inbox_id: inbox.id,
      message_type: outgoing ? :outgoing : :incoming,
      # No sender on outgoing: the author is the Zalo account, not a Chatwoot
      # agent, and attributing it to @contact would credit the peer with the
      # operator's own words.
      sender: outgoing ? nil : @contact,
      source_id: zalo_msg_id.to_s,
      content_attributes: message_content_attributes,
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
    self_message? || (payload[:historical] && payload.dig(:data, :uidFrom).to_s == own_id.to_s)
  end

  def own_id
    inbox.channel.zalo_own_id
  end
end
