import { Body, Controller, Delete, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { SubscribePushDto, UnsubscribePushDto } from './dto/subscribe-push.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications/push')
export class PushSubscriptionsController {
  constructor(private readonly subs: PushSubscriptionsService) {}

  // Subscribing is a one-shot per device — the throttle is generous enough that
  // a user re-granting permission a few times in a row works fine, but stops a
  // misbehaving SW loop from hammering the endpoint.
  @Post('subscribe')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @ApiOperation({
    summary: 'Register or refresh a Web Push subscription for the current user',
    description:
      'Upserts by (userId, deviceFingerprint). Same device re-granting permission ' +
      'updates the row in place — the endpoint URL may have rotated.',
  })
  async subscribe(@Req() req: Request, @Body() dto: SubscribePushDto): Promise<{ id: string }> {
    const user = req.user as { id: string };
    return this.subs.upsert(user.id, dto);
  }

  @Delete('subscribe')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a push subscription for the current user',
    description: 'Idempotent: 204 even if the row is already gone.',
  })
  async unsubscribe(@Req() req: Request, @Body() dto: UnsubscribePushDto): Promise<void> {
    const user = req.user as { id: string };
    await this.subs.deactivateByEndpoint(user.id, dto.endpoint);
  }
}
