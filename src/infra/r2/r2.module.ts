import { Global, Module } from '@nestjs/common';
import { R2Service } from './r2.service';
import { MediaController } from './media.controller';

@Global()
@Module({
  controllers: [MediaController],
  providers: [R2Service],
  exports: [R2Service],
})
export class R2Module {}
