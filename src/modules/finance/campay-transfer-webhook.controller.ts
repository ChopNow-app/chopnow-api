import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/decorators/public.decorator';
import { FinanceService } from './finance.service';

// S3 / chopnow-api#216 — Campay outbound transfer status callback.
//
// Separate route from the inbound /webhooks/campay payment webhook
// because the handling is different (resolves to VendorPayout /
// RiderPayout, not Order). Same defense pattern: public route, IP
// whitelist at the edge, structural body validation only, idempotency
// via status-guarded updateMany inside FinanceService.handleTransferWebhook.
@ApiTags('webhooks')
@Controller('webhooks/campay/transfer')
export class CampayTransferWebhookController {
  constructor(private readonly finance: FinanceService) {}

  @Public()
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
