import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RiderStatus, VendorStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { JwtRevocationService } from '../auth/jwt-revocation.service';

// Vendor approval / suspension copy lives here so all admin actions speak the
// same voice. WhatsApp notification is fire-and-forget — admin action
// succeeds regardless.
const APPROVAL_MSG_VENDOR = (name: string) =>
  `🎉 ${name}, votre cuisine TchopNow est maintenant en ligne ! Ouvrez votre dashboard pour mettre votre statut sur OUVERT et recevoir vos premières commandes.`;
const REJECT_MSG_VENDOR = (name: string, reason: string) =>
  `❌ ${name}, votre dossier TchopNow n'a pas été accepté.\nRaison : ${reason}\nVous pouvez soumettre à nouveau avec les corrections.`;
const SUSPEND_MSG_VENDOR = (name: string, reason: string) =>
  `⚠️ ${name}, votre compte TchopNow a été suspendu temporairement.\nRaison : ${reason}\nContactez le support pour plus d'informations.`;

const APPROVAL_MSG_RIDER = (name: string) =>
  `🎉 ${name}, votre compte TchopNow Livreur est activé ! Installez l'app et commencez à recevoir des courses.`;
const REJECT_MSG_RIDER = (name: string, reason: string) =>
  `❌ ${name}, votre dossier livreur n'a pas été accepté.\nRaison : ${reason}\nVous pouvez resoumettre avec les corrections.`;
const SUSPEND_MSG_RIDER = (name: string, reason: string) =>
  `⚠️ ${name}, votre compte livreur TchopNow a été suspendu.\nRaison : ${reason}\nContactez le support.`;

@Injectable()
export class AdminValidationService {
  private readonly logger = new Logger(AdminValidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly revocation: JwtRevocationService,
  ) {}

  // ── vendors ────────────────────────────────────────────────────────

  async listPendingVendors() {
    return this.prisma.vendor.findMany({
      where: { status: VendorStatus.PENDING_REVIEW },
      orderBy: { submittedAt: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        quartier: true,
        pointOfReference: true,
        whatsappPhone: true,
        declaredCapacity: true,
        profilePhotoUrl: true,
        submittedAt: true,
      },
    });
  }

  async approveVendor(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, name: true, status: true, whatsappPhone: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');
    if (vendor.status === VendorStatus.ACTIVE) {
      throw new ConflictException({
        code: 'vendor_already_active',
        message: 'This vendor is already active.',
      });
    }

    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: { status: VendorStatus.ACTIVE, validatedAt: new Date() },
    });
    void this.notify(vendor.whatsappPhone, APPROVAL_MSG_VENDOR(vendor.name));
    return updated;
  }

  async rejectVendor(vendorId: string, reason: string | undefined) {
    if (!reason) throw new BadRequestException('reason is required');
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, name: true, status: true, whatsappPhone: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');

    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: { status: VendorStatus.REJECTED, rejectedAt: new Date(), rejectionReason: reason },
    });
    void this.notify(vendor.whatsappPhone, REJECT_MSG_VENDOR(vendor.name, reason));
    return updated;
  }

  async suspendVendor(vendorId: string, reason: string | undefined) {
    if (!reason) throw new BadRequestException('reason is required');
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, name: true, whatsappPhone: true, userId: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');

    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: { status: VendorStatus.SUSPENDED, isOpen: false, rejectionReason: reason },
    });
    // Story 1.7 — Redis blacklist makes the vendor's tokens stop working on
    // the very next request, not at natural expiry.
    await this.revocation.revokeUser(vendor.userId);
    void this.notify(vendor.whatsappPhone, SUSPEND_MSG_VENDOR(vendor.name, reason));
    return updated;
  }

  async unsuspendVendor(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, status: true, userId: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');
    if (vendor.status !== VendorStatus.SUSPENDED) {
      throw new ConflictException({
        code: 'vendor_not_suspended',
        message: 'This vendor is not currently suspended.',
      });
    }
    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: { status: VendorStatus.ACTIVE, rejectionReason: null },
    });
    await this.revocation.reactivateUser(vendor.userId);
    return updated;
  }

  // ── riders ─────────────────────────────────────────────────────────

  async listPendingRiders() {
    return this.prisma.rider.findMany({
      where: { status: RiderStatus.PENDING_REVIEW },
      orderBy: { submittedAt: 'asc' },
      select: {
        id: true,
        vehicleType: true,
        preferredZone: true,
        licensePlate: true,
        momoPhone: true,
        idCardPhotoUrl: true,
        selfiePhotoUrl: true,
        vehiclePhotoUrl: true,
        submittedAt: true,
        user: { select: { id: true, displayName: true, phone: true } },
      },
    });
  }

  async approveRider(riderId: string) {
    const rider = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: {
        id: true,
        status: true,
        user: { select: { displayName: true, phone: true } },
      },
    });
    if (!rider) throw new NotFoundException('rider_not_found');
    if (rider.status === RiderStatus.ACTIVE) {
      throw new ConflictException({
        code: 'rider_already_active',
        message: 'This rider is already active.',
      });
    }

    const updated = await this.prisma.rider.update({
      where: { id: riderId },
      data: { status: RiderStatus.ACTIVE, validatedAt: new Date() },
    });
    if (rider.user.phone) {
      void this.notify(
        rider.user.phone,
        APPROVAL_MSG_RIDER(rider.user.displayName ?? 'Cher livreur'),
      );
    }
    return updated;
  }

  async rejectRider(riderId: string, reason: string | undefined) {
    if (!reason) throw new BadRequestException('reason is required');
    const rider = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: { id: true, status: true, user: { select: { displayName: true, phone: true } } },
    });
    if (!rider) throw new NotFoundException('rider_not_found');

    const updated = await this.prisma.rider.update({
      where: { id: riderId },
      data: { status: RiderStatus.REJECTED, rejectedAt: new Date(), rejectionReason: reason },
    });
    if (rider.user.phone) {
      void this.notify(
        rider.user.phone,
        REJECT_MSG_RIDER(rider.user.displayName ?? 'Cher livreur', reason),
      );
    }
    return updated;
  }

  async suspendRider(riderId: string, reason: string | undefined) {
    if (!reason) throw new BadRequestException('reason is required');
    const rider = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: { id: true, userId: true, user: { select: { displayName: true, phone: true } } },
    });
    if (!rider) throw new NotFoundException('rider_not_found');

    const updated = await this.prisma.rider.update({
      where: { id: riderId },
      data: {
        status: RiderStatus.SUSPENDED,
        isOnline: false,
        rejectionReason: reason,
      },
    });
    await this.revocation.revokeUser(rider.userId);
    if (rider.user.phone) {
      void this.notify(
        rider.user.phone,
        SUSPEND_MSG_RIDER(rider.user.displayName ?? 'Cher livreur', reason),
      );
    }
    return updated;
  }

  async unsuspendRider(riderId: string) {
    const rider = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: { id: true, status: true, userId: true },
    });
    if (!rider) throw new NotFoundException('rider_not_found');
    if (rider.status !== RiderStatus.SUSPENDED) {
      throw new ConflictException({
        code: 'rider_not_suspended',
        message: 'This rider is not currently suspended.',
      });
    }
    const updated = await this.prisma.rider.update({
      where: { id: riderId },
      data: { status: RiderStatus.ACTIVE, rejectionReason: null },
    });
    await this.revocation.reactivateUser(rider.userId);
    return updated;
  }

  // ── helpers ────────────────────────────────────────────────────────

  private async notify(toE164: string, body: string): Promise<void> {
    try {
      await this.twilio.sendWhatsApp(toE164, body);
    } catch (err) {
      this.logger.warn(`admin notification failed for ${toE164}: ${(err as Error).message}`);
    }
  }
}
