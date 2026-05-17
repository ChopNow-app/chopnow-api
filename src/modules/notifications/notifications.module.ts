import { Module } from '@nestjs/common';
import { PushSubscriptionsController } from './push-subscriptions.controller';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WebPushService } from './web-push.service';

/**
 * Cross-cutting — Notifications.
 *
 * Web Push (VAPID, Story 1.11) is the primary channel for vendor + consumer
 * alerts. WhatsApp (via TwilioService) remains the fallback when no
 * subscription is registered or the push send returned zero deliveries.
 *
 * The fallback decision lives in each listener (e.g. OrderNotificationsService),
 * not here — different events have different policies (some warrant a
 * WhatsApp duplicate; most don't).
 */
@Module({
  controllers: [PushSubscriptionsController],
  providers: [PushSubscriptionsService, WebPushService],
  exports: [WebPushService, PushSubscriptionsService],
})
export class NotificationsModule {}
