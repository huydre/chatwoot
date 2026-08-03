# == Schema Information
#
# Table name: channel_zalo
#
#  id                    :bigint           not null, primary key
#  avatar_url            :string
#  display_name          :string
#  phone_number          :string(32)
#  rate_limit_per_minute :integer
#  created_at            :datetime         not null
#  updated_at            :datetime         not null
#  account_id            :integer          not null
#  zalo_own_id           :string
#
# Indexes
#
#  index_channel_zalo_on_account_id   (account_id)
#  index_channel_zalo_on_zalo_own_id  (zalo_own_id) UNIQUE WHERE (zalo_own_id IS NOT NULL)
#
class Channel::Zalo < ApplicationRecord
  include Channelable

  self.table_name = 'channel_zalo'

  EDITABLE_ATTRS = [:display_name, :rate_limit_per_minute].freeze

  has_one :zalo_session, foreign_key: 'channel_zalo_id', inverse_of: :channel_zalo, dependent: :destroy

  validates :account_id, presence: true
  validate :encryption_must_be_configured, on: :create

  def name
    'Zalo'
  end

  def messaging_window_enabled?
    false
  end

  def active_session?
    zalo_session&.status == 'ready'
  end

  def effective_rate_limit
    rate_limit_per_minute.presence || ENV.fetch('ZALO_OUTBOUND_RATE_LIMIT_PER_MINUTE', 20).to_i
  end

  private

  def encryption_must_be_configured
    return if Chatwoot.encryption_configured?

    errors.add(:base, 'ActiveRecord encryption keys must be configured before creating a Zalo channel. ' \
                      'Run `bundle exec rails db:encryption:init` and set the generated keys in your environment.')
  end
end
