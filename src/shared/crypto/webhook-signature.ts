import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify a webhook HMAC signature in constant time.
 *
 * Used by:
 *   - Campay webhooks (Story 7.8) — HMAC-SHA256 over the raw request body
 *   - Twilio webhooks (post-MVP) — Twilio sends X-Twilio-Signature using a similar scheme
 *
 * IMPORTANT: pass the *raw* request body (Buffer or string), NOT the parsed JSON,
 * because re-serializing changes byte order and breaks the signature.
 *
 * @param rawBody  The exact bytes the provider hashed (request body before JSON parse)
 * @param signature  The signature header value (hex-encoded by default)
 * @param secret  The shared secret configured with the provider
 * @param algorithm  HMAC algorithm — default sha256
 * @param encoding  Signature encoding — 'hex' (default) or 'base64'
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: string,
  secret: string,
  algorithm: 'sha256' | 'sha1' | 'sha512' = 'sha256',
  encoding: 'hex' | 'base64' = 'hex',
): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac(algorithm, secret).update(rawBody).digest(encoding);

  // Reject early on length mismatch — timingSafeEqual throws on different lengths
  const a = Buffer.from(expected, encoding);
  const b = Buffer.from(signature, encoding);
  if (a.length !== b.length) return false;

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
