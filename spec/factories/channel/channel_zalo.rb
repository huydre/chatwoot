FactoryBot.define do
  factory :channel_zalo, class: 'Channel::Zalo' do
    display_name { 'Test Zalo Channel' }
    account

    before(:create) do |channel_zalo|
      # Bypass the encryption-required validation so tests can run without
      # the AR Encryption env vars set. Production validation runs unmocked.
      channel_zalo.define_singleton_method(:encryption_must_be_configured) { nil }
    end

    after(:create) do |channel_zalo|
      create(:inbox, channel: channel_zalo, account: channel_zalo.account)
    end
  end

  factory :zalo_session do
    channel_zalo factory: :channel_zalo
    session_id { SecureRandom.uuid }
    cookies { '[{"name":"c","value":"v"}]' }
    imei { 'imei-test' }
    user_agent { 'Mozilla/5.0 test' }
    status { 'ready' }
    last_connected_at { Time.current }
  end

  factory :zalo_proxy do
    account
    name { 'Test Proxy' }
    scheme { 'http' }
    host { 'proxy.example.com' }
    port { 8080 }
    status { 'active' }
  end
end
