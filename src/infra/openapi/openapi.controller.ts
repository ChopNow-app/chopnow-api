import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Public } from '../../shared/decorators/public.decorator';
import { OpenApiDocStore } from './openapi-doc.store';

/**
 * Public OpenAPI spec endpoint.
 *
 * Serves the in-memory OpenAPI document at `/openapi.json` (excluded
 * from the global `api` prefix in main.ts), so any external client —
 * Postman, Bruno, Insomnia, openapi-typescript generators — can fetch
 * the live spec from one stable URL per environment:
 *
 *   - dev:     http://localhost:3001/openapi.json
 *   - staging: https://api-staging.tchopnow.app/openapi.json
 *   - prod:    https://api.tchopnow.app/openapi.json
 *
 * Why this exists alongside `/api/docs` (Swagger UI): the UI is for
 * humans; this endpoint is for tooling. Auto-publishing the spec on
 * every deploy means the committed `openapi.json` in the repo is a
 * snapshot, not the source of truth — there's no chance of the file
 * going stale relative to the running API.
 *
 * Returns 503 if the SwaggerModule build failed at boot (e.g. circular
 * DTO refs) — that surfaces the breakage instead of silently 404'ing.
 * Cached 5 minutes at the edge — the spec only changes on redeploy.
 */
@Controller({ path: 'openapi.json', version: VERSION_NEUTRAL })
export class OpenApiController {
  @Public()
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  get(): object {
    const doc = OpenApiDocStore.get();
    if (!doc) {
      throw new ServiceUnavailableException({
        message:
          'OpenAPI spec unavailable — Swagger document build failed at boot. Check API logs for the circular-dependency warning.',
        code: 'openapi_build_failed',
      });
    }
    return doc;
  }
}
