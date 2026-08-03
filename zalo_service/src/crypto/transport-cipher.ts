import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import { loadConfig } from '../config.js';

/**
 * Mirror of Rails `Zalo::TransportCipher` — the two must stay byte-compatible.
 *
 * Zalo session cookies used to cross the Rails <-> sidecar boundary in
 * plaintext over loopback HTTP, so anything observing that traffic saw full
 * session credentials (red team finding C3). Both processes already share
 * ZALO_SERVICE_INTERNAL_TOKEN, so the key is derived from it rather than
 * introducing another secret to distribute.
 *
 * Wire format: base64( iv[12] || ciphertext || gcmTag[16] )
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function derivedKey(): Buffer {
  const token = loadConfig().ZALO_SERVICE_INTERNAL_TOKEN;
  return createHash('sha256').update(token, 'utf8').digest();
}

export function encryptForRails(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derivedKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
    'base64',
  );
}

export function decryptFromRails(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('transport-cipher: payload too short to be valid');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    derivedKey(),
    raw.subarray(0, IV_LENGTH),
  );
  decipher.setAuthTag(raw.subarray(raw.length - TAG_LENGTH));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH)),
    decipher.final(),
  ]).toString('utf8');
}
