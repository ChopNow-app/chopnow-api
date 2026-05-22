import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LedgerAccount,
  LedgerEventType,
  OrderStatus,
  Prisma,
  RiderStatus,
  RiderVehicleType,
  UserRole,
} from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { R2Service } from '../../infra/r2/r2.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { normalizePhone } from '../../shared/phone/phone.util';
import { LedgerService } from '../finance/ledger.service';
import type { RiderAvailabilityDto, RiderHeartbeatDto } from './dto/rider-availability.dto';
import type { SubmitRiderDto } from './dto/submit-rider.dto';
import type { UpdateRiderProfileDto } from './dto/update-rider-profile.dto';

// Statuses that allow re-submission. A pending or already-rejected rider can
// re-upload corrected docs; an ACTIVE or SUSPENDED rider cannot — those go
// through the account recovery / unsuspend flows instead (Story 1.5 / Story 6.x).
const RESUBMITTABLE: ReadonlySet<RiderStatus> = new Set<RiderStatus>([
  RiderStatus.PENDING_REVIEW,
  RiderStatus.CORRECTION_REQUESTED,
  RiderStatus.REJECTED,
]);

const REQUIRES_VEHICLE_PHOTO: ReadonlySet<RiderVehicleType> = new Set<RiderVehicleType>([
  RiderVehicleType.MOTO,
  RiderVehicleType.BICYCLE,
  RiderVehicleType.CAR,
]);

const REQUIRES_LICENSE_PLATE: ReadonlySet<RiderVehicleType> = new Set<RiderVehicleType>([
  RiderVehicleType.MOTO,
  RiderVehicleType.CAR,
]);

/** Rider KYC onboarding service — Story 1.4. */
@Injectable()
export class RidersService {
  constructor(
    @InjectPinoLogger(RidersService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly twilio: TwilioService,
    private readonly ledger: LedgerService,
  ) {}

  async submit(
    dto: SubmitRiderDto,
    files: {
      idCardPhoto?: Express.Multer.File;
      selfiePhoto?: Express.Multer.File;
      vehiclePhoto?: Express.Multer.File;
    },
  ): Promise<{ riderId: string; status: RiderStatus; message: string }> {
    // Required for all vehicle types.
    if (!files.idCardPhoto) throw new BadRequestException('idCardPhoto is required');
    if (!files.selfiePhoto) throw new BadRequestException('selfiePhoto is required');

    // Vehicle-type-dependent requirements.
    if (REQUIRES_VEHICLE_PHOTO.has(dto.vehicleType) && !files.vehiclePhoto) {
      throw new BadRequestException(`vehiclePhoto is required for ${dto.vehicleType}`);
    }
    if (REQUIRES_LICENSE_PLATE.has(dto.vehicleType) && !dto.licensePlate) {
      throw new BadRequestException(`licensePlate is required for ${dto.vehicleType}`);
    }
    // Strip the plate for vehicles that don't carry one — never persist it.
    // Normalize: remove all whitespace + uppercase. Frontend accepts the
    // visible "LT 1234 AB" form for readability; the DB stores "LT1234AB"
    // so the @unique constraint catches duplicates regardless of formatting.
    const rawPlate = REQUIRES_LICENSE_PLATE.has(dto.vehicleType) ? dto.licensePlate : null;
    const licensePlate = rawPlate ? rawPlate.replace(/\s+/g, '').toUpperCase() : null;

    const phone = normalizePhone(dto.phone);
    const momoPhone = normalizePhone(dto.momoPhone);

    // Look up existing user + rider to decide create-vs-resubmit.
    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
      include: { rider: true },
    });

    if (existingUser?.rider && !RESUBMITTABLE.has(existingUser.rider.status)) {
      throw new ConflictException({
        code: 'rider_already_active',
        message:
          'This rider account is already active (or suspended). Contact support to update KYC.',
      });
    }

    if (
      existingUser &&
      existingUser.role !== UserRole.CONSUMER &&
      existingUser.role !== UserRole.RIDER
    ) {
      throw new ConflictException({
        code: 'phone_used_by_other_role',
        message: 'This phone is registered for a non-rider account.',
      });
    }

    // Upload BEFORE the transaction — keeps DB locks brief. Orphans on failure
    // are acceptable; an R2 lifecycle rule can sweep keys with no Rider FK
    // referencing them.
    const [idUpload, selfieUpload, vehicleUpload] = await Promise.all([
      this.r2.uploadImage(files.idCardPhoto.buffer, { keyPrefix: 'rider-kyc/id-card' }),
      this.r2.uploadImage(files.selfiePhoto.buffer, { keyPrefix: 'rider-kyc/selfie' }),
      files.vehiclePhoto
        ? this.r2.uploadImage(files.vehiclePhoto.buffer, { keyPrefix: 'rider-kyc/vehicle' })
        : Promise.resolve(null),
    ]);

    let riderId: string;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // 1) User row — create new or upgrade CONSUMER → RIDER.
        let userId: string;
        if (!existingUser) {
          const created = await tx.user.create({
            data: { phone, displayName: dto.name, role: UserRole.RIDER },
          });
          userId = created.id;
        } else {
          if (existingUser.role === UserRole.CONSUMER) {
            await tx.user.update({
              where: { id: existingUser.id },
              data: { role: UserRole.RIDER, displayName: dto.name },
            });
          } else {
            // Already RIDER; just refresh the display name in case it changed.
            await tx.user.update({
              where: { id: existingUser.id },
              data: { displayName: dto.name },
            });
          }
          userId = existingUser.id;
        }

        // 2) Rider row — upsert. userId is @unique so this is one row per user.
        const rider = await tx.rider.upsert({
          where: { userId },
          create: {
            userId,
            vehicleType: dto.vehicleType,
            preferredZone: dto.preferredZone ?? null,
            idCardPhotoUrl: idUpload.key,
            selfiePhotoUrl: selfieUpload.key,
            vehiclePhotoUrl: vehicleUpload?.key ?? null,
            licensePlate,
            momoPhone,
            status: RiderStatus.PENDING_REVIEW,
            submittedAt: new Date(),
          },
          update: {
            // Re-submission: refresh everything and reset to PENDING_REVIEW.
            vehicleType: dto.vehicleType,
            preferredZone: dto.preferredZone ?? null,
            idCardPhotoUrl: idUpload.key,
            selfiePhotoUrl: selfieUpload.key,
            vehiclePhotoUrl: vehicleUpload?.key ?? null,
            licensePlate,
            momoPhone,
            status: RiderStatus.PENDING_REVIEW,
            submittedAt: new Date(),
            rejectedAt: null,
            rejectionReason: null,
          },
        });
        return rider.id;
      });
      riderId = result;
    } catch (err) {
      // Surface license plate collisions (across riders) as a structured 409.
      // The schema enforces @unique on licensePlate — distinct riders can't
      // claim the same plate. Admin will handle disputes manually.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        (err.meta?.target as string[] | undefined)?.includes('licensePlate')
      ) {
        throw new ConflictException({
          code: 'license_plate_already_used',
          message:
            'This license plate is already on file for another rider. Contact support if this is an error.',
        });
      }
      throw err;
    }

    // Fire-and-forget WhatsApp confirmation.
    void this.sendSubmissionConfirmation(phone, dto.name);

    return {
      riderId,
      status: RiderStatus.PENDING_REVIEW,
      message:
        "✅ Demande reçue ! Notre équipe va vérifier votre profil dans les 4 heures. Nous vous prévenons dès que c'est validé.",
    };
  }

  // Resolves a session userId to the rider's own id. 404 if no rider row
  // exists for the user. Used by controllers that need to call a service
  // keyed on riderId (finance.getRiderSelfView, etc.).
  async getOwnId(userId: string): Promise<string> {
    const rider = await this.prisma.rider.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!rider) throw new NotFoundException('rider_not_found');
    return rider.id;
  }

  /**
   * Story 1.8 — rider self-update.
   *
   * Editable: preferredZone, momoPhone. vehicleType / photos / licensePlate
   * changes go through the admin re-validation flow (Story 6.2) — they're
   * intentionally not exposed here.
   */
  async updateOwn(userId: string, dto: UpdateRiderProfileDto) {
    if (Object.values(dto).every((v) => v === undefined)) {
      throw new BadRequestException('no_fields_to_update');
    }

    const rider = await this.prisma.rider.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!rider) throw new NotFoundException('rider_not_found');

    return this.prisma.rider.update({
      where: { id: rider.id },
      data: {
        preferredZone: dto.preferredZone,
        momoPhone: dto.momoPhone ? normalizePhone(dto.momoPhone) : undefined,
      },
      select: {
        id: true,
        preferredZone: true,
        momoPhone: true,
        status: true,
        updatedAt: true,
      },
    });
  }

  // ── Story 4.1 / 4.4 — availability + heartbeat ─────────────────────

  async setAvailability(userId: string, dto: RiderAvailabilityDto) {
    const rider = await this.prisma.rider.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });
    if (!rider) throw new NotFoundException('rider_not_found');
    if (rider.status !== RiderStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'rider_not_active',
        message: 'Your account must be approved by an admin before you can go online.',
      });
    }
    return this.prisma.rider.update({
      where: { id: rider.id },
      data: { isOnline: dto.isOnline, lastSeenAt: dto.isOnline ? new Date() : undefined },
      select: { id: true, isOnline: true, lastSeenAt: true },
    });
  }

  /**
   * Story 4.4 — 15s GPS heartbeat.
   *
   * Writes both `lastLocation` (PostGIS point) and `lastSeenAt` in one raw
   * SQL call — Prisma can't write the Unsupported geography column. Marks
   * the rider as online implicitly so a hot resume after a brief network
   * loss reactivates dispatch without an extra round trip.
   */
  async pushHeartbeat(userId: string, dto: RiderHeartbeatDto) {
    const rider = await this.prisma.rider.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });
    if (!rider) throw new NotFoundException('rider_not_found');
    if (rider.status !== RiderStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'rider_not_active',
        message: 'Your account must be approved before sending location updates.',
      });
    }
    await this.prisma.$executeRaw`
      UPDATE "riders"
      SET "lastLocation" = ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography,
          "lastSeenAt"   = NOW(),
          "isOnline"     = true
      WHERE id = ${rider.id}
    `;
    return { ok: true as const };
  }

  // ── Story 4.1 / 4.2 — rider order lifecycle ────────────────────────

  async listCourses(userId: string) {
    const rider = await this.prisma.rider.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!rider) throw new NotFoundException('rider_not_found');

    return this.prisma.order.findMany({
      where: {
        riderId: rider.id,
        status: {
          in: [
            OrderStatus.ACCEPTED,
            OrderStatus.IN_PREP,
            OrderStatus.READY_PICKUP,
            OrderStatus.PICKED_UP,
          ],
        },
      },
      orderBy: { assignedAt: 'desc' },
      include: {
        vendor: { select: { id: true, name: true, quartier: true } },
        // Rider needs items for the pickup screen (what to grab from the vendor)
        // and for the summary card on /livreur showing "N plat(s)".
        items: {
          select: {
            id: true,
            nameSnapshot: true,
            quantity: true,
            lineXAF: true,
          },
        },
      },
    });
  }

  async markPickedUp(userId: string, orderId: string, submittedCode: string) {
    const order = await this.requireRiderOrder(userId, orderId);
    const PICKUPABLE = new Set<OrderStatus>([
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PREP,
      OrderStatus.READY_PICKUP,
    ]);
    if (!PICKUPABLE.has(order.status)) {
      throw new ConflictException({
        code: 'order_not_pickupable',
        message: 'Order is not in a state ready for pickup.',
      });
    }
    // Story 4.13 — rider must produce the 4-digit pickup code the vendor
    // showed them. Compared in constant-ish time via plain === since the
    // code space is intentionally tiny (10k) and the auth path already
    // pins this to a specific rider+order pair.
    if (submittedCode !== order.pickupCode) {
      throw new ConflictException({
        code: 'wrong_pickup_code',
        message: 'Code de retrait incorrect. Demande-le au vendeur.',
      });
    }
    return this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.PICKED_UP, pickedUpAt: new Date() },
    });
  }

  async markDelivered(userId: string, orderId: string, submittedCode: string) {
    const order = await this.requireRiderOrder(userId, orderId);
    if (order.status !== OrderStatus.PICKED_UP) {
      throw new ConflictException({
        code: 'order_not_in_delivery',
        message: 'Order must be PICKED_UP before it can be marked DELIVERED.',
      });
    }
    if (submittedCode !== order.deliveryCode) {
      throw new ConflictException({
        code: 'wrong_delivery_code',
        message: 'Code de livraison incorrect. Demande-le au client.',
      });
    }
    const { commissionXAF, riderShareXAF, platformFeeXAF } = order;
    if (commissionXAF === null || riderShareXAF === null || platformFeeXAF === null) {
      // Should never fire post-S2: every order has these populated by
      // onPaymentSucceeded. Refuse loudly rather than ledger-incorrect.
      throw new ConflictException({
        code: 'order_missing_finance_snapshot',
        message: 'Order is missing finance snapshots — cannot mark delivered.',
      });
    }
    // Pilot is MoMo-only — paymentStatus is already PAID by this point.
    // Per ADR-0005, ORDER_DELIVERED moves money out of customer escrow into
    // the three payable accounts:
    //   CUSTOMER_ESCROW  : +totalXAF                  (release escrow)
    //   VENDOR_PAYABLE   : -(subtotal − commission)   (we owe vendor)
    //   RIDER_PAYABLE    : -riderShareXAF             (we owe this rider)
    //   PLATFORM_REVENUE : -platformFeeXAF            (recognise revenue)
    const now = new Date();
    const vendorPayableXAF = order.subtotalXAF - commissionXAF;
    const updated = await this.prisma.$transaction(async (tx) => {
      // Status-guarded — a parallel call (or a future cron) can't overwrite
      // someone else's transition.
      const res = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PICKED_UP },
        data: { status: OrderStatus.DELIVERED, deliveredAt: now },
      });
      if (res.count === 0) {
        throw new ConflictException({
          code: 'order_state_changed',
          message: 'Order status changed during delivery confirmation. Refresh.',
        });
      }
      await this.ledger.recordTransaction(
        {
          eventId: `delivery:${order.id}`,
          eventType: LedgerEventType.ORDER_DELIVERED,
          entries: [
            {
              account: LedgerAccount.CUSTOMER_ESCROW,
              amountXAF: order.totalXAF,
              orderId: order.id,
              description: `Escrow released on delivery of ${order.code ?? order.id}`,
            },
            {
              account: LedgerAccount.VENDOR_PAYABLE,
              amountXAF: -vendorPayableXAF,
              orderId: order.id,
              vendorId: order.vendorId,
              description: 'Vendor share of delivered order',
            },
            {
              account: LedgerAccount.RIDER_PAYABLE,
              amountXAF: -riderShareXAF,
              orderId: order.id,
              riderId: order.riderId ?? undefined,
              description: 'Rider share of delivered order',
            },
            {
              account: LedgerAccount.PLATFORM_REVENUE,
              amountXAF: -platformFeeXAF,
              orderId: order.id,
              description: 'Platform fee (commission + delivery margin)',
            },
          ],
        },
        tx,
      );
      return tx.order.findUnique({ where: { id: order.id } });
    });
    this.logger.info(
      {
        event: 'order_delivered_ledgered',
        orderId: order.id,
        vendorId: order.vendorId,
        riderId: order.riderId,
        totalXAF: order.totalXAF,
        vendorPayableXAF,
        riderShareXAF,
        platformFeeXAF,
      },
      'order delivered — ledger entries recorded',
    );
    return updated;
  }

  private async requireRiderOrder(userId: string, orderId: string) {
    const rider = await this.prisma.rider.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!rider) throw new NotFoundException('rider_not_found');

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        code: true,
        riderId: true,
        vendorId: true,
        status: true,
        pickupCode: true,
        deliveryCode: true,
        paymentMethod: true,
        paymentStatus: true,
        // Finance snapshots — required by markDelivered to write the
        // ORDER_DELIVERED ledger entries atomically. Populated at
        // onPaymentSucceeded (post-7.0b); any order that reaches this
        // method post-S2 deploy is guaranteed to have these.
        totalXAF: true,
        subtotalXAF: true,
        deliveryFeeXAF: true,
        commissionXAF: true,
        riderShareXAF: true,
        platformFeeXAF: true,
      },
    });
    if (!order || order.riderId !== rider.id) {
      // 404 — never confirm an order id exists if it's not yours.
      throw new NotFoundException('order_not_found');
    }
    return order;
  }

  /**
   * Story 1.4 follow-up (#13) — phone-keyed submission status check.
   * Mirrors VendorService.getStatusByPhone — returns just the validation
   * lifecycle fields, never KYC photos / name / address, so the public
   * throttled endpoint can't be turned into a profile-enumeration tool.
   */
  async getStatusByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    // Rider has no phone column directly — go via the User row.
    const user = await this.prisma.user.findUnique({
      where: { phone: normalized },
      include: {
        rider: {
          select: {
            status: true,
            submittedAt: true,
            validatedAt: true,
            rejectedAt: true,
            rejectionReason: true,
          },
        },
      },
    });
    if (!user?.rider) {
      throw new NotFoundException({
        code: 'rider_not_found',
        message: "Aucun dossier trouvé pour ce numéro. Vérifie le numéro ou refais l'inscription.",
      });
    }
    return user.rider;
  }

  private async sendSubmissionConfirmation(toE164: string, riderName: string): Promise<void> {
    const body =
      `Bonjour ${riderName} ! ✅\n` +
      `Votre dossier livreur TchopNow est bien reçu. ` +
      `Notre équipe vérifie votre profil sous 4 heures et vous prévient ici dès que c'est validé. 🛵`;
    try {
      await this.twilio.sendWhatsApp(toE164, body);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(
        { event: 'rider_submission_whatsapp_failed', phone: toE164, error: msg },
        'Rider submission WhatsApp failed',
      );
    }
  }
}
