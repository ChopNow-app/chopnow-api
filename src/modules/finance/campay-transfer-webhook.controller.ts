import { Body, Controller, HttpCode, Post, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/decorators/public.decorator';
import { CampayWebhookGuard } from '../payments/guards/campay-webhook.guard';
import { FinanceService } from './finance.service';

// S3 / chopnow-api#216 — Campay outbound transfer status callback.
//
// Authenticated by CampayWebhookGuard: every request must carry a valid
// HS256 JWT in body.signature signed with CAMPAY_WEBHOOK_SECRET. The
// guard runs before the handler so unsigned/forged requests never
// reach FinanceService.handleTransferWebhook and never mutate payout
// state.
@ApiTags('webhooks')
@Controller({ path: 'webhooks/campay/transfer', version: VERSION_NEUTRAL })
export class CampayTransferWebhookController {
  constructor(private readonly finance: FinanceService) {}

  @Public()
  @UseGuards(CampayWebhookGuard)
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Campay outbound transfer status webhook' })
  receive(
    @Body()
    payload: {
      status?: string;
      reference?: string;
      external_reference?: string;
      failure_reason?: string;
    },
  ) {
    return this.finance.handleTransferWebhook(payload);
  }
}
