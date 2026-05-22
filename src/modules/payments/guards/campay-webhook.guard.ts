import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../../../infra/config/env.service';
import { verifyCampayJwtSignature } from '../../../shared/crypto/campay-signature';

/**
 * Authenticates Campay webhook callbacks by verifying the JWT signature
 * Campay embeds in the `signature` field of the request body. Mounted on
 * all three Campay webhook controllers (payment, transfer, refund) so
 * one guard is the single source of truth for "this request actually
 * came from Campay."
 *
 * Failure mode: throws `UnauthorizedException` BEFORE the controller body
 * runs — that order matters, because the controllers write a dedup row
 * as their first side effect. An unsigned request that reached the
 * controller body would otherwise poison the dedup table and suppress
 * the real webhook when it arrives.
 *
 * The guard does NOT need raw bytes: Campay's signature is JWT-in-payload,
 * verified against the parsed `body.signature` field — Express's JSON
 * parser is fine.
 */
@Injectable()
export class CampayWebhookGuard implements CanActivate {
  constructor(
    @InjectPinoLogger(CampayWebhookGuard.name) private readonly logger: PinoLogger,
    private readonly env: EnvService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      body?: { signature?: string; reference?: string };
      ip?: string;
    }>();

    const signature = req.body?.signature;
    const reference = req.body?.reference; // useful in logs to diagnose which call
    const secret = this.env.campay.webhookSecret;

    if (!signature) {
      this.logger.warn(
        { event: 'campay_webhook_missing_signature', reference, ip: req.ip },
        'Campay webhook rejected — signature field missing',
      );
      throw new UnauthorizedException('invalid_signature');
    }
    if (!verifyCampayJwtSignature(signature, secret)) {
      this.logger.warn(
        { event: 'campay_webhook_bad_signature', reference, ip: req.ip },
        'Campay webhook rejected — signature verification failed',
      );
      throw new UnauthorizedException('invalid_signature');
    }
    return true;
  }
}
