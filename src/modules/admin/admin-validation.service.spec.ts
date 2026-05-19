import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RiderStatus, RiderVehicleType, VendorStatus, VendorType } from '@prisma/client';
import { AdminValidationService } from './admin-validation.service';
import { JwtRevocationService } from '../auth/jwt-revocation.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

describe('AdminValidationService', () => {
  let service: AdminValidationService;
  let prisma: {
    vendor: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
    rider: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
  };
  let twilio: { sendWhatsApp: jest.Mock };
  let revocation: { revokeUser: jest.Mock; reactivateUser: jest.Mock };

  beforeEach(async () => {
    prisma = {
      vendor: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })),
      },
      rider: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })),
      },
    };
    twilio = { sendWhatsApp: jest.fn().mockResolvedValue('SM-test') };
    revocation = {
      revokeUser: jest.fn().mockResolvedValue(undefined),
      reactivateUser: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        AdminValidationService,
        pinoLoggerProvider(AdminValidationService.name),
        { provide: PrismaService, useValue: prisma },
        { provide: TwilioService, useValue: twilio },
        { provide: JwtRevocationService, useValue: revocation },
      ],
    }).compile();
    service = module.get(AdminValidationService);
  });

  describe('vendor lifecycle', () => {
    function vendor(status: VendorStatus) {
      return {
        id: 'v-1',
        name: 'Chez Maman',
        type: VendorType.INFORMAL,
        status,
        whatsappPhone: '+237670000111',
        userId: 'user-vendor',
      };
    }

    it('approveVendor → ACTIVE + WhatsApp', async () => {
      prisma.vendor.findUnique.mockResolvedValue(vendor(VendorStatus.PENDING_REVIEW));
      await service.approveVendor('v-1');
      expect(prisma.vendor.update).toHaveBeenCalledWith({
        where: { id: 'v-1' },
        data: { status: VendorStatus.ACTIVE, validatedAt: expect.any(Date) },
      });
      await new Promise((r) => setImmediate(r));
      expect(twilio.sendWhatsApp).toHaveBeenCalledWith(
        '+237670000111',
        expect.stringMatching(/en ligne/),
      );
    });

    it('approveVendor refuses if already ACTIVE', async () => {
      prisma.vendor.findUnique.mockResolvedValue(vendor(VendorStatus.ACTIVE));
      await expect(service.approveVendor('v-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejectVendor requires a reason', async () => {
      prisma.vendor.findUnique.mockResolvedValue(vendor(VendorStatus.PENDING_REVIEW));
      await expect(service.rejectVendor('v-1', undefined)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('suspendVendor revokes JWTs + sets isOpen=false', async () => {
      prisma.vendor.findUnique.mockResolvedValue(vendor(VendorStatus.ACTIVE));
      await service.suspendVendor('v-1', 'Plaintes répétées');
      expect(prisma.vendor.update).toHaveBeenCalledWith({
        where: { id: 'v-1' },
        data: {
          status: VendorStatus.SUSPENDED,
          isOpen: false,
          rejectionReason: 'Plaintes répétées',
        },
      });
      expect(revocation.revokeUser).toHaveBeenCalledWith('user-vendor');
    });

    it('unsuspendVendor clears the JWT blacklist', async () => {
      prisma.vendor.findUnique.mockResolvedValue(vendor(VendorStatus.SUSPENDED));
      await service.unsuspendVendor('v-1');
      expect(revocation.reactivateUser).toHaveBeenCalledWith('user-vendor');
    });

    it('unsuspendVendor refuses if not currently suspended', async () => {
      prisma.vendor.findUnique.mockResolvedValue(vendor(VendorStatus.ACTIVE));
      await expect(service.unsuspendVendor('v-1')).rejects.toMatchObject({
        response: { code: 'vendor_not_suspended' },
      });
    });

    it('NotFoundException when vendor is missing', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(service.approveVendor('v-missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('setVendorPreOrders (#187 follow-up)', () => {
      function vendorWithFlag(currentValue: boolean, type = 'INFORMAL') {
        prisma.vendor.findUnique.mockResolvedValue({
          id: 'v-1',
          acceptsPreOrders: currentValue,
          type,
        });
      }

      it('flips the flag and writes the DB update', async () => {
        vendorWithFlag(false);
        await service.setVendorPreOrders('v-1', true);
        expect(prisma.vendor.update).toHaveBeenCalledWith({
          where: { id: 'v-1' },
          data: { acceptsPreOrders: true },
          select: { id: true, acceptsPreOrders: true },
        });
      });

      it('is idempotent — no DB write when already in the target state', async () => {
        vendorWithFlag(true);
        const result = await service.setVendorPreOrders('v-1', true);
        expect(prisma.vendor.update).not.toHaveBeenCalled();
        expect(result).toEqual({ id: 'v-1', acceptsPreOrders: true });
      });

      it('NotFoundException when vendor is missing', async () => {
        prisma.vendor.findUnique.mockResolvedValue(null);
        await expect(service.setVendorPreOrders('v-missing', true)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });

      it('works for non-INFORMAL vendors too (admin override scenario)', async () => {
        vendorWithFlag(false, 'RESTAURANT');
        await service.setVendorPreOrders('v-1', true);
        expect(prisma.vendor.update).toHaveBeenCalled();
      });
    });
  });

  describe('rider lifecycle', () => {
    function rider(status: RiderStatus) {
      return {
        id: 'r-1',
        status,
        vehicleType: RiderVehicleType.MOTO,
        userId: 'user-rider',
        user: { id: 'user-rider', displayName: 'Jean Mboué', phone: '+237670000222' },
      };
    }

    it('approveRider → ACTIVE + WhatsApp', async () => {
      prisma.rider.findUnique.mockResolvedValue(rider(RiderStatus.PENDING_REVIEW));
      await service.approveRider('r-1');
      expect(prisma.rider.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: { status: RiderStatus.ACTIVE, validatedAt: expect.any(Date) },
      });
      await new Promise((r) => setImmediate(r));
      expect(twilio.sendWhatsApp).toHaveBeenCalledWith(
        '+237670000222',
        expect.stringMatching(/activé/i),
      );
    });

    it('suspendRider revokes JWTs + sets isOnline=false', async () => {
      prisma.rider.findUnique.mockResolvedValue(rider(RiderStatus.ACTIVE));
      await service.suspendRider('r-1', 'Conduite dangereuse');
      expect(prisma.rider.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: {
          status: RiderStatus.SUSPENDED,
          isOnline: false,
          rejectionReason: 'Conduite dangereuse',
        },
      });
      expect(revocation.revokeUser).toHaveBeenCalledWith('user-rider');
    });

    it('does not crash when notification fails (fire-and-forget)', async () => {
      prisma.rider.findUnique.mockResolvedValue(rider(RiderStatus.PENDING_REVIEW));
      twilio.sendWhatsApp.mockRejectedValueOnce(new Error('twilio down'));
      await expect(service.approveRider('r-1')).resolves.toBeDefined();
      await new Promise((r) => setImmediate(r));
    });
  });
});
