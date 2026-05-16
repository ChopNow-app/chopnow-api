import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, VendorType } from '@prisma/client';
import { MenuService } from './menu.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { R2Service } from '../../infra/r2/r2.service';

describe('MenuService', () => {
  let service: MenuService;
  let prisma: {
    vendor: { findUnique: jest.Mock };
    item: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    menuCategory: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let r2: { uploadImage: jest.Mock };

  const informalVendor = { id: 'v-informal', type: VendorType.INFORMAL };
  const restaurantVendor = { id: 'v-resto', type: VendorType.RESTAURANT };

  const file = (): Express.Multer.File =>
    ({
      fieldname: 'photo',
      originalname: 'item.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      size: 1024,
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
    }) as Express.Multer.File;

  beforeEach(async () => {
    prisma = {
      vendor: { findUnique: jest.fn() },
      item: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'item-new', ...data })),
        update: jest.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      menuCategory: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'cat-new', ...data })),
        update: jest.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    r2 = {
      uploadImage: jest.fn().mockResolvedValue({ key: 'item-photo/test.webp' }),
    };

    const module = await Test.createTestingModule({
      providers: [
        MenuService,
        { provide: PrismaService, useValue: prisma },
        { provide: R2Service, useValue: r2 },
      ],
    }).compile();
    service = module.get(MenuService);
  });

  describe('createItem', () => {
    it('creates an item for an informal vendor with all defaults', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.item.count.mockResolvedValue(5);

      const result = await service.createItem('user-1', { name: 'Ndolé', priceXAF: 2000 });

      expect(prisma.item.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          vendorId: 'v-informal',
          name: 'Ndolé',
          priceXAF: 2000,
          isAvailable: true,
          isInStock: true,
        }),
        select: expect.any(Object),
      });
      expect(result.name).toBe('Ndolé');
    });

    it('rejects informal vendor exceeding the 15-item cap', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.item.count.mockResolvedValue(15);

      await expect(
        service.createItem('user-1', { name: 'X', priceXAF: 1000 }),
      ).rejects.toMatchObject({ response: { code: 'menu_limit_reached' } });
      expect(prisma.item.create).not.toHaveBeenCalled();
    });

    it('allows restaurant vendor to exceed 15 items', async () => {
      prisma.vendor.findUnique.mockResolvedValue(restaurantVendor);
      prisma.item.count.mockResolvedValue(100);

      await service.createItem('user-1', { name: 'X', priceXAF: 1000 });

      expect(prisma.item.create).toHaveBeenCalled();
      // count was checked only for informal — restaurants bypass entirely
      expect(prisma.item.count).not.toHaveBeenCalled();
    });

    it('validates categoryId belongs to the same vendor', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.menuCategory.findUnique.mockResolvedValue({ vendorId: 'v-other' });

      await expect(
        service.createItem('user-1', { name: 'X', priceXAF: 1000, categoryId: 'cat-1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.item.create).not.toHaveBeenCalled();
    });

    it('rejects when vendor has no vendor row', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(
        service.createItem('user-1', { name: 'X', priceXAF: 1000 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateItem', () => {
    it("rejects updating another vendor's item", async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.item.findUnique.mockResolvedValue({ vendorId: 'v-OTHER' });

      await expect(
        service.updateItem('user-1', 'item-1', { name: 'Hacked', priceXAF: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.item.update).not.toHaveBeenCalled();
    });
  });

  describe('setItemStock (Story 2.10 — 1-tap + 3-tier follow-up)', () => {
    it('legacy isInStock=false maps to stockLevel OUT_OF_STOCK', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.item.findUnique.mockResolvedValue({ vendorId: 'v-informal' });

      await service.setItemStock('user-1', 'item-1', { isInStock: false });

      expect(prisma.item.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { stockLevel: 'OUT_OF_STOCK', isInStock: false },
        select: expect.any(Object),
      });
    });

    it('stockLevel=LOW_STOCK keeps isInStock=true (consumer can still order)', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.item.findUnique.mockResolvedValue({ vendorId: 'v-informal' });

      await service.setItemStock('user-1', 'item-1', { stockLevel: 'LOW_STOCK' });

      expect(prisma.item.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { stockLevel: 'LOW_STOCK', isInStock: true },
        select: expect.any(Object),
      });
    });

    it('stockLevel=IN_STOCK wins over a legacy boolean disagreement', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.item.findUnique.mockResolvedValue({ vendorId: 'v-informal' });

      // Both fields passed; the enum is the source of truth.
      await service.setItemStock('user-1', 'item-1', {
        stockLevel: 'IN_STOCK',
        isInStock: false,
      });

      expect(prisma.item.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { stockLevel: 'IN_STOCK', isInStock: true },
        select: expect.any(Object),
      });
    });
  });

  describe('setItemPhoto', () => {
    it('uploads to R2 and stores the key', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.item.findUnique.mockResolvedValue({ vendorId: 'v-informal' });

      await service.setItemPhoto('user-1', 'item-1', file());

      expect(r2.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ keyPrefix: 'item-photo' }),
      );
      expect(prisma.item.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { photoUrl: 'item-photo/test.webp' },
        select: expect.any(Object),
      });
    });
  });

  describe('deleteItem', () => {
    it('deletes when item belongs to caller', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.item.findUnique.mockResolvedValue({ vendorId: 'v-informal' });

      await service.deleteItem('user-1', 'item-1');
      expect(prisma.item.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    });
  });

  describe('createCategory', () => {
    it('rejects informal vendor exceeding the 2-category cap', async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.menuCategory.count.mockResolvedValue(2);

      await expect(service.createCategory('user-1', { name: 'Plats' })).rejects.toMatchObject({
        response: { code: 'category_limit_reached' },
      });
    });

    it('allows restaurant unlimited categories', async () => {
      prisma.vendor.findUnique.mockResolvedValue(restaurantVendor);

      await service.createCategory('user-1', { name: 'Entrées' });

      expect(prisma.menuCategory.create).toHaveBeenCalled();
      expect(prisma.menuCategory.count).not.toHaveBeenCalled();
    });

    it('surfaces P2002 (same-name duplicate) as category_name_taken', async () => {
      prisma.vendor.findUnique.mockResolvedValue(restaurantVendor);
      const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.0.0',
        meta: { target: ['vendorId', 'name'] },
      });
      prisma.menuCategory.create.mockRejectedValueOnce(err);

      await expect(service.createCategory('user-1', { name: 'Plats' })).rejects.toMatchObject({
        response: { code: 'category_name_taken' },
      });
    });

    it('rethrows non-P2002 Prisma errors as-is', async () => {
      prisma.vendor.findUnique.mockResolvedValue(restaurantVendor);
      const err = new Prisma.PrismaClientKnownRequestError('different', {
        code: 'P2025',
        clientVersion: '6.0.0',
      });
      prisma.menuCategory.create.mockRejectedValueOnce(err);

      await expect(service.createCategory('user-1', { name: 'X' })).rejects.toBe(err);
    });
  });

  describe('deleteCategory', () => {
    it("refuses to delete another vendor's category", async () => {
      prisma.vendor.findUnique.mockResolvedValue(informalVendor);
      prisma.menuCategory.findUnique.mockResolvedValue({ vendorId: 'v-other' });

      await expect(service.deleteCategory('user-1', 'cat-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
