import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  ParseFilePipeBuilder,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { SubmitVendorDto } from './dto/submit-vendor.dto';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';
import { VendorSelfBalanceDto } from '../finance/dto/self-balance.dto';
import { FinanceService } from '../finance/finance.service';
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
  constructor(
    private readonly vendors: VendorService,
    private readonly finance: FinanceService,
  ) {}

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
        // Restaurant-only: enseigne (storefront) photo. The service only
        // persists it when type=RESTAURANT; non-restaurant submissions
        // that happen to include the file are silently dropped.
        { name: 'enseignePhoto', maxCount: 1 },
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
    files: {
      profilePhoto?: Express.Multer.File[];
      firstItemPhoto?: Express.Multer.File[];
      enseignePhoto?: Express.Multer.File[];
    },
  ) {
    // FileFieldsInterceptor wraps each field in an array (multer convention).
    // We only accept maxCount: 1, so we unwrap before handing to the service.
    const profilePhoto = files.profilePhoto?.[0];
    const firstItemPhoto = files.firstItemPhoto?.[0];
    const enseignePhoto = files.enseignePhoto?.[0];

    // Re-validate each file individually so the ParseFilePipe's MIME + size
    // checks run against the unwrapped file rather than the array.
    if (profilePhoto) await imagePipe.transform(profilePhoto);
    if (firstItemPhoto) await imagePipe.transform(firstItemPhoto);
    if (enseignePhoto) await imagePipe.transform(enseignePhoto);

    return this.vendors.submitInformal(dto, { profilePhoto, firstItemPhoto, enseignePhoto });
  }

  @Roles(UserRole.VENDOR)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({
    summary: 'Get own vendor profile',
    description:
      'Read endpoint backing the /vendor/profile editor and the type-aware menu UI. ' +
      'Returns the vendor row plus enough metadata for the dashboard to render — ' +
      'deliberately omits admin-only fields (commissionRate, rejectionReason, KYC numbers).',
  })
  getMe(@Req() req: Request) {
    const user = req.user as { id: string };
    return this.vendors.getOwn(user.id);
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

  // Self-service balance view (Story 7.2 — vendor earnings transparency).
  // Shows balance, last + next payout, recent history, and (for INFORMAL)
  // whether a cashout request is already in flight.
  @Roles(UserRole.VENDOR)
  @ApiBearerAuth()
  @Get('me/balance')
  @ApiOperation({
    summary: 'Get own balance + payout history',
    description:
      "Read-only self-service view of the vendor's ledger position. Surfaces " +
      'balanceXAF, isTrusted (drives same-day vs 24h cashout for INFORMAL), the ' +
      'last 5 payouts, and the next scheduled payout estimate. RESTAURANT and ' +
      'SEMI_FORMAL vendors see the next Sunday 02:00 Africa/Douala estimate; ' +
      'INFORMAL vendors see ON_DEMAND with no estimatedAt.',
  })
  @ApiOkResponse({ type: VendorSelfBalanceDto })
  async getMyBalance(@Req() req: Request): Promise<VendorSelfBalanceDto> {
    const user = req.user as { id: string };
    const vendor = await this.vendors.getOwn(user.id);
    return this.finance.getVendorSelfView(vendor.id);
  }

  // INFORMAL on-demand cashout request (ADR-0005, 7.2b). Creates a
  // VendorCashoutRequest with status PENDING_APPROVAL — admin must
  // approve before money moves. Refuses if another request is already
  // pending or if balance is zero / negative.
  @Roles(UserRole.VENDOR)
  @ApiBearerAuth()
  @Post('me/cashout-request')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Request an on-demand cashout (INFORMAL vendors only)',
    description:
      'Creates a VendorCashoutRequest. Admin must approve before payout fires. ' +
      'Refuses if a pending request already exists, vendor is not INFORMAL, or ' +
      'balance is non-positive. SEMI_FORMAL / RESTAURANT vendors use the Sunday cron.',
  })
  async requestCashout(@Req() req: Request) {
    const user = req.user as { id: string };
    const vendor = await this.vendors.getOwn(user.id);
    return this.finance.requestVendorCashout(vendor.id);
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

  @Roles(UserRole.VENDOR)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  @Patch('me/cover')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: "Replace own cover photo (hero image on the vendor's catalogue card)",
    description:
      'Multipart field `photo`. Same size + MIME guardrails as profile photo. The old ' +
      'R2 key is left to the lifecycle sweeper — keeps the rollback story simple if a ' +
      'failed upload need not race a delete.',
  })
  async updateMeCover(@Req() req: Request, @UploadedFile() photo: Express.Multer.File) {
    if (!photo) throw new BadRequestException('photo is required');
    await imagePipe.transform(photo);
    const user = req.user as { id: string };
    return this.vendors.updateOwnCoverPhoto(user.id, photo);
  }

  // Story 2.0 follow-up (#13) — public submission status check. Lets a
  // vendor who submitted via /vendre check their approval status without
  // creating an account first. Throttled at 5/min/IP so a malicious actor
  // can't enumerate phone numbers (the only PII exposed is the status
  // enum + timestamps; we deliberately don't return name/address).
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get('status')
  @ApiOperation({
    summary: 'Check vendor submission status by WhatsApp phone (Story 2.0 follow-up)',
    description:
      'Public, throttled. Returns PENDING_REVIEW / CORRECTION_REQUESTED / ACTIVE / SUSPENDED / REJECTED for the vendor row associated with `phone` (Cameroon local OR E.164). 404 if no submission exists. Does NOT leak name/address — only the validation lifecycle.',
  })
  @ApiQuery({
    name: 'phone',
    description: 'WhatsApp phone — Cameroon local or E.164',
    example: '670000000',
  })
  getStatus(@Query('phone') phone: string) {
    if (!phone) throw new BadRequestException('phone is required');
    return this.vendors.getStatusByPhone(phone);
  }
}
