import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as webpush from 'web-push';
import { EnvService } from '../../infra/config/env.service';
import { PushSubscriptionsService } from './push-subscriptions.service';

export interface WebPushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface SendResult {
  sent: number;
  deactivated: number;
}

/**
 * Thin wrapper over the `web-push` library.
 *
 * Reasons to live here (rather than inside OrderNotificationsService):
 *   - VAPID config is read once at boot and reused for every send.
 *   - The 410 Gone cleanup (browsers retire endpoints) is a generic concern
 *     that any future caller — consumer push, rider push — will need.
 *   - Tests for the listener can mock this surface cleanly.
 *
 * Failure modes:
 *   - VAPID env not configured → all sends fast-return { sent: 0 } so the
 *     caller's WhatsApp fallback fires. Logged once at boot for ops.
 *   - One subscription failing must not break the batch. We use Promise.allSettled
 *     and per-row try/catch in the deactivation pass.
 */
@Injectable()
export class WebPushService {
  private configured = false;

  constructor(
    @InjectPinoLogger(WebPushService.name) private readonly logger: PinoLogger,
    private readonly env: EnvService,
    private readonly subs: PushSubscriptionsService,
  ) {
    const v = this.env.vapid;
    if (v.publicKey && v.privateKey && v.subject) {
      webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
      this.configured = true;
    } else {
      this.logger.warn(
        { event: 'vapid_unconfigured' },
        'VAPID env vars missing — Web Push disabled, callers will fall back to WhatsApp',
      );
    }
  }

  async sendToUser(userId: string, payload: WebPushPayload): Promise<SendResult> {
    if (!this.configured) return { sent: 0, deactivated: 0 };

    const subscriptions = await this.subs.listForUser(userId);
    if (subscriptions.length === 0) return { sent: 0, deactivated: 0 };

    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(
      subscriptions.map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        ),
      ),
    );

    let sent = 0;
    let deactivated = 0;
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        sent += 1;
        continue;
      }
      const err = r.reason as { statusCode?: number; message?: string };
      // 404 Not Found / 410 Gone → endpoint retired by the push service.
      // Anything else (413 too large, 429 rate-limited, network blip) is
      // transient — leave the row in place and try again next event.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await this.subs.deactivateById(subscriptions[i].id);
        deactivated += 1;
      } else {
        this.logger.warn(
          {
            event: 'web_push_transient_failure',
            subscriptionId: subscriptions[i].id,
            endpointPrefix: subscriptions[i].endpoint.slice(0, 60),
            statusCode: err?.statusCode,
            error: err?.message,
          },
          'Web Push delivery failed transiently — subscription kept',
        );
      }
    }

    return { sent, deactivated };
  }
}
