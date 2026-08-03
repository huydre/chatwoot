require 'rails_helper'

RSpec.describe ZaloProxy do
  let(:account) { create(:account) }

  describe 'validations' do
    it { is_expected.to validate_presence_of(:name) }
    it { is_expected.to validate_presence_of(:host) }
    it { is_expected.to validate_inclusion_of(:scheme).in_array(%w[http https socks5]) }
    it { is_expected.to validate_inclusion_of(:status).in_array(%w[active disabled dead]) }
  end

  describe 'SSRF guard' do
    let(:base_attrs) do
      { account: account, name: 'p', scheme: 'http', port: 8080 }
    end

    %w[
      127.0.0.1
      localhost
      10.0.0.5
      192.168.1.1
      172.16.5.5
      172.31.255.254
      169.254.169.254
      100.64.1.1
      fc00::1
      fd00:dead:beef::1
    ].each do |internal_host|
      it "rejects internal host #{internal_host}" do
        proxy = described_class.new(base_attrs.merge(host: internal_host))
        expect(proxy).not_to be_valid
        expect(proxy.errors[:host].join).to match(/internal network/i)
      end
    end

    %w[
      proxy.example.com
      9.9.9.9
      172.15.0.1
      172.32.0.1
      8.8.8.8
    ].each do |public_host|
      it "allows public host #{public_host}" do
        proxy = described_class.new(base_attrs.merge(host: public_host))
        expect(proxy).to be_valid
      end
    end

    it 'bypasses the guard when ZALO_PROXY_ALLOW_INTERNAL=true' do
      allow(ENV).to receive(:[]).and_call_original
      allow(ENV).to receive(:[]).with('ZALO_PROXY_ALLOW_INTERNAL').and_return('true')
      proxy = described_class.new(base_attrs.merge(host: '127.0.0.1'))
      expect(proxy).to be_valid
    end
  end

  describe '#connection_url' do
    it 'builds a URL without credentials' do
      proxy = build(:zalo_proxy, scheme: 'http', host: 'proxy.example.com', port: 8080)
      expect(proxy.connection_url).to eq('http://proxy.example.com:8080')
    end

    it 'embeds username and password when present' do
      allow(Chatwoot).to receive(:encryption_configured?).and_return(false)
      proxy = build(:zalo_proxy, scheme: 'http', host: 'proxy.example.com', port: 8080,
                                 username: 'alice', password: 'secret')
      url = proxy.connection_url
      expect(url).to include('alice:secret@')
      expect(url).to include('proxy.example.com:8080')
    end
  end
end
