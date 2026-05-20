import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/decorators/public.decorator';
import { FinanceService } from './finance.service';

// S3 / chopnow-api#90 — Campay refund settlement webhook.
//
// Separate route so the persistence-layer dedup keys cleanly on
// (eventType=REFUND, reference) without colliding with COLLECT or
// TRANSFER references.
@ApiTags('webhooks')
@Controller('webhooks/campay/refund')
export class CampayRefundWebhookController {
  constructor(private readonly finance: FinanceService) {}

  @Public()
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
