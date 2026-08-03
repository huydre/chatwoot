# == Schema Information
#
# Table name: zalo_sessions
#
#  id                :bigint           not null, primary key
#  cookies           :text
#  imei              :text
#  last_connected_at :datetime
#  last_seen_at      :datetime
#  metadata          :jsonb            not null
#  status            :string           default("pending"), not null
#  user_agent        :string(512)
#  created_at        :datetime         not null
#  updated_at        :datetime         not null
#  channel_zalo_id   :bigint           not null
#  session_id        :string           not null
#  zalo_proxy_id     :bigint
#
# Indexes
#
#  index_zalo_sessions_on_channel_zalo_id  (channel_zalo_id)
#  index_zalo_sessions_on_session_id       (session_id) UNIQUE
#  index_zalo_sessions_on_status           (status)
#  index_zalo_sessions_on_zalo_proxy_id    (zalo_proxy_id)
#
# Foreign Keys
#
#  fk_rails_...  (channel_zalo_id => channel_zalo.id) ON DELETE => cascade
#  fk_rails_...  (zalo_proxy_id => zalo_proxies.id) ON DELETE => nullify
#
class ZaloSession < ApplicationRecord
  belongs_to :channel_zalo, class_name: 'Channel::Zalo'
  belongs_to :zalo_proxy, class_name: 'ZaloProxy', optional: true

  # Active Record Encryption is guarded for environments where keys are not
  # configured yet. Channel::Zalo.create still refuses creation in that case,
  # so by the time we reach ZaloSession#save the keys are always present.
  encrypts :cookies if Chatwoot.encryption_configured?
  encrypts :imei if Chatwoot.encryption_configured?

  STATUSES = %w[
    pending qr_ready scanning confirmed ready
    disconnected expired failed deleted
  ].freeze

  validates :session_id, presence: true, uniqueness: true
  validates :status, inclusion: { in: STATUSES }

  scope :active, lambda {
    where(status: %w[pending qr_ready scanning confirmed ready])
  }

  def to_node_payload
    {
      session_id: session_id,
      channel_zalo_id: channel_zalo_id,
      account_id: channel_zalo&.account_id,
      zalo_own_id: channel_zalo&.zalo_own_id,
      # Returning plaintext cookies to the Node sidecar over localhost HTTP.
      # Known red-team finding C3 — acceptable risk for v1, revisit with mTLS
      # in production hardening phase.
      cookies: cookies,
      imei: imei,
      user_agent: user_agent,
      proxy_url: zalo_proxy&.connection_url,
      status: status,
      last_seen_at: last_seen_at&.iso8601
    }
  end
end
