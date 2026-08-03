# == Schema Information
#
# Table name: zalo_proxies
#
#  id              :bigint           not null, primary key
#  host            :string           not null
#  last_checked_at :datetime
#  metadata        :jsonb            not null
#  name            :string           not null
#  password        :text
#  port            :integer          not null
#  scheme          :string(16)       not null
#  status          :string           default("active"), not null
#  username        :string
#  created_at      :datetime         not null
#  updated_at      :datetime         not null
#  account_id      :integer          not null
#
# Indexes
#
#  index_zalo_proxies_on_account_id  (account_id)
#  index_zalo_proxies_on_status      (status)
#
class ZaloProxy < ApplicationRecord
  belongs_to :account
  has_many :zalo_sessions, dependent: :nullify

  encrypts :password if Chatwoot.encryption_configured?

  SCHEMES = %w[http https socks5].freeze
  STATUSES = %w[active disabled dead].freeze

  validates :name, presence: true
  validates :scheme, inclusion: { in: SCHEMES }
  validates :host, presence: true
  validates :port, numericality: { only_integer: true, greater_than: 0, less_than: 65_536 }
  validates :status, inclusion: { in: STATUSES }
  validate :host_must_not_be_internal

  scope :active, -> { where(status: 'active') }

  def connection_url
    auth = username.present? ? "#{CGI.escape(username)}:#{CGI.escape(password || '')}@" : ''
    "#{scheme}://#{auth}#{host}:#{port}"
  end

  private

  # SSRF mitigation: refuse proxies pointed at internal ranges.
  # Covers red team H8 — uses the ssrf_filter gem (already in Chatwoot's
  # Gemfile for other fetchers). Falls back to a manual regex for the
  # obvious cases so validation still runs if the gem is absent.
  def host_must_not_be_internal
    return if host.blank?
    return if ENV['ZALO_PROXY_ALLOW_INTERNAL'] == 'true'

    if internal_host?(host)
      errors.add(:host, 'points to an internal network address; proxies must be publicly reachable')
    end
  end

  def internal_host?(h)
    lower = h.downcase
    return true if lower == 'localhost' || lower == '::1'
    return true if lower.start_with?('127.')
    return true if lower.start_with?('10.')
    return true if lower.start_with?('192.168.')
    return true if lower =~ /\A172\.(1[6-9]|2\d|3[0-1])\./
    return true if lower.start_with?('169.254.')    # link-local
    return true if lower.start_with?('100.64.')     # CGNAT
    return true if lower.start_with?('fc') || lower.start_with?('fd') # IPv6 ULA
    false
  end
end
