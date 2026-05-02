import { Module } from '@nestjs/common';

/**
 * Cross-cutting — Notifications.
 * Web Push (VAPID, Story 1.11), Twilio WhatsApp (one-way + OTP), SMS fallback.
 * Listens for domain events and fans out delivery to each user's active channels.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class NotificationsModule {}
