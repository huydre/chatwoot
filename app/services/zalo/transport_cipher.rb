# Encrypts the credential fields that cross the Rails <-> Node sidecar boundary.
#
# Zalo session cookies are encrypted at rest by Active Record, but the internal
# API used to hand them to the sidecar in plaintext over loopback HTTP, so
# anything able to observe that traffic — tcpdump on lo, an intercepting proxy,
# a request log — saw full session credentials (red team finding C3).
#
# AES-256-GCM under a key derived from the shared service token both processes
# already hold. This closes passive capture of the wire. It is not a substitute
# for mTLS: an attacker who can already read either process's environment holds
# the token too.
class Zalo::TransportCipher
  class DecryptionError < StandardError; end

  CIPHER = 'aes-256-gcm'.freeze
  IV_LENGTH = 12
  TAG_LENGTH = 16

  class << self
    def encrypt(plaintext)
      return if plaintext.nil?

      cipher = OpenSSL::Cipher.new(CIPHER).encrypt
      cipher.key = key
      iv = cipher.random_iv
      ciphertext = cipher.update(plaintext) + cipher.final
      Base64.strict_encode64(iv + ciphertext + cipher.auth_tag)
    end

    def decrypt(payload)
      return if payload.blank?

      raw = Base64.strict_decode64(payload)
      cipher = OpenSSL::Cipher.new(CIPHER).decrypt
      cipher.key = key
      cipher.iv = raw[0, IV_LENGTH]
      cipher.auth_tag = raw[-TAG_LENGTH..]
      cipher.update(raw[IV_LENGTH...-TAG_LENGTH]) + cipher.final
    rescue ArgumentError, OpenSSL::Cipher::CipherError => e
      # A bad tag means the payload was truncated, corrupted or forged; a bad
      # Base64 means it was never ciphertext. Neither is recoverable.
      raise DecryptionError, e.message
    end

    private

    def key
      token = ENV.fetch('ZALO_SERVICE_INTERNAL_TOKEN', '')
      raise 'ZALO_SERVICE_INTERNAL_TOKEN must be set to exchange Zalo credentials with the sidecar' if token.blank?

      OpenSSL::Digest::SHA256.digest(token)
    end
  end
end
