import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfig } from '@nestjs/config';
import { EnvService } from './env.service';

/**
 * Global config module — exposes the typed EnvService everywhere.
 * App.module imports this once; all other modules just inject EnvService.
 */
@Global()
@Module({
  imports: [NestConfig],
  providers: [EnvService],
  exports: [EnvService],
})
export class AppConfigModule {}
