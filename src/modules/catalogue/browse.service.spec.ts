import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Prisma, VendorStatus, VendorType } from '@prisma/client';
import { BrowseService } from './browse.service';
import { AvailabilityService } from './availability.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('BrowseService', () => {
  let service: BrowseService;
  let prisma: {
    $queryRaw: jest.Mock;
    vendor: { findUnique: jest.Mock };
    menuCategory: { findMany: jest.Mock };
    item: { findMany: jest.Mock };
  };
  let availability: { computeIsOpenNow: jest.Mock };

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn(),
      vendor: { findUnique: jest.fn() },
      menuCategory: { findMany: jest.fn().mockResolvedValue([]) },
      item: { findMany: jest.fn().mockResolvedValue([]) },
    };
    availability = { computeIsOpenNow: jest.fn().mockReturnValue(true) };

    const module = await Test.createTestingModule({
      providers: [
        BrowseService,
        { provide: PrismaService, useValue: prisma },
        { provide: AvailabilityService, useValue: availability },
      ],
    }).compile();
    service = module.get(BrowseService);
  });

  describe('computeFee', () => {
    // Delegates to the shared computeDeliveryFeeXAF util (v2 formula: floor
    // 500, cap 1500, round UP to nearest 50). Detailed parametrisation lives
    // in delivery-fee.util.spec.ts.
    it.each([
      [0.5, 500],
      [2.0, 500],
      [5.0, 750],
      [12.5, 1500],
      [50, 1500],
    ])('km=%s → %i FCFA (delegated)', (km, expected) => {
      expect(service.computeFee(km)).toBe(expected);
    });
  });

  describe('classifyPlan', () => {
    it.each([
      [0.5, 1],
      [2.0, 1],
      [2.001, 2],
      [5.0, 2],
      [5.001, 3],
      [10, 3],
    ])('km=%s → plan %i', (km, plan) => {
      expect(service.classifyPlan(km)).toBe(plan);
    });
  });

  describe('browse', () => {
    it('maps raw rows into cards with computed fields', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'v-1',
          name: 'Chez Maman',
          type: VendorType.INFORMAL,
          badge: 'Cuisine locale 🍲',
          quartier: 'Makepe',
          profile_photo_url: 'vendor-profile/abc.webp',
          description: null,
          is_open: true,
          hours: null,
          distance_m: 1234, // 1.234 km
        },
      ]);

      const result = await service.browse({ lat: 4.0511, lng: 9.7679 });

      expect(result.vendors).toHaveLength(1);
      const card = result.vendors[0];
      expect(card.id).toBe('v-1');
      expect(card.distanceKm).toBe(1.2); // rounded to 1 decimal
      // 1.234 km → 250 + 123.4 = 373.4 → floor=500.
      expect(card.deliveryFeeXAF).toBe(500);
      expect(card.plan).toBe(1);
      expect(card.etaMinutes).toBeGreaterThan(20); // 20 base + drive time
      expect(card.isOpenNow).toBe(true);
    });

    it('passes lng/lat through the raw query parameters', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await service.browse({ lat: 4.0511, lng: 9.7679, radiusKm: 5 });

      // tagged-template invocation: first arg is the strings array, rest are bindings.
      // Order: lng+lat for ST_Distance, status enum, lng+lat for ST_DWithin, radius m,
      // then the optional search-filter fragment (Prisma.empty when q is absent).
      // lng comes BEFORE lat in PostGIS ST_MakePoint.
      const args = prisma.$queryRaw.mock.calls[0];
      const bindings = args.slice(1);
      expect(bindings).toEqual([
        9.7679,
        4.0511,
        VendorStatus.ACTIVE,
        9.7679,
        4.0511,
        5000,
        Prisma.empty,
      ]);
    });

    it('adds a name/badge/item-name search filter when q is provided', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await service.browse({ lat: 4.0511, lng: 9.7679, q: 'Ndolé' });

      const args = prisma.$queryRaw.mock.calls[0];
      const searchFilter = args[args.length - 1] as Prisma.Sql;
      expect(searchFilter.sql).toContain('v.name ILIKE');
      expect(searchFilter.sql).toContain('v.badge ILIKE');
      expect(searchFilter.sql).toContain('EXISTS');
      expect(searchFilter.sql).toContain('"isAvailable" = true');
      expect(searchFilter.values).toEqual(['%Ndolé%', '%Ndolé%', '%Ndolé%']);
    });

    it('omits the search filter when q is absent', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await service.browse({ lat: 4.0511, lng: 9.7679 });

      const args = prisma.$queryRaw.mock.calls[0];
      const searchFilter = args[args.length - 1] as Prisma.Sql;
      expect(searchFilter).toBe(Prisma.empty);
    });
  });

  describe('getVendorPublic', () => {
    it('returns vendor + categories + items when active', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Chez Maman',
        type: VendorType.INFORMAL,
        badge: null,
        quartier: 'Makepe',
        profilePhotoUrl: null,
        description: null,
        isOpen: true,
        hours: null,
        status: VendorStatus.ACTIVE,
      });
      prisma.menuCategory.findMany.mockResolvedValue([{ id: 'c-1', name: 'Plats', sortOrder: 0 }]);
      prisma.item.findMany.mockResolvedValue([
        {
          id: 'i-1',
          name: 'Ndolé',
          description: null,
          priceXAF: 2000,
          photoUrl: null,
          categoryId: 'c-1',
          isInStock: true,
          sortOrder: 0,
          preparationMinutes: null,
        },
      ]);

      const result = await service.getVendorPublic('v-1');

      expect(result.vendor.id).toBe('v-1');
      expect(result.vendor.isOpenNow).toBe(true);
      expect(result.categories).toHaveLength(1);
      expect(result.items).toHaveLength(1);
    });

    it('returns 404 for an unknown vendor', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(service.getVendorPublic('v-missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns 404 (not 403) for a non-ACTIVE vendor — no enumeration', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-pending',
        status: VendorStatus.PENDING_REVIEW,
        type: VendorType.INFORMAL,
        name: 'X',
        badge: null,
        quartier: 'Makepe',
        profilePhotoUrl: null,
        description: null,
        isOpen: false,
        hours: null,
      });
      await expect(service.getVendorPublic('v-pending')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
