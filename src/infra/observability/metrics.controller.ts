import { Controller, Get, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { register } from 'prom-client';

import { Public } from '../../shared/decorators/public.decorator';

/**
 * Prometheus metrics endpoint. Serves the default prom-client registry.
 *
 * Pattern intentionally mirrors `HealthController`:
 *   - `@Controller({ version: VERSION_NEUTRAL })` opts out of URI
 *     versioning so the route doesn't get a `/v1/` prefix
 *   - `@Get('metrics')` puts the path on the method decorator so
 *     `setGlobalPrefix('api', { exclude: ['metrics'] })` in main.ts
 *     can match and strip the global `/api` prefix
 *   - `@Public()` so the global JWT guard skips it
 *
 * Final route: `/metrics`, no auth, returns Prometheus text format.
 */
@ApiExcludeController()
@Controller({ version: VERSION_NEUTRAL })
export class MetricsController {
  @Public()
  @Get('metrics')
  async index(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('Content-Type', register.contentType);
    return register.metrics();
  }
}
