import { Module } from '@nestjs/common';
import { VoiceProxyController } from './voice-proxy.controller';
import { VoiceProxyService } from './voice-proxy.service';

/**
 * Story 4.17 — Twilio Voice masked bridge.
 *
 * POST /orders/:id/call-consumer       — rider taps the call button
 * POST /webhooks/twilio/voice/bridge   — Twilio fetches TwiML on answer
 * GET  /webhooks/twilio/voice/bridge   — Twilio fallback if configured as GET
 *
 * Validated by POC-4 on 2026-04-13. Caller ID = TWILIO_VOICE_FROM; both
 * legs are masked. Hard 3-min cap via timeLimit.
 *
 * Authentication of the TwiML bridge: `TwilioWebhookGuard` (from
 * `infra/twilio/guards`) verifies X-Twilio-Signature on every call.
 * Without the auth token an attacker who learns an orderId from a
 * shared /t/[orderId] tracking link cannot dump the raw phone numbers
 * the TwiML embeds.
 *
 * Deferred:
 *   - Consumer → rider call (same shape; needs a separate endpoint with
 *     the consumer role guard).
 *   - Call audit table for dispute resolution (Twilio dashboard suffices
 *     for MVP volumes).
 *   - Per-call HMAC bridge tokens (defense in depth, post-pilot).
 *   - Caddy-layer Twilio IP allowlist (infra change, separate ticket).
 */
@Module({
  controllers: [VoiceProxyController],
  providers: [VoiceProxyService],
  exports: [VoiceProxyService],
})
export class VoiceProxyModule {}
