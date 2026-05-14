import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { VendorType } from '@prisma/client';
import { AvailabilityService } from './availability.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('AvailabilityService', () => {
  let service: AvailabilityService;
  let prisma: { vendor: { findUnique: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      vendor: {
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })),
      },
    };
    const module = await Test.createTestingModule({
      providers: [AvailabilityService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(AvailabilityService);
  });

  describe('setAvailability', () => {
    it('updates isOpen', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        type: VendorType.INFORMAL,
        isOpen: false,
        hours: null,
      });
      const result = await service.setAvailability('user-1', { isOpen: true });
      expect(prisma.vendor.update).toHaveBeenCalledWith({
        where: { id: 'v-1' },
        data: { isOpen: true },
        select: expect.any(Object),
      });
      expect(result.isOpen).toBe(true);
    });

    it('throws NotFoundException for non-vendor caller', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(service.setAvailability('user-1', { isOpen: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setHours', () => {
    it('persists only the explicitly-provided days', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        type: VendorType.RESTAURANT,
        isOpen: true,
        hours: null,
      });

      await service.setHours('user-1', {
        mon: { open: '07:30', close: '21:00' },
        wed: { open: '08:00', close: '20:00' },
      });

      const data = prisma.vendor.update.mock.calls[0][0].data;
      expect(data.hours).toEqual({
        mon: { open: '07:30', close: '21:00' },
        wed: { open: '08:00', close: '20:00' },
      });
      // Days not in the body are not persisted as undefined keys
      expect(Object.keys(data.hours)).toEqual(['mon', 'wed']);
    });
  });

  describe('computeIsOpenNow', () => {
    it('returns false when isOpen is false regardless of hours', () => {
      expect(
        service.computeIsOpenNow(VendorType.RESTAURANT, false, {
          mon: { open: '00:00', close: '23:59' },
        }),
      ).toBe(false);
    });

    it('returns true for INFORMAL when isOpen=true (hours ignored)', () => {
      expect(service.computeIsOpenNow(VendorType.INFORMAL, true, null)).toBe(true);
      expect(
        service.computeIsOpenNow(VendorType.INFORMAL, true, {
          mon: { open: '00:00', close: '00:01' },
        }),
      ).toBe(true);
    });

    it('returns true for RESTAURANT with no hours configured (manual toggle path)', () => {
      expect(service.computeIsOpenNow(VendorType.RESTAURANT, true, null)).toBe(true);
      expect(service.computeIsOpenNow(VendorType.RESTAURANT, true, {})).toBe(true);
    });

    it('returns false for RESTAURANT when today is not configured', () => {
      // Mock a Wednesday (day 3).
      const wednesday = new Date('2026-05-13T12:00:00Z');
      jest.useFakeTimers().setSystemTime(wednesday);

      try {
        expect(
          service.computeIsOpenNow(VendorType.RESTAURANT, true, {
            mon: { open: '07:30', close: '21:00' },
          }),
        ).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('returns true / false based on the clock inside the configured slot', () => {
      const wednesdayMidday = new Date('2026-05-13T12:00:00');
      jest.useFakeTimers().setSystemTime(wednesdayMidday);

      try {
        expect(
          service.computeIsOpenNow(VendorType.RESTAURANT, true, {
            wed: { open: '08:00', close: '21:00' },
          }),
        ).toBe(true);
        expect(
          service.computeIsOpenNow(VendorType.RESTAURANT, true, {
            wed: { open: '08:00', close: '11:00' }, // closed at 12:00
          }),
        ).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
