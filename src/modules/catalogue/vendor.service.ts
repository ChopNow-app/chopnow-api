import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole, VendorStatus, VendorType } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { R2Service } from '../../infra/r2/r2.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { normalizePhone } from '../../shared/phone/phone.util';
import { CAPACITY_TO_INT, SubmitVendorDto } from './dto/submit-vendor.dto';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';

// Default pickup point for newly-submitted vendors. Story 2.15 (landmarks)
// will replace this with the resolved landmark coordinates; for now we plant
// the pin at Douala city center so the geography column has a valid value.
// The pin is NOT shown to consumers — it only matters once dispatch starts
// computing distances (Sprint 2+).
const DOUALA_CENTER_LNG = 9.7679;
const DOUALA_CENTER_LAT = 4.0511;

/** Vendor onboarding domain service — Story 2.0 (informal vendor flow). */
@Injectable()
export class VendorService {
  constructor(
    @InjectPinoLogger(VendorService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly twilio: TwilioService,
  ) {}

  async submitInformal(
    dto: SubmitVendorDto,
    files: {
      profilePhoto?: Express.Multer.File;
      firstItemPhoto?: Express.Multer.File;
      enseignePhoto?: Express.Multer.File;
    },
  ): Promise<{ vendorId: string; status: VendorStatus; message: string }> {
    if (!files.profilePhoto) throw new BadRequestException('profilePhoto is required');
    if (!files.firstItemPhoto) throw new BadRequestException('firstItemPhoto is required');
    if (dto.type === VendorType.RESTAURANT && !files.enseignePhoto) {
      throw new BadRequestException({
        code: 'enseigne_photo_required',
        message: 'enseignePhoto is required for restaurant submissions',
      });
    }

    const whatsappPhone = normalizePhone(dto.whatsappPhone);
    const momoPhone = normalizePhone(dto.momoPhone);

    // Idempotency — one Vendor per phone. A returning consumer can become a
    // vendor (we upgrade their role inside the transaction below), but a
    // phone that already has a vendor row must not submit again.
    const existingUser = await this.prisma.user.findUnique({
      where: { phone: whatsappPhone },
      include: { vendor: true },
    });
    if (existingUser?.vendor) {
      throw new ConflictException({
        code: 'vendor_already_submitted',
        message: 'A vendor profile already exists for this phone number.',
      });
    }

    // Upload BEFORE the transaction so a slow/failed upload doesn't hold a
    // DB transaction open. If the transaction subsequently fails, the
    // uploaded objects become orphans — acceptable; an R2 lifecycle rule
    // can sweep stale keys with no DB reference later.
    //
    // Restaurant enseigne photo lives under its own `vendor-kyc/` prefix.
    // Same R2 bucket as everything else (public) — the storefront photo
    // doesn't carry sensitive info, and the prefix gives us a single
    // place to flip the privacy lifecycle later if needed without
    // touching the upload code.
    const enseigneUploadPromise =
      dto.type === VendorType.RESTAURANT && files.enseignePhoto
        ? this.r2.uploadImage(files.enseignePhoto.buffer, { keyPrefix: 'vendor-kyc' })
        : Promise.resolve(null);
    const [profileUpload, firstItemUpload, enseigneUpload] = await Promise.all([
      this.r2.uploadImage(files.profilePhoto.buffer, { keyPrefix: 'vendor-profile' }),
      this.r2.uploadImage(files.firstItemPhoto.buffer, { keyPrefix: 'item-photo' }),
      enseigneUploadPromise,
    ]);

    const capacityInt = CAPACITY_TO_INT[dto.declaredCapacity];
    const vendorId = randomUUID();

    // Coordinates: prefer client-provided GPS, fall back to Douala center
    // when the vendor onboards without a GPS-enabled device. Pre-pilot
    // (before this DTO field shipped) every vendor landed at city center —
    // captured-from-device coords are a strict improvement.
    const vendorLat = dto.latitude ?? DOUALA_CENTER_LAT;
    const vendorLng = dto.longitude ?? DOUALA_CENTER_LNG;

    // Vendor type: defaults to INFORMAL when the form doesn't capture it.
    // Per the schema comment, the badge tracks the type.
    const vendorType = dto.type ?? VendorType.INFORMAL;
    const badgeForType: Record<VendorType, string> = {
      [VendorType.INFORMAL]: 'Cuisine locale 🍲',
      [VendorType.SEMI_FORMAL]: 'Maquis 🍽️',
      [VendorType.RESTAURANT]: 'Restaurant 🍽️',
    };
    const badge = badgeForType[vendorType];

    await this.prisma.$transaction(async (tx) => {
      // 1) Ensure a User row. New phone → create with VENDOR role. Existing
      // CONSUMER who's becoming a vendor → upgrade role. (Other roles —
      // RIDER, ADMIN — are rejected, since vendor onboarding from those
      // accounts isn't supported.)
      let userId: string;
      if (!existingUser) {
        const created = await tx.user.create({
          data: { phone: whatsappPhone, role: UserRole.VENDOR },
        });
        userId = created.id;
      } else {
        if (existingUser.role !== UserRole.CONSUMER && existingUser.role !== UserRole.VENDOR) {
          throw new ConflictException({
            code: 'phone_used_by_other_role',
            message: 'This phone is registered for a non-vendor account.',
          });
        }
        if (existingUser.role === UserRole.CONSUMER) {
          await tx.user.update({
            where: { id: existingUser.id },
            data: { role: UserRole.VENDOR },
          });
        }
        userId = existingUser.id;
      }

      // 2) Insert vendor row. `location` is `geography(Point, 4326) NOT NULL`
      // which Prisma marks `Unsupported` — we have to populate it via raw
      // SQL. Everything else still gets the safety of parameterised binding.
      // Restaurant KYC columns (rccmNumber, niuNumber, enseignePhotoUrl)
      // pass NULL for non-restaurant submissions.
      await tx.$executeRaw`
        INSERT INTO vendors (
          id, "userId", name, "ownerName", type, status, quartier, "pointOfReference",
          "whatsappPhone", "momoPhone", badge, "declaredCapacity",
          "profilePhotoUrl", "rccmNumber", "niuNumber", "enseignePhotoUrl",
          location, "submittedAt", "createdAt", "updatedAt"
        ) VALUES (
          ${vendorId},
          ${userId},
          ${dto.name},
          ${dto.ownerName},
          ${vendorType}::"VendorType",
          ${VendorStatus.PENDING_REVIEW}::"VendorStatus",
          ${dto.quartier},
          ${dto.pointOfReference ?? null},
          ${whatsappPhone},
          ${momoPhone},
          ${badge},
          ${capacityInt},
          ${profileUpload.key},
          ${dto.rccmNumber ?? null},
          ${dto.niuNumber ?? null},
          ${enseigneUpload?.key ?? null},
          ST_SetSRID(ST_MakePoint(${vendorLng}, ${vendorLat}), 4326)::geography,
          NOW(), NOW(), NOW()
        )
      `;

      // 3) Menu items (Écran 5 + multi-item extension #12).
      // First item carries the hero photo and is always present.
      // Up to 2 extras come from optional flat fields (extraItem{1,2}Name +
      // extraItem{1,2}PriceXAF); the consistency check below requires both
      // halves of each extra pair to be present (or both absent).
      const extras: Array<{ name: string; priceXAF: number; sortOrder: number }> = [];
      if (dto.extraItem1Name && dto.extraItem1PriceXAF) {
        extras.push({ name: dto.extraItem1Name, priceXAF: dto.extraItem1PriceXAF, sortOrder: 1 });
      }
      if (dto.extraItem2Name && dto.extraItem2PriceXAF) {
        extras.push({ name: dto.extraItem2Name, priceXAF: dto.extraItem2PriceXAF, sortOrder: 2 });
      }

      await tx.item.createMany({
        data: [
          {
            vendorId,
            name: dto.firstItemName,
            priceXAF: dto.firstItemPriceXAF,
            photoUrl: firstItemUpload.key,
            isAvailable: true,
            isInStock: true,
            sortOrder: 0,
          },
          ...extras.map((e) => ({
            vendorId,
            name: e.name,
            priceXAF: e.priceXAF,
            photoUrl: null,
            isAvailable: true,
            isInStock: true,
            sortOrder: e.sortOrder,
          })),
        ],
      });
    });

    // Fire-and-forget WhatsApp confirmation. A delivery failure doesn't
    // affect the submission outcome — the vendor sees the on-screen
    // confirmation immediately. Twilio is reachable from the dashboard
    // notification UI for retries (Story 2.13).
    void this.sendSubmissionConfirmation(whatsappPhone, dto.name);

    return {
      vendorId,
      status: VendorStatus.PENDING_REVIEW,
      message: '✅ Demande envoyée ! Notre équipe vous contacte sur WhatsApp dans les 2 heures.',
    };
  }

  /**
   * Vendor self-read. Backs the /vendor/profile editor and the type-aware
   * menu UI (which needs `type` to decide between FOOD/DRINK kind tabs and
   * MenuCategory grouping). Deliberately omits admin-only columns — a
   * vendor must not see their own commissionRate, rejectionReason, or KYC
   * numbers (the KYC text fields, when later added, stay admin-visible
   * because changing them retroactively requires re-validation).
   */
  async getOwn(userId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        status: true,
        quartier: true,
        pointOfReference: true,
        whatsappPhone: true,
        momoPhone: true,
        badge: true,
        isOpen: true,
        profilePhotoUrl: true,
        coverPhotoUrl: true,
        declaredCapacity: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');
    return vendor;
  }

  /**
   * Story 1.8 — vendor self-update.
   *
   * Editable in this slice: name, description, momoPhone, and (separately)
   * the profile photo via PATCH /vendors/me/photo. Quartier / landmark
   * moves, vehicleType-equivalent badge changes, and commission edits stay
   * admin-only and live elsewhere.
   */
  async updateOwn(userId: string, dto: UpdateVendorProfileDto) {
    if (Object.values(dto).every((v) => v === undefined)) {
      throw new BadRequestException('no_fields_to_update');
    }

    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');

    return this.prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        name: dto.name,
        description: dto.description,
        momoPhone: dto.momoPhone ? normalizePhone(dto.momoPhone) : undefined,
      },
      select: {
        id: true,
        name: true,
        description: true,
        momoPhone: true,
        status: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Story 2.0 follow-up (#13) — phone-keyed submission status check.
   * Returns just enough for the vendor to know whether they should keep
   * waiting (PENDING_REVIEW), fix something (CORRECTION_REQUESTED), or
   * are good to go (ACTIVE). Throws 404 when no submission exists.
   *
   * Deliberately does NOT return name / address / KYC photos — those are
   * already exposed by /vendors/:id for ACTIVE rows. Keeping the surface
   * minimal so the public throttled endpoint can't be used as an
   * enumeration tool against the rest of the vendor profile.
   */
  async getStatusByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    const vendor = await this.prisma.vendor.findFirst({
      where: { whatsappPhone: normalized },
      select: {
        status: true,
        submittedAt: true,
        validatedAt: true,
        rejectedAt: true,
        rejectionReason: true,
      },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'vendor_not_found',
        message:
          "Aucune demande trouvée pour ce numéro. Vérifie le numéro ou refais l'inscription.",
      });
    }
    return vendor;
  }

  /** Story 1.8 — replace the vendor profile photo. Old R2 key is left to a sweeper. */
  async updateOwnProfilePhoto(userId: string, file: Express.Multer.File) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');

    const upload = await this.r2.uploadImage(file.buffer, { keyPrefix: 'vendor-profile' });

    return this.prisma.vendor.update({
      where: { id: vendor.id },
      data: { profilePhotoUrl: upload.key },
      select: { id: true, profilePhotoUrl: true, updatedAt: true },
    });
  }

  /**
   * Replace the vendor cover photo — the hero image at the top of the
   * vendor detail page on the consumer side. Mirrors updateOwnProfilePhoto
   * but stores under `vendor-cover/` R2 prefix so a future move to a
   * higher-resolution pipeline (e.g. maxEdge: 2048) can branch on the
   * keyPrefix without affecting profile photos.
   */
  async updateOwnCoverPhoto(userId: string, file: Express.Multer.File) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');

    const upload = await this.r2.uploadImage(file.buffer, { keyPrefix: 'vendor-cover' });

    return this.prisma.vendor.update({
      where: { id: vendor.id },
      data: { coverPhotoUrl: upload.key },
      select: { id: true, coverPhotoUrl: true, updatedAt: true },
    });
  }

  private async sendSubmissionConfirmation(toE164: string, vendorName: string): Promise<void> {
    const body =
      `Bonjour ${vendorName} ! ✅\n` +
      `Votre demande TchopNow est bien reçue. ` +
      `Notre équipe valide votre profil sous 2 heures et vous prévient ici dès que votre cuisine est en ligne. 🍲`;
    try {
      await this.twilio.sendWhatsApp(toE164, body);
    } catch (err) {
      // Don't surface to caller — the submission already succeeded. Log so
      // ops can replay if needed.
      const msg = (err as Error).message;
      this.logger.warn(
        { event: 'vendor_submission_whatsapp_failed', phone: toE164, error: msg },
        'Vendor submission WhatsApp failed',
      );
    }
  }
}
