import { Module } from '@nestjs/common';
import { OpenApiController } from './openapi.controller';

/**
 * Serves the public OpenAPI spec at `/openapi.json` (unversioned, no
 * `api` prefix). Companion to SwaggerModule's UI at `/api/docs`.
 */
@Module({
  controllers: [OpenApiController],
})
export class OpenApiModule {}
