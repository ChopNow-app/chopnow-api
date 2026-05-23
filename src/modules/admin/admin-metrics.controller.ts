import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../shared/decorators/roles.decorator';
import { ADMIN_WRITE_ROLES } from './admin.roles';
import { AdminMetricsService } from './admin-metrics.service';

const DEFAULT_WINDOW_DAYS = 7;

function parseDate(input: string | undefined, fallback: Date): Date {
  if (!input) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid date: ${input}`);
  }
  return d;
}

@ApiTags('admin-metrics')
@ApiBearerAuth()
@Controller('admin/metrics')
export class AdminMetricsController {
  constructor(private readonly metrics: AdminMetricsService) {}

  @Roles(...ADMIN_WRITE_ROLES)
  @Get()
  @ApiOperation({
    summary: 'Pilot KPI snapshot (7-day reorder rate, completion, avg times)',
    description:
      'Drives the Week-3 decision point of the COD-only pilot. Defaults to a ' +
      'rolling 7-day window. Pass ?from=&to= (ISO 8601) to inspect a custom range.',
  })
  @ApiQuery({ name: 'from', required: false, type: String, example: '2026-05-01T00:00:00Z' })
  @ApiQuery({ name: 'to', required: false, type: String, example: '2026-05-08T00:00:00Z' })
  getMetrics(@Query('from') fromRaw?: string, @Query('to') toRaw?: string) {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const from = parseDate(fromRaw, defaultFrom);
    const to = parseDate(toRaw, now);
    if (from >= to) {
      throw new BadRequestException('`from` must be earlier than `to`');
    }
    return this.metrics.getPilotMetrics(from, to);
  }
}
