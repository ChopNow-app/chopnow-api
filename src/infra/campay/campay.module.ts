import { Module } from '@nestjs/common';
import { CampayService } from './campay.service';

@Module({
  providers: [CampayService],
  exports: [CampayService],
})
export class CampayModule {}
