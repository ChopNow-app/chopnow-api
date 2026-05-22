import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  VERSION_NEUTRAL,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { TwilioWebhookGuard } from '../../infra/twilio/guards/twilio-webhook.guard';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { VoiceProxyService, type CallTarget } from './voice-proxy.service';

const VALID_TARGETS: ReadonlySet<CallTarget> = new Set(['consumer', 'vendor', 'rider']);

@ApiTags('voice-proxy')
@Controller()
export class VoiceProxyController {
  constructor(private readonly voice: VoiceProxyService) {}

  // ── Rider-initiated ──────────────────────────────────────────────

  @Roles(UserRole.RIDER)
  @ApiBearerAuth()
  @Post('orders/:orderId/call-consumer')
  @HttpCode(202)
  @ApiOperation({ summary: 'Masked rider → consumer call (Story 4.17)' })
  riderCallConsumer(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.voice.startRiderToConsumer(orderId, (req.user as { id: string }).id);
  }

  // ── Vendor-initiated ─────────────────────────────────────────────

  @Roles(UserRole.VENDOR)
  @ApiBearerAuth()
  @Post('orders/:orderId/vendor-call-consumer')
  @HttpCode(202)
  @ApiOperation({ summary: 'Masked vendor → consumer call (Story 3.17)' })
  vendorCallConsumer(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.voice.startVendorToConsumer(orderId, (req.user as { id: string }).id);
  }

  @Roles(UserRole.VENDOR)
  @ApiBearerAuth()
  @Post('orders/:orderId/vendor-call-rider')
  @HttpCode(202)
  @ApiOperation({ summary: 'Masked vendor → rider call (Story 3.17)' })
  vendorCallRider(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.voice.startVendorToRider(orderId, (req.user as { id: string }).id);
  }

  // ── Consumer-initiated ───────────────────────────────────────────

  @Roles(UserRole.CONSUMER)
  @ApiBearerAuth()
  @Post('orders/:orderId/call-vendor')
  @HttpCode(202)
  @ApiOperation({ summary: 'Masked consumer → vendor call' })
  consumerCallVendor(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.voice.startConsumerToVendor(orderId, (req.user as { id: string }).id);
  }

  @Roles(UserRole.CONSUMER)
  @ApiBearerAuth()
  @Post('orders/:orderId/call-rider')
  @HttpCode(202)
  @ApiOperation({ summary: 'Masked consumer → rider call' })
  consumerCallRider(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.voice.startConsumerToRider(orderId, (req.user as { id: string }).id);
  }

  // ── TwiML bridge (Twilio webhook) ────────────────────────────────

  // Twilio POSTs (or GETs) this after the originating leg answers. The
  // ?to= query picks which party to dial — consumer, vendor, or rider.
  //
  // Authentication: `TwilioWebhookGuard` verifies X-Twilio-Signature
  // against TWILIO_AUTH_TOKEN. An attacker who knows or guesses an
  // orderId (e.g. from a shared /t/[orderId] tracking link) but lacks
  // the Twilio auth token cannot invoke the bridge — closing the
  // raw-phone-number PII leak via the TwiML <Number> element.
  // Per-method @Version(VERSION_NEUTRAL): the bridge URL is registered with
  // Twilio at call-initiation time and stays at `/api/webhooks/twilio/voice/bridge`
  // (not `/api/v1/...`). Versioning these would break in-flight calls during
  // any v2 rollout.
  @Public()
  @UseGuards(TwilioWebhookGuard)
  @Version(VERSION_NEUTRAL)
  @Post('webhooks/twilio/voice/bridge')
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'TwiML bridge (Twilio Voice webhook)' })
  bridge(@Query('orderId') orderId: string, @Query('to') to: string): Promise<string> {
    return this.voice.buildBridgeTwiml(orderId, this.parseTarget(to));
  }

  @Public()
  @UseGuards(TwilioWebhookGuard)
  @Version(VERSION_NEUTRAL)
  @Get('webhooks/twilio/voice/bridge')
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'TwiML bridge (GET fallback for Twilio Voice)' })
  bridgeGet(@Query('orderId') orderId: string, @Query('to') to: string): Promise<string> {
    return this.voice.buildBridgeTwiml(orderId, this.parseTarget(to));
  }

  private parseTarget(raw: string | undefined): CallTarget {
    // Legacy bridge URLs from the rider-only deploy don't include ?to=;
    // default to 'consumer' to preserve compatibility (the rider→consumer
    // path was the only one wired). Once all in-flight rider calls drain,
    // we can tighten this to throw on missing ?to=.
    const value = (raw ?? 'consumer').toLowerCase();
    if (!VALID_TARGETS.has(value as CallTarget)) {
      throw new BadRequestException('invalid_call_target');
    }
    return value as CallTarget;
  }
}
