import jwt from 'jsonwebtoken';

/**
 * Test helper: mint a valid Campay webhook signature so integration
 * tests can pass through `CampayWebhookGuard`. Mirrors what Campay
 * actually sends in production — an HS256 JWT in the `signature`
 * field of the payload, signed with the shared secret.
 *
 * Usage:
 *   const body = signCampayWebhook(
 *     { status: 'SUCCESSFUL', reference: 'TC-ABCDE' },
 *     process.env.CAMPAY_WEBHOOK_SECRET!,
 *   );
 *   await request(app).post('/api/webhooks/campay').send(body);
 */
export function signCampayWebhook<T extends Record<string, unknown>>(
  body: T,
  secret: string,
): T & { signature: string } {
  const signature = jwt.sign(body, secret, { algorithm: 'HS256' });
  return { ...body, signature };
}
