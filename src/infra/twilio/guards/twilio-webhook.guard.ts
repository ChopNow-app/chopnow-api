import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { validateRequest } from 'twilio';
import { EnvService } from '../../config/env.service';

/**
 * Verifies that an incoming HTTP request really came from Twilio by
 * validating the `X-Twilio-Signature` header against our Twilio auth
 * token. Mounted via `@UseGuards(TwilioWebhookGuard)` on every Twilio
 * webhook endpoint:
 *   - /api/twilio/status               (SMS / WhatsApp delivery callbacks)
 *   - /api/webhooks/twilio/voice/bridge (voice TwiML bridge, GET + POST)
 *
 * In `nodeEnv !== 'production'` the guard is a no-op so local dev and
 * the (production-mode) staging droplet — wait, staging IS production
 * mode in this project — can still be exercised. To be clear: this
 * guard is ACTIVE on staging because staging runs `NODE_ENV=production`.
 *
 * URL reconstruction: we use `${env.appUrl}${req.originalUrl}` (trusted
 * env value + the actual path Twilio called), NOT `req.get('host')`.
 * The host header can be spoofed; appUrl can't.
 *
 * `twilio.validateRequest` accepts either GET (body empty, query in URL)
 * or POST (body params, URL with or without query) — same primitive used
 * by the existing inline check in TwilioWebhookController pre-extraction.
 */
@Injectable()
export class TwilioWebhookGuard implements CanActivate {
  constructor(
    @InjectPinoLogger(TwilioWebhookGuard.name) private readonly logger: PinoLogger,
    private readonly env: EnvService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    // In dev/test the guard is a no-op so the endpoint can be exercised
    // with curl + integration tests don't have to mint Twilio signatures.
    if (this.env.nodeEnv !== 'production') return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const { authToken } = this.env.twilio;
    if (!authToken) {
      this.logger.error(
        { event: 'twilio_webhook_missing_token', path: req.originalUrl },
        'Twilio webhook rejected — TWILIO_AUTH_TOKEN not configured',
      );
      throw new ForbiddenException('webhook not configured');
    }

    const signature = req.header('x-twilio-signature') ?? '';
    if (!signature) {
      this.logger.warn(
        { event: 'twilio_webhook_missing_signature', path: req.originalUrl, ip: req.ip },
        'Twilio webhook rejected — X-Twilio-Signature header missing',
      );
      throw new ForbiddenException('invalid twilio signature');
    }

    // appUrl is the trusted public origin (e.g. https://api-staging.tchopnow.app);
    // originalUrl is the request path INCLUDING the query string. Together
    // they reconstruct exactly what Twilio signed when it dispatched the
    // request to us.
    const url = `${this.env.appUrl}${req.originalUrl}`;

    // For POST: req.body holds form params. For GET: body is empty/missing.
    const params: Record<string, string> =
      (req.body && typeof req.body === 'object' ? (req.body as Record<string, string>) : {}) ?? {};

    const valid = validateRequest(authToken, signature, url, params);
    if (!valid) {
      this.logger.warn(
        { event: 'twilio_webhook_bad_signature', path: req.originalUrl, ip: req.ip },
        'Twilio webhook rejected — signature verification failed',
      );
      throw new ForbiddenException('invalid twilio signature');
    }
    return true;
  }
}
