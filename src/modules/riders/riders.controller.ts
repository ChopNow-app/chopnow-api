import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseFilePipeBuilder,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { ConfirmationCodeDto } from './dto/confirmation-code.dto';
import { RiderAvailabilityDto, RiderHeartbeatDto } from './dto/rider-availability.dto';
import { SubmitRiderDto } from './dto/submit-rider.dto';
import { UpdateRiderProfileDto } from './dto/update-rider-profile.dto';
import { RidersService } from './riders.service';

// KYC photos can be a little larger than menu photos — ID cards and selfies
// often need more detail. 8MB is comfortably above the typical mid-range
// Android capture (~3-5MB) and well under what HTTP / multer can handle.
const MAX_KYC_BYTES = 8 * 1024 * 1024;

const kycImagePipe = new ParseFilePipeBuilder()
  .addFileTypeValidator({ fileType: /image\/(jpe?g|png|webp|heic|heif)/ })
  .addMaxSizeValidator({ maxSize: MAX_KYC_BYTES })
  .build({ fileIsRequired: true });

@ApiTags('riders')
@Controller('riders')
export class RidersController {
  constructor(private readonly riders: RidersService) {}

  // Public — riders don't yet have an account when they submit. Throttler
  // still applies on the IP level to discourage spam.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } }) // 5/h/IP
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'idCardPhoto', maxCount: 1 },
        { name: 'selfiePhoto', maxCount: 1 },
        { name: 'vehiclePhoto', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_KYC_BYTES } },
    ),
  )
  @Post()
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: SubmitRiderDto })
  @ApiOperation({
    summary: 'Submit a rider KYC application',
    description:
      'Story 1.4 — single-shot multipart submission. Creates (or upgrades) the User and creates/updates the Rider row in PENDING_REVIEW. ' +
      'Files: idCardPhoto + selfiePhoto (always required), vehiclePhoto (required for MOTO/BICYCLE/CAR). ' +
      'licensePlate required for MOTO and CAR. ' +
      'Conflict codes: rider_already_active, phone_used_by_other_role, license_plate_already_used.',
  })
  async submit(
    @Body() dto: SubmitRiderDto,
    @UploadedFiles()
    files: {
      idCardPhoto?: Express.Multer.File[];
      selfiePhoto?: Express.Multer.File[];
      vehiclePhoto?: Express.Multer.File[];
    },
  ) {
    const idCardPhoto = files.idCardPhoto?.[0];
    const selfiePhoto = files.selfiePhoto?.[0];
    const vehiclePhoto = files.vehiclePhoto?.[0];

    // Run pipe validation on whichever files were actually sent. The service
    // still rejects missing-but-required files via BadRequestException.
    if (idCardPhoto) await kycImagePipe.transform(idCardPhoto);
    if (selfiePhoto) await kycImagePipe.transform(selfiePhoto);
    if (vehiclePhoto) await kycImagePipe.transform(vehiclePhoto);

    return this.riders.submit(dto, { idCardPhoto, selfiePhoto, vehiclePhoto });
  }

  @Roles(UserRole.RIDER)
  @ApiBearerAuth()
  @Patch('me')
  @ApiOperation({
    summary: 'Update own rider profile (Story 1.8)',
    description:
      'Rider-self-update for preferredZone and momoPhone. vehicleType, photos, and ' +
      'licensePlate changes trigger admin re-validation and live in Story 6.2.',
  })
  updateMe(@Req() req: Request, @Body() dto: UpdateRiderProfileDto) {
    const user = req.user as { id: string };
    return this.riders.updateOwn(user.id, dto);
  }

  // ── Story 4.1 / 4.4 — availability + heartbeat ─────────────────────

  @Roles(UserRole.RIDER)
  @ApiBearerAuth()
  @Patch('me/availability')
  @ApiOperation({
    summary: 'Toggle online / offline (Story 4.1)',
    description:
      '1-tap "Je commence" / "Pause". Account must be ACTIVE — riders in PENDING_REVIEW ' +
      'or CORRECTION_REQUESTED cannot go online.',
  })
  setAvailability(@Req() req: Request, @Body() dto: RiderAvailabilityDto) {
    return this.riders.setAvailability((req.user as { id: string }).id, dto);
  }

  @Roles(UserRole.RIDER)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 12, ttl: 60_000 } }) // 1 per 5s tolerated burst
  @Post('me/location')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Push 15s GPS heartbeat (Story 4.4)',
    description:
      'Updates lastLocation + lastSeenAt. Implicit online — keeps dispatch eligible ' +
      'through brief network blips. Rider is dropped from dispatch once lastSeenAt > 60s.',
  })
  pushHeartbeat(@Req() req: Request, @Body() dto: RiderHeartbeatDto) {
    return this.riders.pushHeartbeat((req.user as { id: string }).id, dto);
  }

  // ── Story 4.1 / 4.2 — rider course lifecycle ───────────────────────

  @Roles(UserRole.RIDER)
  @ApiBearerAuth()
  @Get('me/courses')
  @ApiOperation({ summary: 'List assigned + in-flight courses (Story 4.2)' })
  listCourses(@Req() req: Request) {
    return this.riders.listCourses((req.user as { id: string }).id);
  }

  @Roles(UserRole.RIDER)
  @ApiBearerAuth()
  @Patch('me/courses/:orderId/picked-up')
  @ApiOperation({
    summary: 'Rider confirms pickup at vendor (Story 4.2 / 4.13)',
    description:
      'Transitions ACCEPTED / IN_PREP / READY_PICKUP → PICKED_UP. Requires the ' +
      '4-digit pickup code from the vendor in the body. Error codes: ' +
      'wrong_pickup_code, order_not_pickupable.',
  })
  markPickedUp(
    @Req() req: Request,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: ConfirmationCodeDto,
  ) {
    return this.riders.markPickedUp((req.user as { id: string }).id, orderId, dto.code);
  }

  @Roles(UserRole.RIDER)
  @ApiBearerAuth()
  @Patch('me/courses/:orderId/delivered')
  @ApiOperation({
    summary: 'Rider confirms drop-off (Story 4.2 / 4.13)',
    description:
      'Transitions PICKED_UP → DELIVERED. Requires the 4-digit delivery code ' +
      'from the consumer in the body. Error codes: wrong_delivery_code, ' +
      'order_not_in_delivery. Delivery proof photo (Story 4.10) lands later.',
  })
  markDelivered(
    @Req() req: Request,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: ConfirmationCodeDto,
  ) {
    return this.riders.markDelivered((req.user as { id: string }).id, orderId, dto.code);
  }

  // Story 1.4 follow-up (#13) — public submission status check, same
  // pattern as POST /vendors/status. Lets a rider check approval state
  // without an account. Throttled at 5/min/IP to discourage enumeration.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get('status')
  @ApiOperation({
    summary: 'Check rider submission status by phone (Story 1.4 follow-up)',
    description:
      'Public, throttled. Returns PENDING_REVIEW / CORRECTION_REQUESTED / ACTIVE / SUSPENDED / REJECTED. 404 if no submission. No PII beyond status + timestamps.',
  })
  @ApiQuery({
    name: 'phone',
    description: 'WhatsApp phone — Cameroon local or E.164',
    example: '670000020',
  })
  getStatus(@Query('phone') phone: string) {
    if (!phone) throw new BadRequestException('phone is required');
    return this.riders.getStatusByPhone(phone);
  }
}
