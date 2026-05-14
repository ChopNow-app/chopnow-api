import { Body, Controller, Get, Patch, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Roles } from '../../shared/decorators/roles.decorator';
import { AvailabilityService } from './availability.service';
import { UpdateAvailabilityDto, UpdateHoursDto } from './dto/availability.dto';

@ApiTags('vendor-availability')
@ApiBearerAuth()
@Roles(UserRole.VENDOR)
@Controller('vendors/me')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('availability')
  @ApiOperation({
    summary: 'Read own availability + hours (Story 2.4)',
    description:
      'Returns { isOpen, hours, isOpenNow }. `isOpenNow` is a server-computed live flag; ' +
      'the dashboard renders straight from it without having to reimplement weekday/clock math.',
  })
  get(@Req() req: Request) {
    return this.availability.getOwn((req.user as { id: string }).id);
  }

  @Patch('availability')
  @ApiOperation({
    summary: 'Toggle Ouvert / Fermé (Story 2.4 — 1-tap)',
    description:
      'INFORMAL: this is the only availability signal. RESTAURANT: same toggle ' +
      'today; the future hours-cron will flip it automatically based on configured hours.',
  })
  setAvailability(@Req() req: Request, @Body() dto: UpdateAvailabilityDto) {
    return this.availability.setAvailability((req.user as { id: string }).id, dto);
  }

  @Put('hours')
  @ApiOperation({
    summary: 'Replace weekly opening hours (Story 2.4 — restaurant)',
    description:
      'Days absent from the body = closed that day. Times in 24h "HH:MM". ' +
      "INFORMAL vendors can call this too — it just won't affect isOpenNow.",
  })
  setHours(@Req() req: Request, @Body() dto: UpdateHoursDto) {
    return this.availability.setHours((req.user as { id: string }).id, dto);
  }
}
