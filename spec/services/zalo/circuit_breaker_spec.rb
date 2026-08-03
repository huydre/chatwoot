require 'rails_helper'

RSpec.describe Zalo::CircuitBreaker do
  let(:session_id) { "test-cb-#{SecureRandom.hex(4)}" }

  after do
    described_class.record_success(session_id)
  end

  describe '.open?' do
    it 'starts closed' do
      expect(described_class.open?(session_id)).to be(false)
    end
  end

  describe '.record_failure' do
    it 'opens the circuit after threshold failures' do
      3.times { described_class.record_failure(session_id) }
      expect(described_class.open?(session_id)).to be(true)
    end

    it 'stays closed before threshold' do
      2.times { described_class.record_failure(session_id) }
      expect(described_class.open?(session_id)).to be(false)
    end
  end

  describe '.record_success' do
    it 'closes an open circuit' do
      3.times { described_class.record_failure(session_id) }
      described_class.record_success(session_id)
      expect(described_class.open?(session_id)).to be(false)
    end

    it 'resets the failure counter' do
      2.times { described_class.record_failure(session_id) }
      described_class.record_success(session_id)
      2.times { described_class.record_failure(session_id) }
      expect(described_class.open?(session_id)).to be(false) # fresh counter
    end
  end

  describe 'Redis error handling' do
    it 'fails closed as closed when open? errors' do
      allow_any_instance_of(Redis).to receive(:get).and_raise(Redis::BaseError, 'down')
      expect(described_class.open?(session_id)).to be(false)
    end
  end
end
