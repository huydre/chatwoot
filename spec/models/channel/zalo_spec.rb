require 'rails_helper'

RSpec.describe Channel::Zalo do
  describe 'associations' do
    it { is_expected.to have_one(:zalo_session).dependent(:destroy) }
  end

  describe 'validations' do
    it { is_expected.to validate_presence_of(:account_id) }
  end

  describe 'encryption validation' do
    let(:account) { create(:account) }

    context 'when encryption is NOT configured' do
      before { allow(Chatwoot).to receive(:encryption_configured?).and_return(false) }

      it 'refuses to create a channel with a clear error' do
        channel = described_class.new(account_id: account.id, display_name: 'X')
        expect(channel).not_to be_valid
        expect(channel.errors[:base].join).to match(/encryption keys must be configured/i)
      end
    end

    context 'when encryption IS configured' do
      before { allow(Chatwoot).to receive(:encryption_configured?).and_return(true) }

      it 'permits channel creation' do
        channel = described_class.new(account_id: account.id, display_name: 'X')
        expect(channel).to be_valid
      end
    end
  end

  describe '#name' do
    it 'returns "Zalo"' do
      expect(build(:channel_zalo).name).to eq('Zalo')
    end
  end

  describe '#effective_rate_limit' do
    let(:channel) { build(:channel_zalo) }

    it 'returns channel override when set' do
      channel.rate_limit_per_minute = 45
      expect(channel.effective_rate_limit).to eq(45)
    end

    it 'returns env default when nil' do
      channel.rate_limit_per_minute = nil
      ClimateControl.modify(ZALO_OUTBOUND_RATE_LIMIT_PER_MINUTE: '15') do
        expect(channel.effective_rate_limit).to eq(15)
      end
    rescue NameError
      # ClimateControl may not be present; fallback to ENV stubbing
      allow(ENV).to receive(:fetch).with('ZALO_OUTBOUND_RATE_LIMIT_PER_MINUTE', 20).and_return('15')
      expect(channel.effective_rate_limit).to eq(15)
    end
  end
end
