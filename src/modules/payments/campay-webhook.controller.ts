import { Body, Controller, HttpCode, Post, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CampayWebhookPayload } from '../../infra/campay/campay.service';
import { Public } from '../../shared/decorators/public.decorator';
import { CampayWebhookGuard } from './guards/campay-webhook.guard';
import { PaymentsService } from './payments.service';

/**
 * Story 3.3 / 3.14 — Campay payment-status webhook receiver.
 *
 * Authenticated by `CampayWebhookGuard`: every request must carry a valid
 * HS256 JWT in `body.signature` signed with `CAMPAY_WEBHOOK_SECRET`. The
 * guard runs BEFORE this method body, so an unsigned/forged request never
 * reaches `handleWebhook` and never writes a dedup row.
 *
 * Returns 200 + `{ received: true }` for every signed + well-formed POST
 * so Campay doesn't retry forever — even if we couldn't reconcile the
 * reference.
 */
@ApiTags('webhooks')
@Controller({ path: 'webhooks/campay', version: VERSION_NEUTRAL })
export class CampayWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @UseGuards(CampayWebhookGuard)
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Campay payment status webhook' })
  receive(@Body() payload: CampayWebhookPayload) {
    return this.payments.handleWebhook(payload);
  }
}
