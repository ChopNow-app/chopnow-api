import { Controller, Get } from '@nestjs/common';
import { Public } from '../shared/decorators/public.decorator';
import { PrismaService } from '../infra/prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', db: 'up' };
    } catch {
      return { status: 'degraded', db: 'down' };
    }
  }
}
