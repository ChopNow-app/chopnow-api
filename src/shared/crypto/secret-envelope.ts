import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Envelope encryption for at-rest secrets that the application MUST be able to
 * decrypt (e.g. TOTP shared secrets — we need the cleartext to compute the
 * expected RFC 6238 code each verify). Argon2 won't work for those.
 *
 * Format: `<ivHex>.<authTagHex>.<ciphertextHex>`.
 *   - iv: 12 random bytes (96-bit) — standard GCM nonce length
 *   - authTag: 16 bytes from GCM
 *   - ciphertext: aes-256-gcm of the plaintext
 *
 * The key is derived once from `APP_SECRET_ENVELOPE_KEY` via SHA-256 so any
 * passphrase length is accepted while the AES-256 spec needs a 32-byte key.
 * In production set the env var to a 64-char hex string from
 * `openssl rand -hex 32`.
 *
 * Rotation: changing the key invalidates every existing ciphertext. For TOTP
 * specifically that's recoverable — the affected admins re-enroll via the
 * recovery-code flow. Document any rotation as an ops procedure.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
// GCM auth tag length. Pinned to 16 bytes (128 bits) — the maximum the
// spec allows, and the standard for production use. Pinning explicitly
// at decipher time defends against a tampered envelope where someone
// truncated the tag to a shorter value the API might otherwise accept.
const AUTH_TAG_LENGTH = 16;

function deriveKey(passphrase: string): Buffer {
  if (!passphrase) {
    throw new Error('APP_SECRET_ENVELOPE_KEY is not configured');
  }
  return createHash('sha256').update(passphrase).digest();
}

export function encryptSecret(plaintext: string, passphrase: string): string {
  const key = deriveKey(passphrase);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${authTag.toString('hex')}.${ciphertext.toString('hex')}`;
}

export function decryptSecret(envelope: string, passphrase: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 3) {
    throw new Error('invalid envelope format');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = deriveKey(passphrase);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  if (authTag.length !== AUTH_TAG_LENGTH) {
    // Reject truncated / oversized tags before they reach setAuthTag.
    // Belt-and-suspenders with the `authTagLength` option on createDecipheriv
    // — if either layer flags the mismatch, decryption fails closed.
    throw new Error('invalid auth tag length');
  }
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
