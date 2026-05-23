import { Controller, Get, HttpCode, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Res } from '@nestjs/common';

import { CampayCircuitBreakerService } from '../infra/campay/campay-circuit-breaker.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';
import { Public } from '../shared/decorators/public.decorator';

/**
 * Two probes, two different audiences:
 *
 *   - `/health` (liveness) — answers "is the process alive?". The
 *     Docker healthcheck calls this on a 30s interval; if it fails the
 *     container restarts. Must NOT touch any external dependency,
 *     otherwise a Redis hiccup would restart the API for no reason.
 *
 *   - `/ready` (readiness, Phase O5) — answers "can this instance
 *     serve real traffic?". Probes Postgres + Redis. Returns 503 on
 *     any hard dependency failure so a load balancer / orchestrator
 *     drops the instance out of rotation rather than serving 500s
 *     to users.
 *
 *   - Soft dependency check: Campay circuit breaker state. We report
 *     it for visibility but DO NOT 503 on it — a Campay outage is a
 *     business-degradation, not an API failure (orders are still
 *     creatable; payment flow surfaces a structured error instead).
 */
@ApiTags('health')
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly campayBreaker: CampayCircuitBreakerService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, cache] = await Promise.all([this.checkDb(), this.checkRedis()]);
    const campay = this.campayBreaker.getState().state; // CLOSED | OPEN | HALF_OPEN

    const allHardOk = db === 'up' && cache === 'up';
    if (!allHardOk) {
      // Hard-dependency outage → 503 so an LB drops us from rotation.
      // Body still carries the per-dep verdict so the operator can
      // diagnose without grepping logs.
      res.status(503);
      return { status: 'degraded', db, redis: cache, campay };
    }
    return { status: 'ready', db, redis: cache, campay };
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<'up' | 'down'> {
    try {
      // ioredis `.ping()` returns 'PONG' on success.
      const result = await this.redis.client.ping();
      return result === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
