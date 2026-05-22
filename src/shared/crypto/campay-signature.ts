import jwt from 'jsonwebtoken';

/**
 * Verify a Campay webhook signature.
 *
 * Campay signs every webhook by including a JWT in the `signature` field
 * of the payload itself (not a header). The JWT is HS256, signed with the
 * webhook secret configured in the Campay dashboard, and its claims
 * mirror the top-level payload (status, reference, amount, etc.). To
 * verify, decode the JWT with our shared secret and assert it matches.
 *
 * Returns `true` only when the JWT verifies cleanly under HS256 with the
 * given secret. Any error (missing signature, wrong algorithm, expired,
 * tampered) returns `false` — no exception leaks to the caller.
 *
 * Doc reference: https://documenter.getpostman.com/view/2391374/T1LV8PVA
 * (Campay webhook section — "signature" field).
 *
 * @param signatureJwt  The `signature` string from the webhook payload
 * @param secret        CAMPAY_WEBHOOK_SECRET from env
 */
export function verifyCampayJwtSignature(
  signatureJwt: string | undefined | null,
  secret: string | undefined | null,
): boolean {
  if (!signatureJwt || !secret) return false;
  try {
    jwt.verify(signatureJwt, secret, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
}
