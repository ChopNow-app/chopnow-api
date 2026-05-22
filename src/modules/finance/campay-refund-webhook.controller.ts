import { Body, Controller, HttpCode, Post, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/decorators/public.decorator';
import { CampayWebhookGuard } from '../payments/guards/campay-webhook.guard';
import { FinanceService } from './finance.service';

// S3 / chopnow-api#90 — Campay refund settlement webhook.
//
// Authenticated by CampayWebhookGuard (same primitive as the payment and
// transfer webhooks): every request must carry a valid HS256 JWT in
// body.signature signed with CAMPAY_WEBHOOK_SECRET. The guard runs
// before the handler — unsigned/forged requests never reach
// FinanceService.handleRefundWebhook and never mutate refund state.
@ApiTags('webhooks')
@Controller({ path: 'webhooks/campay/refund', version: VERSION_NEUTRAL })
export class CampayRefundWebhookController {
  constructor(private readonly finance: FinanceService) {}

  @Public()
  @UseGuards(CampayWebhookGuard)
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Campay refund status webhook' })
  receive(
    @Body()
    payload: {
      status?: string;
      reference?: string;
      external_reference?: string;
      failure_reason?: string;
    },
  ) {
    return this.finance.handleRefundWebhook(payload);
  }
}
