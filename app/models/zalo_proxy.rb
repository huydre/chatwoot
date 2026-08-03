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

  # SSRF mitigation: refuse proxies pointed at internal ranges (red team H8).
  #
  # Resolves the host and checks every address it answers with against
  # ssrf_filter's range lists — the gem is already a Chatwoot dependency and
  # its lists cover loopback, RFC1918, link-local (including the cloud
  # metadata address), CGNAT, multicast and the IPv6 equivalents.
  #
  # The previous hand-rolled version compared string prefixes, so it never
  # saw a hostname that resolved somewhere internal, and misread public names
  # that merely start with a private-looking octet, e.g. "10.example.com".
  #
  # This runs at save time. It cannot stop a host that later re-points at an
  # internal address (DNS rebinding); the sidecar dials the proxy, so closing
  # that would mean checking again at connection time in Node.
  def host_must_not_be_internal
    return if host.blank?
    return if ENV['ZALO_PROXY_ALLOW_INTERNAL'] == 'true'

    addresses = resolved_addresses
    if addresses.empty?
      errors.add(:host, 'could not be resolved, so it cannot be confirmed as publicly reachable')
      return
    end

    return if addresses.none? { |ip| internal_address?(ip) }

    errors.add(:host, 'resolves to an internal network address; proxies must be publicly reachable')
  end

  def resolved_addresses
    Resolv.getaddresses(host).filter_map { |address| parse_ip(address) }
  rescue StandardError
    []
  end

  def parse_ip(address)
    IPAddr.new(address)
  rescue IPAddr::InvalidAddressError
    nil
  end

  def internal_address?(ip_address)
    ranges = ip_address.ipv4? ? SsrfFilter::IPV4_BLACKLIST : SsrfFilter::IPV6_BLACKLIST
    ranges.any? { |range| range.include?(ip_address) }
  end
end
