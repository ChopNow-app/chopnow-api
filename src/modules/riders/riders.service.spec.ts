import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, RiderStatus, RiderVehicleType, UserRole } from '@prisma/client';
import { RidersService } from './riders.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { R2Service } from '../../infra/r2/r2.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { SubmitRiderDto } from './dto/submit-rider.dto';

describe('RidersService', () => {
  let service: RidersService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    rider: { upsert: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    order: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let r2: { uploadImage: jest.Mock };
  let twilio: { sendWhatsApp: jest.Mock };

  const baseDto: SubmitRiderDto = {
    name: 'Jean Mboué',
    phone: '670000020',
    vehicleType: RiderVehicleType.MOTO,
    preferredZone: 'Makepe',
    licensePlate: 'LT1234',
    momoPhone: '670000020',
  };

  const file = (name: string): Express.Multer.File =>
    ({
      fieldname: name,
      originalname: `${name}.jpg`,
      encoding: '7bit',
      mimetype: 'image/jpeg',
      size: 1024,
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
    }) as Express.Multer.File;

  const allFiles = () => ({
    idCardPhoto: file('id'),
    selfiePhoto: file('selfie'),
    vehiclePhoto: file('vehicle'),
  });

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'user-new', role: UserRole.RIDER }),
        update: jest.fn().mockResolvedValue({}),
      },
      rider: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: 'rider-new', status: RiderStatus.PENDING_REVIEW }),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      order: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };
    r2 = {
      uploadImage: jest
        .fn()
        .mockImplementation((_buffer, { keyPrefix }) =>
          Promise.resolve({ key: `${keyPrefix}/test-uuid.webp` }),
        ),
    };
    twilio = { sendWhatsApp: jest.fn().mockResolvedValue('SMxxx') };

    const module = await Test.createTestingModule({
      providers: [
        RidersService,
        { provide: PrismaService, useValue: prisma },
        { provide: R2Service, useValue: r2 },
        { provide: TwilioService, useValue: twilio },
      ],
    }).compile();

    service = module.get(RidersService);
  });

  describe('submit — happy paths', () => {
    it('creates a fresh user + rider for a new phone (MOTO + plate)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.submit(baseDto, allFiles());

      expect(result.status).toBe(RiderStatus.PENDING_REVIEW);
      expect(result.riderId).toBe('rider-new');

      // User created with RIDER role
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { phone: '+237670000020', displayName: 'Jean Mboué', role: UserRole.RIDER },
      });
      // Rider upsert with the right shape
      const upsertArgs = prisma.rider.upsert.mock.calls[0][0];
      expect(upsertArgs.create).toMatchObject({
        userId: 'user-new',
        vehicleType: RiderVehicleType.MOTO,
        preferredZone: 'Makepe',
        licensePlate: 'LT1234',
        momoPhone: '+237670000020',
        status: RiderStatus.PENDING_REVIEW,
        idCardPhotoUrl: 'rider-kyc/id-card/test-uuid.webp',
        selfiePhotoUrl: 'rider-kyc/selfie/test-uuid.webp',
        vehiclePhotoUrl: 'rider-kyc/vehicle/test-uuid.webp',
      });

      // R2 keys use the rider-kyc/ prefix (private storage convention)
      const prefixes = r2.uploadImage.mock.calls.map((c) => c[1].keyPrefix);
      expect(prefixes).toEqual(['rider-kyc/id-card', 'rider-kyc/selfie', 'rider-kyc/vehicle']);

      // WhatsApp confirmation queued (fire-and-forget)
      await new Promise((r) => setImmediate(r));
      expect(twilio.sendWhatsApp).toHaveBeenCalledWith(
        '+237670000020',
        expect.stringMatching(/dossier livreur TchopNow/i),
      );
    });

    it('upgrades a CONSUMER user to RIDER on first submission', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-existing',
        role: UserRole.CONSUMER,
        rider: null,
      });

      await service.submit(baseDto, allFiles());

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-existing' },
        data: { role: UserRole.RIDER, displayName: 'Jean Mboué' },
      });
    });

    it.each([RiderStatus.PENDING_REVIEW, RiderStatus.CORRECTION_REQUESTED, RiderStatus.REJECTED])(
      'resubmits over an existing rider in status %s (no duplicate created)',
      async (status) => {
        prisma.user.findUnique.mockResolvedValue({
          id: 'user-existing',
          role: UserRole.RIDER,
          rider: { id: 'rider-existing', status },
        });

        await service.submit(baseDto, allFiles());

        // upsert.update path fires — confirmed by the update key on the call.
        const upsertArgs = prisma.rider.upsert.mock.calls[0][0];
        expect(upsertArgs.where).toEqual({ userId: 'user-existing' });
        expect(upsertArgs.update.status).toBe(RiderStatus.PENDING_REVIEW);
        expect(upsertArgs.update.rejectedAt).toBeNull();
        expect(upsertArgs.update.rejectionReason).toBeNull();
      },
    );

    it('omits vehiclePhoto + licensePlate for ON_FOOT', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.submit(
        { ...baseDto, vehicleType: RiderVehicleType.ON_FOOT, licensePlate: 'IGNORED' },
        { idCardPhoto: file('id'), selfiePhoto: file('selfie') },
      );

      // Only 2 R2 uploads — no vehicle photo
      expect(r2.uploadImage).toHaveBeenCalledTimes(2);

      // Rider row created with no plate and no vehicle photo
      const upsertArgs = prisma.rider.upsert.mock.calls[0][0];
      expect(upsertArgs.create.licensePlate).toBeNull();
      expect(upsertArgs.create.vehiclePhotoUrl).toBeNull();
    });

    it('accepts BICYCLE with vehiclePhoto and no plate', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.submit(
        { ...baseDto, vehicleType: RiderVehicleType.BICYCLE, licensePlate: undefined },
        allFiles(),
      );

      const upsertArgs = prisma.rider.upsert.mock.calls[0][0];
      expect(upsertArgs.create.licensePlate).toBeNull();
      expect(upsertArgs.create.vehiclePhotoUrl).toBe('rider-kyc/vehicle/test-uuid.webp');
    });
  });

  describe('submit — validation failures', () => {
    it.each(['idCardPhoto', 'selfiePhoto'])('rejects when %s is missing', async (missing) => {
      prisma.user.findUnique.mockResolvedValue(null);
      const files = allFiles() as Record<string, Express.Multer.File | undefined>;
      delete files[missing];

      await expect(service.submit(baseDto, files)).rejects.toMatchObject({
        message: expect.stringContaining(missing),
      });
    });

    it.each([RiderVehicleType.MOTO, RiderVehicleType.BICYCLE, RiderVehicleType.CAR])(
      'requires vehiclePhoto for %s',
      async (vehicleType) => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(
          service.submit(
            { ...baseDto, vehicleType, licensePlate: 'OK1234' },
            { idCardPhoto: file('id'), selfiePhoto: file('selfie') },
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it.each([RiderVehicleType.MOTO, RiderVehicleType.CAR])(
      'requires licensePlate for %s',
      async (vehicleType) => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(
          service.submit({ ...baseDto, vehicleType, licensePlate: undefined }, allFiles()),
        ).rejects.toMatchObject({
          message: expect.stringMatching(/licensePlate/),
        });
      },
    );
  });

  describe('submit — conflicts', () => {
    it.each([RiderStatus.ACTIVE, RiderStatus.SUSPENDED])(
      'rejects when an existing rider is in status %s',
      async (status) => {
        prisma.user.findUnique.mockResolvedValue({
          id: 'user-existing',
          role: UserRole.RIDER,
          rider: { id: 'rider-existing', status },
        });

        await expect(service.submit(baseDto, allFiles())).rejects.toMatchObject({
          response: { code: 'rider_already_active' },
        });
        expect(r2.uploadImage).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('rejects when the phone is registered as ADMIN / VENDOR / etc', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-vendor',
        role: UserRole.VENDOR,
        rider: null,
      });

      await expect(service.submit(baseDto, allFiles())).rejects.toMatchObject({
        response: { code: 'phone_used_by_other_role' },
      });
    });

    it('surfaces license_plate_already_used on Prisma P2002 (different rider already has the plate)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const dbErr = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`licensePlate`)',
        { code: 'P2002', clientVersion: '6.0.0', meta: { target: ['licensePlate'] } },
      );
      prisma.rider.upsert.mockRejectedValueOnce(dbErr);

      await expect(service.submit(baseDto, allFiles())).rejects.toMatchObject({
        response: { code: 'license_plate_already_used' },
      });
    });

    it('rethrows non-P2002 Prisma errors as-is', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const dbErr = new Prisma.PrismaClientKnownRequestError('something else broke', {
        code: 'P2025',
        clientVersion: '6.0.0',
      });
      prisma.rider.upsert.mockRejectedValueOnce(dbErr);

      await expect(service.submit(baseDto, allFiles())).rejects.toBe(dbErr);
    });
  });

  it('does not throw when the WhatsApp confirmation fails', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    twilio.sendWhatsApp.mockRejectedValueOnce(new Error('twilio down'));

    const result = await service.submit(baseDto, allFiles());

    expect(result.status).toBe(RiderStatus.PENDING_REVIEW);
    await new Promise((r) => setImmediate(r));
    expect(twilio.sendWhatsApp).toHaveBeenCalled();
  });

  describe('updateOwn (Story 1.8)', () => {
    it('updates preferredZone + normalises momoPhone', async () => {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1' });
      prisma.rider.update.mockResolvedValue({
        id: 'r-1',
        preferredZone: 'Bonamoussadi',
        momoPhone: '+237670000099',
      });

      const result = await service.updateOwn('user-1', {
        preferredZone: 'Bonamoussadi',
        momoPhone: '670000099',
      });

      expect(prisma.rider.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { id: true },
      });
      expect(prisma.rider.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: { preferredZone: 'Bonamoussadi', momoPhone: '+237670000099' },
        select: expect.any(Object),
      });
      expect(result.momoPhone).toBe('+237670000099');
    });

    it('rejects empty body with no_fields_to_update', async () => {
      await expect(service.updateOwn('user-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.rider.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the caller has no Rider row', async () => {
      prisma.rider.findUnique.mockResolvedValue(null);
      await expect(service.updateOwn('user-1', { preferredZone: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('does NOT touch momoPhone when undefined', async () => {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1' });
      prisma.rider.update.mockResolvedValue({ id: 'r-1' });
      await service.updateOwn('user-1', { preferredZone: 'X' });
      const data = prisma.rider.update.mock.calls[0][0].data;
      expect(data.momoPhone).toBeUndefined();
    });
  });

  describe('setAvailability (Story 4.1)', () => {
    it('flips isOnline when rider is ACTIVE', async () => {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1', status: RiderStatus.ACTIVE });
      prisma.rider.update.mockResolvedValue({ id: 'r-1', isOnline: true, lastSeenAt: new Date() });

      await service.setAvailability('user-1', { isOnline: true });

      expect(prisma.rider.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: { isOnline: true, lastSeenAt: expect.any(Date) },
        select: expect.any(Object),
      });
    });

    it('rejects non-ACTIVE riders from going online', async () => {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1', status: RiderStatus.PENDING_REVIEW });
      await expect(service.setAvailability('user-1', { isOnline: true })).rejects.toMatchObject({
        response: { code: 'rider_not_active' },
      });
    });
  });

  describe('pushHeartbeat (Story 4.4)', () => {
    it('updates lastLocation + lastSeenAt via raw SQL', async () => {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1', status: RiderStatus.ACTIVE });

      await service.pushHeartbeat('user-1', { lat: 4.0511, lng: 9.7679 });

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const sql = (prisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('');
      expect(sql).toMatch(/UPDATE "riders"/);
      expect(sql).toMatch(/ST_SetSRID\(ST_MakePoint\(/);
    });

    it('rejects non-ACTIVE riders from sending heartbeat', async () => {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1', status: RiderStatus.SUSPENDED });
      await expect(service.pushHeartbeat('user-1', { lat: 0, lng: 0 })).rejects.toMatchObject({
        response: { code: 'rider_not_active' },
      });
    });
  });

  describe('markPickedUp / markDelivered (Story 4.2 / 4.13)', () => {
    function riderOrder(status: OrderStatus) {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'o-1',
        riderId: 'r-1',
        status,
        pickupCode: '1234',
        deliveryCode: '5678',
      });
    }

    it.each([OrderStatus.ACCEPTED, OrderStatus.IN_PREP, OrderStatus.READY_PICKUP])(
      'markPickedUp flips %s → PICKED_UP with correct code',
      async (status) => {
        riderOrder(status);
        await service.markPickedUp('user-1', 'o-1', '1234');
        expect(prisma.order.update).toHaveBeenCalledWith({
          where: { id: 'o-1' },
          data: { status: OrderStatus.PICKED_UP, pickedUpAt: expect.any(Date) },
        });
      },
    );

    it('markPickedUp rejects wrong pickup code', async () => {
      riderOrder(OrderStatus.ACCEPTED);
      await expect(service.markPickedUp('user-1', 'o-1', '9999')).rejects.toMatchObject({
        response: { code: 'wrong_pickup_code' },
      });
    });

    it('markPickedUp refuses non-pickupable states (even with correct code)', async () => {
      riderOrder(OrderStatus.PICKED_UP);
      await expect(service.markPickedUp('user-1', 'o-1', '1234')).rejects.toMatchObject({
        response: { code: 'order_not_pickupable' },
      });
    });

    it('markDelivered flips PICKED_UP → DELIVERED with correct code', async () => {
      riderOrder(OrderStatus.PICKED_UP);
      await service.markDelivered('user-1', 'o-1', '5678');
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o-1' },
        data: { status: OrderStatus.DELIVERED, deliveredAt: expect.any(Date) },
      });
    });

    it('markDelivered rejects wrong delivery code', async () => {
      riderOrder(OrderStatus.PICKED_UP);
      await expect(service.markDelivered('user-1', 'o-1', '0000')).rejects.toMatchObject({
        response: { code: 'wrong_delivery_code' },
      });
    });

    it('markDelivered refuses if not yet PICKED_UP', async () => {
      riderOrder(OrderStatus.ACCEPTED);
      await expect(service.markDelivered('user-1', 'o-1', '5678')).rejects.toMatchObject({
        response: { code: 'order_not_in_delivery' },
      });
    });

    it('returns 404 when the order belongs to another rider', async () => {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'o-1',
        riderId: 'r-OTHER',
        status: OrderStatus.PICKED_UP,
        pickupCode: '1234',
        deliveryCode: '5678',
      });
      await expect(service.markDelivered('user-1', 'o-1', '5678')).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
