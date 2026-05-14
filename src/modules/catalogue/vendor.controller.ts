import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  ParseFilePipeBuilder,
  Patch,
  Post,
  Req,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { SubmitVendorDto } from './dto/submit-vendor.dto';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';
import { VendorService } from './vendor.service';

// Photo upload guardrail. 5MB matches what the Vendor form on Android Chrome
// can realistically produce — taken with the camera, ~3MB after JPEG compression
// on a Tecno / Itel mid-range. Larger uploads typically indicate misconfigured
// clients or unscaled originals.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const imagePipe = new ParseFilePipeBuilder()
  .addFileTypeValidator({ fileType: /image\/(jpe?g|png|webp|heic|heif)/ })
  .addMaxSizeValidator({ maxSize: MAX_PHOTO_BYTES })
  .build({ fileIsRequired: true });

@ApiTags('vendors')
@Controller('vendors')
export class VendorController {
  constructor(private readonly vendors: VendorService) {}

  // Public: anyone with the share link `tchopnow.app/vendre` can submit. The
  // throttler still applies — IP-level rate limit prevents spammy resubmissions.
  // Unauthorized vendor (no JWT yet) is the whole point: they don't have an
  // account until this call creates one.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } }) // 5/h/IP
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'profilePhoto', maxCount: 1 },
        { name: 'firstItemPhoto', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_PHOTO_BYTES } },
    ),
  )
  @Post()
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: SubmitVendorDto })
  @ApiOperation({
    summary: 'Submit an informal vendor application',
    description:
      'Story 2.0 — single-shot submission for the 5-screen onboarding form. ' +
      'Creates User + Vendor + first Item atomically (Vendor.status = PENDING_REVIEW). ' +
      'Photos uploaded to R2. WhatsApp confirmation fires after commit (fire-and-forget). ' +
      'Conflict codes: vendor_already_submitted, phone_used_by_other_role.',
  })
  async submit(
    @Body() dto: SubmitVendorDto,
    @UploadedFiles()
    files: { profilePhoto?: Express.Multer.File[]; firstItemPhoto?: Express.Multer.File[] },
  ) {
    // FileFieldsInterceptor wraps each field in an array (multer convention).
    // We only accept maxCount: 1, so we unwrap before handing to the service.
    const profilePhoto = files.profilePhoto?.[0];
    const firstItemPhoto = files.firstItemPhoto?.[0];

    // Re-validate each file individually so the ParseFilePipe's MIME + size
    // checks run against the unwrapped file rather than the array.
    if (profilePhoto) await imagePipe.transform(profilePhoto);
    if (firstItemPhoto) await imagePipe.transform(firstItemPhoto);

    return this.vendors.submitInformal(dto, { profilePhoto, firstItemPhoto });
  }

  @Roles(UserRole.VENDOR)
  @ApiBearerAuth()
  @Patch('me')
  @ApiOperation({
    summary: 'Update own vendor profile (Story 1.8)',
    description:
      'Vendor-self-update for name, description, and momoPhone. Photo is a separate ' +
      'multipart endpoint (PATCH /vendors/me/photo). Quartier / landmark moves and ' +
      'commission edits stay admin-only.',
  })
  updateMe(@Req() req: Request, @Body() dto: UpdateVendorProfileDto) {
    const user = req.user as { id: string };
    return this.vendors.updateOwn(user.id, dto);
  }

  @Roles(UserRole.VENDOR)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  @Patch('me/photo')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Replace own profile photo (Story 1.8)',
    description: 'Multipart field `photo`. Same size + MIME guardrails as onboarding.',
  })
  async updateMePhoto(@Req() req: Request, @UploadedFile() photo: Express.Multer.File) {
    if (!photo) throw new BadRequestException('photo is required');
    await imagePipe.transform(photo);
    const user = req.user as { id: string };
    return this.vendors.updateOwnProfilePhoto(user.id, photo);
  }
}
