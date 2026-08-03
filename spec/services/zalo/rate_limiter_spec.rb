require 'rails_helper'

RSpec.describe Zalo::RateLimiter do
  let(:session_id) { "test-rl-#{SecureRandom.hex(4)}" }

  after do
    described_class.new(session_id).reset!
  end

  describe '.allow?' do
    it 'allows calls under the limit' do
      3.times do |i|
        expect(described_class.allow?(session_id, limit: 5)).to be(true), "attempt #{i + 1} should allow"
      end
    end

    it 'blocks calls once the limit is reached' do
      3.times { described_class.allow?(session_id, limit: 3) }
      expect(described_class.allow?(session_id, limit: 3)).to be(false)
    end

    it 'fails open when Redis raises' do
      allow_any_instance_of(Redis).to receive(:incr).and_raise(Redis::BaseError, 'down')
      expect(described_class.allow?(session_id, limit: 3)).to be(true)
    end
  end

  describe '#reset!' do
    it 'clears the bucket' do
      3.times { described_class.allow?(session_id, limit: 3) }
      described_class.new(session_id).reset!
      expect(described_class.allow?(session_id, limit: 3)).to be(true)
    end
  end
end
