import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { InitiateMomoPaymentDto } from './dto/initiate-payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('orders')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':orderId/pay/momo')
  @HttpCode(202) // accepted — final status comes via webhook
  @ApiOperation({
    summary: 'Initiate a Campay MoMo collect (Stories 3.3, 3.4)',
    description:
      'Triggers the Campay USSD prompt on the payer phone. Returns immediately with a ' +
      "reference; the order flips to CONFIRMED + PAID once Campay's webhook lands " +
      '(typically < 30s for MTN, < 2min for Orange). Error codes: ' +
      'payment_method_not_momo, order_not_payable, payment_already_processing.',
  })
  initiateMomo(
    @Req() req: Request,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: InitiateMomoPaymentDto,
  ) {
    return this.payments.initiateMomo(orderId, (req.user as { id: string }).id, dto.payerPhone);
  }
}
