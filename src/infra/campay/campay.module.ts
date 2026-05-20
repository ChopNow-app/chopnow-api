import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CampayCircuitBreakerService } from './campay-circuit-breaker.service';
import { CampayWebhookDedupService } from './campay-webhook-dedup.service';
import { CampayService } from './campay.service';

@Module({
  imports: [PrismaModule],
  providers: [CampayService, CampayWebhookDedupService, CampayCircuitBreakerService],
  exports: [CampayService, CampayWebhookDedupService, CampayCircuitBreakerService],
})
export class CampayModule {}
