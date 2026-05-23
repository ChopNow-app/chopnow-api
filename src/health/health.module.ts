import { Module } from '@nestjs/common';
import { CampayModule } from '../infra/campay/campay.module';
import { HealthController } from './health.controller';

@Module({
  // PrismaModule + RedisModule are @Global(), no import needed.
  // CampayModule isn't — pulled in here so the deep /ready probe can
  // inspect the circuit-breaker state (Phase O5).
  imports: [CampayModule],
  controllers: [HealthController],
})
export class HealthModule {}
