import {
  Body,
  Controller,
  HttpCode,
  ParseFilePipeBuilder,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../shared/decorators/public.decorator';
import { SubmitRiderDto } from './dto/submit-rider.dto';
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
}
