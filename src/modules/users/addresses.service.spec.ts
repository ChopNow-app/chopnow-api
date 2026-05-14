import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AddressesService } from './addresses.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('AddressesService', () => {
  let service: AddressesService;
  let prisma: {
    address: { count: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock; delete: jest.Mock };
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      address: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        delete: jest.fn().mockResolvedValue({}),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [AddressesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(AddressesService);
  });

  describe('create', () => {
    it('inserts an address with location via raw SQL', async () => {
      const dto = {
        label: 'Maison',
        description: '2ème portail bleu',
        quartier: 'Makepe',
        lat: 4.0511,
        lng: 9.7679,
        phone: '670000000',
        isDefault: false,
      };
      // Force the post-insert list() to find the new row
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'a-new',
          user_id: 'user-1',
          label: 'Maison',
          description: '2ème portail bleu',
          quartier: 'Makepe',
          landmark_id: null,
          lat: 4.0511,
          lng: 9.7679,
          phone: '+237670000000',
          is_default: false,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const result = await service.create('user-1', dto);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const rawArgs = prisma.$executeRaw.mock.calls[0];
      const sql = (rawArgs[0] as TemplateStringsArray).join('');
      expect(sql).toMatch(/INSERT INTO "addresses"/);
      expect(sql).toMatch(/ST_SetSRID\(ST_MakePoint\(/);
      // Phone canonicalised to E.164 before binding
      const bindings = rawArgs.slice(1);
      expect(bindings).toContain('+237670000000');

      expect(result.label).toBe('Maison');
    });

    it('rejects when user already has 3 saved addresses', async () => {
      prisma.address.count.mockResolvedValue(3);
      await expect(service.create('user-1', { lat: 0, lng: 0 })).rejects.toMatchObject({
        response: { code: 'address_limit_reached' },
      });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('demotes any existing default when creating with isDefault=true', async () => {
      prisma.address.count.mockResolvedValue(1);
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'a-new',
          user_id: 'user-1',
          label: 'X',
          description: null,
          quartier: null,
          landmark_id: null,
          lat: 0,
          lng: 0,
          phone: null,
          is_default: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      await service.create('user-1', { lat: 4, lng: 9, isDefault: true });

      expect(prisma.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isDefault: true },
        data: { isDefault: false },
      });
    });
  });

  describe('update', () => {
    it("refuses to update another user's address", async () => {
      prisma.address.findUnique.mockResolvedValue({ id: 'a-1', userId: 'OTHER' });
      await expect(service.update('user-1', 'a-1', { lat: 0, lng: 0 })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for missing address', async () => {
      prisma.address.findUnique.mockResolvedValue(null);
      await expect(
        service.update('user-1', 'a-missing', { lat: 0, lng: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('delete', () => {
    it("refuses to delete another user's address", async () => {
      prisma.address.findUnique.mockResolvedValue({ id: 'a-1', userId: 'OTHER' });
      await expect(service.delete('user-1', 'a-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.address.delete).not.toHaveBeenCalled();
    });

    it('deletes when ownership matches', async () => {
      prisma.address.findUnique.mockResolvedValue({ id: 'a-1', userId: 'user-1' });
      await service.delete('user-1', 'a-1');
      expect(prisma.address.delete).toHaveBeenCalledWith({ where: { id: 'a-1' } });
    });
  });
});
