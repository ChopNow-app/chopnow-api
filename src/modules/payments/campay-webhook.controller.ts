import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CampayWebhookPayload } from '../../infra/campay/campay.service';
import { Public } from '../../shared/decorators/public.decorator';
import { PaymentsService } from './payments.service';

/**
 * Story 3.3 / 3.14 — Campay webhook receiver.
 *
 * Public route (webhook caller has no JWT) — defense is structural:
 *   - Production: nginx whitelists Campay's IP range; this controller
 *     is unreachable from the public internet (deferred — needs Hetzner
 *     prod box).
 *   - Body: structural validation only. We don't trust amounts from
 *     the webhook; we just observe the state transition.
 *   - Idempotency: PaymentsService.handleWebhook uses a Redis lock per
 *     reference + an order-status check before flipping.
 *
 * Returns 200 + `{ received: true }` for every well-formed POST so Campay
 * doesn't retry forever — even if we couldn't reconcile the reference.
 */
@ApiTags('webhooks')
@Controller('webhooks/campay')
export class CampayWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Campay payment status webhook' })
  receive(@Body() payload: CampayWebhookPayload) {
    return this.payments.handleWebhook(payload);
  }
}
