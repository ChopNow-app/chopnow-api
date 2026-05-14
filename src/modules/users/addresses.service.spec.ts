import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AddressesService } from './addresses.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

function defaultRow(id: string) {
  return {
    id,
    user_id: 'user-1',
    label: null,
    description: null,
    quartier: null,
    landmark_id: null,
    lat: 4.0511,
    lng: 9.7679,
    phone: null,
    is_default: false,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

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
      // Default behaviour: derive the row id from the most recent
      // $executeRaw call's first binding (the generated uuid). Individual
      // tests override the rest of the columns via mockResolvedValueOnce
      // BEFORE calling the service, but the id is always pulled from the
      // INSERT bindings — keeps the closure-capture pattern from being
      // load-order dependent (Linux CI vs macOS local was order-sensitive
      // in a way I couldn't reproduce locally).
      $queryRaw: jest.fn(),
    };
    prisma.$queryRaw.mockImplementation(() => {
      const lastInsert = prisma.$executeRaw.mock.calls.at(-1);
      const id = (lastInsert?.[1] as string | undefined) ?? null;
      return Promise.resolve(id ? [{ ...defaultRow(id) }] : []);
    });

    const module = await Test.createTestingModule({
      providers: [AddressesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(AddressesService);
  });

  describe('create', () => {
    it('inserts an address with location via raw SQL', async () => {
      const result = await service.create('user-1', {
        label: 'Maison',
        description: '2ème portail bleu',
        quartier: 'Makepe',
        lat: 4.0511,
        lng: 9.7679,
        phone: '670000000',
        isDefault: false,
      });

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const rawArgs = prisma.$executeRaw.mock.calls[0];
      const sql = (rawArgs[0] as TemplateStringsArray).join('');
      expect(sql).toMatch(/INSERT INTO "addresses"/);
      expect(sql).toMatch(/ST_SetSRID\(ST_MakePoint\(/);
      // Phone canonicalised to E.164 in the bindings.
      const bindings = rawArgs.slice(1);
      expect(bindings).toContain('+237670000000');
      // The default-row mock at the top of the file echoes back the id that
      // went into the INSERT, so the service's `find(a => a.id === id)` resolves.
      expect(result).toBeDefined();
      expect(result.id).toBe(bindings[0]); // first binding is the generated uuid
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
