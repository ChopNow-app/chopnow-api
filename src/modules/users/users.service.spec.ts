import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: { user: { findUnique: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
    const module = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(UsersService);
  });

  describe('findById', () => {
    it('returns the profile when found', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        phone: '+237670000001',
        displayName: 'Maman',
        role: 'CONSUMER',
      });
      const result = await service.findById('u-1');
      expect(result.id).toBe('u-1');
    });

    it('throws NotFoundException when missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findById('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateProfile (Story 1.8)', () => {
    it('updates displayName and returns the projected profile', async () => {
      prisma.user.update.mockResolvedValue({
        id: 'u-1',
        displayName: 'Maman Mboué',
        role: 'CONSUMER',
      });

      const result = await service.updateProfile('u-1', { displayName: 'Maman Mboué' });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { displayName: 'Maman Mboué' },
        select: expect.objectContaining({ displayName: true, role: true }),
      });
      expect(result.displayName).toBe('Maman Mboué');
    });

    it('rejects an empty body with no_fields_to_update', async () => {
      await expect(service.updateProfile('u-1', {})).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateProfile('u-1', {})).rejects.toMatchObject({
        message: 'no_fields_to_update',
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
