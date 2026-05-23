import { timingSafeEqual } from 'node:crypto';

import { Controller, Get, Req, Res, UnauthorizedException, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { register } from 'prom-client';

import { Public } from '../../shared/decorators/public.decorator';

/**
 * Prometheus metrics endpoint. Serves the default prom-client registry.
 *
 * Auth model:
 *   - `METRICS_AUTH_TOKEN` env unset/empty → endpoint is open. Right
 *     default for local dev + any deploy where /metrics is bound to
 *     localhost behind a reverse proxy that filters paths.
 *   - `METRICS_AUTH_TOKEN` set → endpoint requires
 *     `Authorization: Bearer <token>` matching the env value. Used in
 *     deploys where /metrics is exposed past the reverse proxy
 *     (e.g. for Grafana Cloud scraping).
 *
 * The compare uses `timingSafeEqual` to avoid leaking which prefix
 * of the token an attacker matched via response-time analysis. Both
 * sides are coerced to the same byte length first since the function
 * throws on mismatched lengths.
 *
 * @Public() so the global JWT guard skips this route — the bearer
 * check below replaces it for the metrics auth path.
 */
@ApiExcludeController()
@Controller({ version: VERSION_NEUTRAL })
export class MetricsController {
  @Public()
  @Get('metrics')
  async index(
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const expected = process.env.METRICS_AUTH_TOKEN;
    if (expected && expected.length > 0) {
      const raw = req.headers.authorization ?? '';
      const presented = raw.replace(/^Bearer\s+/i, '');
      if (!presented || !constantTimeEqual(presented, expected)) {
        throw new UnauthorizedException('metrics_unauthorized');
      }
    }
    response.setHeader('Content-Type', register.contentType);
    return register.metrics();
  }
}

/**
 * Wrapper around node's `timingSafeEqual` that:
 *   - tolerates differing input lengths (the underlying call throws)
 *   - returns false fast for the obvious-mismatch case
 *   - still runs a constant-time compare on the common-length prefix
 *     so the timing channel doesn't leak HOW MUCH of the token matched
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Run timingSafeEqual on equal-length buffers anyway so the call
    // takes the same time as a true compare would. Result is discarded.
    const pad = Buffer.alloc(Math.max(aBuf.length, bBuf.length));
    timingSafeEqual(pad, pad);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
