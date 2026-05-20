import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CampayWebhookDedupService } from './campay-webhook-dedup.service';
import { CampayService } from './campay.service';

@Module({
  imports: [PrismaModule],
  providers: [CampayService, CampayWebhookDedupService],
  exports: [CampayService, CampayWebhookDedupService],
})
export class CampayModule {}
