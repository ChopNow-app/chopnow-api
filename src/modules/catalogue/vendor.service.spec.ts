import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { UserRole, VendorStatus, VendorType } from '@prisma/client';
import { VendorService } from './vendor.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { R2Service } from '../../infra/r2/r2.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { DeclaredCapacity, SubmitVendorDto } from './dto/submit-vendor.dto';

describe('VendorService', () => {
  let service: VendorService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    item: { create: jest.Mock; createMany: jest.Mock };
    vendor: { findUnique: jest.Mock; update: jest.Mock };
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let r2: { uploadImage: jest.Mock };
  let twilio: { sendWhatsApp: jest.Mock };

  const validDto: SubmitVendorDto = {
    name: 'Chez Maman',
    ownerName: 'Marie Mboué',
    quartier: 'Makepe',
    pointOfReference: 'En face de la pharmacie',
    whatsappPhone: '670000010',
    momoPhone: '670000010',
    declaredCapacity: DeclaredCapacity.R_10_30,
    firstItemName: 'Poulet DG',
    firstItemPriceXAF: 3000,
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

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'user-new', role: UserRole.VENDOR }),
        update: jest.fn().mockResolvedValue({}),
      },
      item: {
        create: jest.fn().mockResolvedValue({ id: 'item-1' }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vendor: { findUnique: jest.fn(), update: jest.fn() },
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
        VendorService,
        { provide: PrismaService, useValue: prisma },
        { provide: R2Service, useValue: r2 },
        { provide: TwilioService, useValue: twilio },
      ],
    }).compile();

    service = module.get(VendorService);
  });

  describe('submitInformal', () => {
    it('creates user + vendor + item in a transaction and returns PENDING_REVIEW', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.submitInformal(validDto, {
        profilePhoto: file('profilePhoto'),
        firstItemPhoto: file('firstItemPhoto'),
      });

      expect(result.status).toBe(VendorStatus.PENDING_REVIEW);
      expect(result.vendorId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.message).toMatch(/Demande envoyée/);

      // Photo upload to R2 with the right key prefixes
      expect(r2.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ keyPrefix: 'vendor-profile' }),
      );
      expect(r2.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ keyPrefix: 'item-photo' }),
      );

      // Transaction wraps everything
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // User created with VENDOR role (no prior user)
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { phone: '+237670000010', role: UserRole.VENDOR },
      });

      // Vendor inserted via raw SQL (location is Unsupported)
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      // The tagged-template call signature: first arg is the strings array.
      const rawStrings = prisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray;
      expect(rawStrings.join('')).toMatch(/INSERT INTO vendors/);
      expect(rawStrings.join('')).toMatch(/ST_SetSRID\(ST_MakePoint\(/);

      // First item created with the photo key + parsed price. The service now
      // uses createMany so we look at the first element of the data array.
      const itemArgs = prisma.item.createMany.mock.calls[0][0].data[0];
      expect(itemArgs).toMatchObject({
        name: 'Poulet DG',
        priceXAF: 3000,
        photoUrl: 'item-photo/test-uuid.webp',
      });

      // WhatsApp confirmation queued (fire-and-forget — wait a microtask)
      await new Promise((r) => setImmediate(r));
      expect(twilio.sendWhatsApp).toHaveBeenCalledWith(
        '+237670000010',
        expect.stringMatching(/Demande TchopNow/i),
      );
    });

    it('upgrades a CONSUMER user to VENDOR role on first submission', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-existing',
        phone: '+237670000010',
        role: UserRole.CONSUMER,
        vendor: null,
      });

      await service.submitInformal(validDto, {
        profilePhoto: file('profilePhoto'),
        firstItemPhoto: file('firstItemPhoto'),
      });

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-existing' },
        data: { role: UserRole.VENDOR },
      });
    });

    it('rejects when a vendor already exists for this phone (idempotency)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-existing',
        phone: '+237670000010',
        role: UserRole.VENDOR,
        vendor: { id: 'vendor-existing' },
      });

      await expect(
        service.submitInformal(validDto, {
          profilePhoto: file('profilePhoto'),
          firstItemPhoto: file('firstItemPhoto'),
        }),
      ).rejects.toMatchObject({ response: { code: 'vendor_already_submitted' } });

      // No side effects.
      expect(r2.uploadImage).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects when the phone is used by a RIDER / ADMIN account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-rider',
        phone: '+237670000010',
        role: UserRole.RIDER,
        vendor: null,
      });

      await expect(
        service.submitInformal(validDto, {
          profilePhoto: file('profilePhoto'),
          firstItemPhoto: file('firstItemPhoto'),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      ['profilePhoto', { firstItemPhoto: 'firstItemPhoto' }],
      ['firstItemPhoto', { profilePhoto: 'profilePhoto' }],
    ])('rejects when %s is missing', async (missing, present) => {
      const files: Record<string, Express.Multer.File> = {};
      for (const [k, name] of Object.entries(present)) files[k] = file(name);

      await expect(service.submitInformal(validDto, files)).rejects.toMatchObject({
        message: expect.stringContaining(missing),
      });
      await expect(service.submitInformal(validDto, files)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('canonicalises both phones to E.164 before persisting', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.submitInformal(
        { ...validDto, whatsappPhone: '670000099', momoPhone: '670000099' },
        { profilePhoto: file('profilePhoto'), firstItemPhoto: file('firstItemPhoto') },
      );

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { phone: '+237670000099', role: UserRole.VENDOR },
      });
      // Raw SQL bindings include the normalized phone — Prisma's tagged
      // template passes parameters as the second... Nth arguments.
      const rawArgs = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(rawArgs).toEqual(expect.arrayContaining(['+237670000099']));
    });

    it.each([
      [DeclaredCapacity.LT_10, 8],
      [DeclaredCapacity.R_10_30, 30],
      [DeclaredCapacity.GT_30, 50],
    ])('maps declaredCapacity %s to integer %i', async (cap, expected) => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.submitInformal(
        { ...validDto, declaredCapacity: cap },
        { profilePhoto: file('profilePhoto'), firstItemPhoto: file('firstItemPhoto') },
      );

      // declaredCapacity is the 11th positional binding in the INSERT (after
      // id, userId, name, type, status, quartier, pointOfReference,
      // whatsappPhone, momoPhone, badge → 10 fields, then capacityInt at 11).
      const rawArgs = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(rawArgs).toContain(expected);
    });

    it('does not throw when the WhatsApp confirmation fails', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      twilio.sendWhatsApp.mockRejectedValueOnce(new Error('twilio down'));

      const result = await service.submitInformal(validDto, {
        profilePhoto: file('profilePhoto'),
        firstItemPhoto: file('firstItemPhoto'),
      });

      // Submission still succeeded — the WhatsApp send is fire-and-forget.
      expect(result.status).toBe(VendorStatus.PENDING_REVIEW);
      // Give the microtask a chance to land + assert the call was attempted.
      await new Promise((r) => setImmediate(r));
      expect(twilio.sendWhatsApp).toHaveBeenCalled();
    });

    it('requires an enseigne photo when type=RESTAURANT', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.submitInformal(
          {
            ...validDto,
            type: VendorType.RESTAURANT,
            rccmNumber: 'RC/DLA/2024/A/123',
            niuNumber: 'M091900012345A',
          },
          {
            profilePhoto: file('profilePhoto'),
            firstItemPhoto: file('firstItemPhoto'),
            // enseignePhoto deliberately omitted
          },
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'enseigne_photo_required' }),
      });
      // Photos already uploaded to R2 before the throw — they orphan into
      // the lifecycle sweeper, that's accepted convention.
    });

    it('uploads enseigne to vendor-kyc/ prefix and persists KYC fields when type=RESTAURANT', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.submitInformal(
        {
          ...validDto,
          type: VendorType.RESTAURANT,
          rccmNumber: 'RC/DLA/2024/A/123',
          niuNumber: 'M091900012345A',
        },
        {
          profilePhoto: file('profilePhoto'),
          firstItemPhoto: file('firstItemPhoto'),
          enseignePhoto: file('enseignePhoto'),
        },
      );

      // R2 upload landed under vendor-kyc/
      expect(r2.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ keyPrefix: 'vendor-kyc' }),
      );

      // Raw INSERT carries the KYC values in the parameter array
      const rawArgs = prisma.$executeRaw.mock.calls[0];
      // The tagged-template structure: [stringsArray, ...values]. Find our 3 values.
      const allValues = rawArgs.slice(1);
      expect(allValues).toContain('RC/DLA/2024/A/123');
      expect(allValues).toContain('M091900012345A');
      expect(allValues).toContain('vendor-kyc/test-uuid.webp');
    });

    it('passes NULL for KYC columns when type=INFORMAL', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.submitInformal(validDto, {
        profilePhoto: file('profilePhoto'),
        firstItemPhoto: file('firstItemPhoto'),
      });

      // No vendor-kyc upload happened
      expect(r2.uploadImage).not.toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ keyPrefix: 'vendor-kyc' }),
      );
      // KYC values in the raw INSERT are all null
      const allValues = prisma.$executeRaw.mock.calls[0].slice(1);
      // rccmNumber, niuNumber, enseignePhotoUrl positions all null — easier
      // to assert they aren't truthy KYC strings than to index by position.
      expect(allValues).not.toContain('RC/DLA/2024/A/123');
      const nullCount = allValues.filter((v: unknown) => v === null).length;
      expect(nullCount).toBeGreaterThanOrEqual(3); // pointOfReference + 3 KYC nulls
    });
  });

  describe('getOwn', () => {
    it('returns the vendor self-profile (no admin-only fields)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Chez Maman',
        type: 'INFORMAL',
        status: 'ACTIVE',
        quartier: 'Bonamoussadi',
        momoPhone: '+237670000101',
        isOpen: true,
        coverPhotoUrl: null,
      });

      const result = await service.getOwn('user-1');

      expect(prisma.vendor.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: expect.objectContaining({
          id: true,
          type: true,
          coverPhotoUrl: true,
          // explicit assertion that admin-only fields are NOT selected
        }),
      });
      // The select must not include these — vendors don't see their own
      // commission, rejection reason, or KYC numbers (those stay admin-only).
      const select = prisma.vendor.findUnique.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('commissionRate');
      expect(select).not.toHaveProperty('rejectionReason');
      expect(result.type).toBe('INFORMAL');
    });

    it('throws NotFoundException when the caller has no Vendor row', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(service.getOwn('user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateOwn (Story 1.8)', () => {
    it('updates name + description + normalises momoPhone', async () => {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.vendor.update.mockResolvedValue({
        id: 'v-1',
        name: 'New Name',
        description: 'New desc',
        momoPhone: '+237670000099',
      });

      const result = await service.updateOwn('user-1', {
        name: 'New Name',
        description: 'New desc',
        momoPhone: '670000099',
      });

      expect(prisma.vendor.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { id: true },
      });
      expect(prisma.vendor.update).toHaveBeenCalledWith({
        where: { id: 'v-1' },
        data: {
          name: 'New Name',
          description: 'New desc',
          momoPhone: '+237670000099',
        },
        select: expect.any(Object),
      });
      expect(result.momoPhone).toBe('+237670000099');
    });

    it('rejects empty body with no_fields_to_update', async () => {
      await expect(service.updateOwn('user-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vendor.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the caller has no Vendor row', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(service.updateOwn('user-1', { name: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('does NOT touch momoPhone when undefined (vs explicit empty)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.vendor.update.mockResolvedValue({ id: 'v-1', name: 'X' });

      await service.updateOwn('user-1', { name: 'X' });

      const data = prisma.vendor.update.mock.calls[0][0].data;
      expect(data.momoPhone).toBeUndefined();
    });
  });

  describe('updateOwnProfilePhoto (Story 1.8)', () => {
    it('uploads the new photo and stores the R2 key on the vendor row', async () => {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.vendor.update.mockResolvedValue({
        id: 'v-1',
        profilePhotoUrl: 'vendor-profile/test-uuid.webp',
      });

      const result = await service.updateOwnProfilePhoto('user-1', file('photo'));

      expect(r2.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ keyPrefix: 'vendor-profile' }),
      );
      expect(prisma.vendor.update).toHaveBeenCalledWith({
        where: { id: 'v-1' },
        data: { profilePhotoUrl: 'vendor-profile/test-uuid.webp' },
        select: expect.any(Object),
      });
      expect(result.profilePhotoUrl).toBe('vendor-profile/test-uuid.webp');
    });

    it('throws NotFoundException when the caller has no Vendor row', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(service.updateOwnProfilePhoto('user-1', file('photo'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(r2.uploadImage).not.toHaveBeenCalled();
    });
  });

  describe('updateOwnCoverPhoto', () => {
    it('uploads to vendor-cover/ and stores coverPhotoUrl', async () => {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.vendor.update.mockResolvedValue({
        id: 'v-1',
        coverPhotoUrl: 'vendor-cover/test-uuid.webp',
      });

      const result = await service.updateOwnCoverPhoto('user-1', file('photo'));

      expect(r2.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ keyPrefix: 'vendor-cover' }),
      );
      expect(prisma.vendor.update).toHaveBeenCalledWith({
        where: { id: 'v-1' },
        data: { coverPhotoUrl: 'vendor-cover/test-uuid.webp' },
        select: expect.any(Object),
      });
      expect(result.coverPhotoUrl).toBe('vendor-cover/test-uuid.webp');
    });

    it('throws NotFoundException when the caller has no Vendor row', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(service.updateOwnCoverPhoto('user-1', file('photo'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(r2.uploadImage).not.toHaveBeenCalled();
    });
  });
});
