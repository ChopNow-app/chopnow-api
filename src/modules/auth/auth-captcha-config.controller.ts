import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnvService } from '../../infra/config/env.service';
import { Public } from '../../shared/decorators/public.decorator';

/**
 * Public CAPTCHA configuration endpoint.
 *
 * Returns the current Turnstile widget state for the consumer PWA so the
 * frontend can render (or skip) the widget without baking the flag in at
 * build time. This is the single source of truth — flipping the backend
 * env (`CAPTCHA_ENABLED` + `TURNSTILE_SITE_KEY`) propagates to every
 * client at the next page load, no Vercel rebuild required.
 *
 * Cached for 60 seconds at the edge so we don't hammer the API on every
 * login-page load; the activation runbook accepts a 1-minute propagation
 * delay as a fair price for "no frontend deploy."
 *
 * Separate controller (not on AuthController) because it's pure config
 * lookup with no auth dependencies — easier to test and to reason about.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthCaptchaConfigController {
  constructor(private readonly env: EnvService) {}

  @Public()
  @Get('captcha-config')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'Public CAPTCHA / Turnstile configuration',
    description:
      'Single source of truth for whether the consumer PWA should render the Turnstile widget. Edge-cached 60s.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        siteKey: { type: 'string', nullable: true },
      },
      required: ['enabled', 'siteKey'],
    },
  })
  captchaConfig(): { enabled: boolean; siteKey: string | null } {
    const { enabled, turnstileSiteKey } = this.env.captcha;
    // Clamp: if the flag is on but the site key is missing, the widget
    // cannot actually render — report disabled to spare the PWA from a
    // broken half-on state. Matches TurnstileGuard's "missing secret =>
    // fail open" behavior so backend and frontend agree.
    const effective = enabled && Boolean(turnstileSiteKey);
    return {
      enabled: effective,
      siteKey: effective ? (turnstileSiteKey as string) : null,
    };
  }
}
