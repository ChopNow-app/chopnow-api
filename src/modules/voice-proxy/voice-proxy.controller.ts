import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { VoiceProxyService } from './voice-proxy.service';

@ApiTags('voice-proxy')
@Controller()
export class VoiceProxyController {
  constructor(private readonly voice: VoiceProxyService) {}

  // Rider-side: initiate a masked call to the assigned order's consumer.
  @Roles(UserRole.RIDER)
  @ApiBearerAuth()
  @Post('orders/:orderId/call-consumer')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Start a masked rider → consumer call (Story 4.17)',
    description:
      "Twilio first calls the rider; on answer, it bridges to the order's deliveryPhone. " +
      'Both legs see TchopNow caller ID. Hard 3-min cap. Returns the Twilio call SID for ' +
      'optional client-side polling.',
  })
  callConsumer(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.voice.startRiderToConsumer(orderId, (req.user as { id: string }).id);
  }

  // Webhook: Twilio fetches this URL when the rider leg answers. We return
  // TwiML that bridges to the consumer.
  @Public()
  @Post('webhooks/twilio/voice/bridge')
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'TwiML bridge (Twilio Voice webhook)' })
  async bridge(@Query('orderId') orderId: string): Promise<string> {
    return this.voice.buildBridgeTwiml(orderId);
  }

  // Some Twilio configurations issue a GET first (e.g. when you set the
  // webhook method to GET in the console). Mirror the POST for compatibility.
  @Public()
  @Get('webhooks/twilio/voice/bridge')
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'TwiML bridge (GET fallback for Twilio Voice)' })
  bridgeGet(@Query('orderId') orderId: string): Promise<string> {
    return this.voice.buildBridgeTwiml(orderId);
  }
}
