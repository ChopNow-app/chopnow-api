import { Injectable, NotFoundException } from '@nestjs/common';
import { VendorStatus, VendorType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeDeliveryFeeXAF } from '../../shared/pricing/delivery-fee.util';
import type { BrowseCatalogueDto } from './dto/browse-catalogue.dto';
import { AvailabilityService, WeeklyHours } from './availability.service';

// Story 2.5 — ETA only; fee math is shared with order checkout via
// computeDeliveryFeeXAF so the catalogue preview never drifts from the
// number a consumer actually pays at /orders.
const MOTO_AVG_KMH = 25;
// Vendor.avgPrepTimeMinutes not on schema yet (Story 2.7 follow-up); use a
// conservative default so the consumer ETA isn't wildly optimistic.
const DEFAULT_PREP_MINUTES = 20;

// Plan tier cut-offs (km). The spec calls them "Près de toi / Un peu plus loin
// / Tout Douala" — all three are returned in one response, frontend renders the
// section breaks.
const PLAN_1_RADIUS_KM = 2;
const PLAN_2_RADIUS_KM = 5;

/** Output card — what the consumer sees BEFORE clicking a vendor. */
export interface VendorCard {
  id: string;
  name: string;
  type: VendorType;
  badge: string | null;
  quartier: string;
  profilePhotoUrl: string | null;
  description: string | null;
  distanceKm: number;
  deliveryFeeXAF: number;
  etaMinutes: number;
  plan: 1 | 2 | 3;
  isOpenNow: boolean;
}

interface VendorRow {
  id: string;
  name: string;
  type: VendorType;
  badge: string | null;
  quartier: string;
  profile_photo_url: string | null;
  description: string | null;
  is_open: boolean;
  hours: WeeklyHours | null;
  distance_m: number;
}

@Injectable()
export class BrowseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
  ) {}

  async browse(dto: BrowseCatalogueDto): Promise<{ vendors: VendorCard[] }> {
    const radiusKm = dto.radiusKm ?? 10;
    const radiusMeters = radiusKm * 1000;

    // Raw query — Vendor.location is `Unsupported("geography(Point, 4326)")`
    // so Prisma can't read or filter on it. ST_DWithin uses the GIST index;
    // ST_Distance returns meters because both operands are `geography`.
    const rows = await this.prisma.$queryRaw<VendorRow[]>`
      SELECT
        v.id,
        v.name,
        v.type,
        v.badge,
        v.quartier,
        v."profilePhotoUrl" AS profile_photo_url,
        v.description,
        v."isOpen" AS is_open,
        v.hours,
        ST_Distance(
          v.location,
          ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography
        ) AS distance_m
      FROM vendors v
      WHERE v.status = ${VendorStatus.ACTIVE}::"VendorStatus"
        AND v."isOpen" = true
        AND ST_DWithin(
          v.location,
          ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography,
          ${radiusMeters}
        )
      ORDER BY distance_m ASC
      LIMIT 100
    `;

    const vendors: VendorCard[] = rows.map((row) => {
      const distanceKm = row.distance_m / 1000;
      const deliveryFeeXAF = this.computeFee(distanceKm);
      const etaMinutes = Math.round((distanceKm / MOTO_AVG_KMH) * 60 + DEFAULT_PREP_MINUTES);
      const plan = this.classifyPlan(distanceKm);
      const isOpenNow = this.availability.computeIsOpenNow(row.type, row.is_open, row.hours);
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        badge: row.badge,
        quartier: row.quartier,
        profilePhotoUrl: row.profile_photo_url,
        description: row.description,
        distanceKm: Math.round(distanceKm * 10) / 10, // 1 decimal — display precision
        deliveryFeeXAF,
        etaMinutes,
        plan,
        isOpenNow,
      };
    });

    return { vendors };
  }

  async getVendorPublic(vendorId: string): Promise<{
    vendor: Omit<VendorCard, 'distanceKm' | 'deliveryFeeXAF' | 'etaMinutes' | 'plan'> & {
      hours: WeeklyHours | null;
    };
    categories: Array<{ id: string; name: string; sortOrder: number }>;
    items: Array<{
      id: string;
      name: string;
      description: string | null;
      priceXAF: number;
      photoUrl: string | null;
      categoryId: string | null;
      isInStock: boolean;
      sortOrder: number;
      preparationMinutes: number | null;
    }>;
  }> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: {
        id: true,
        name: true,
        type: true,
        badge: true,
        quartier: true,
        profilePhotoUrl: true,
        description: true,
        isOpen: true,
        hours: true,
        status: true,
      },
    });
    if (!vendor || vendor.status !== VendorStatus.ACTIVE) {
      // 404 (not 403) — don't leak existence of un-approved vendors.
      throw new NotFoundException('vendor_not_found');
    }

    const [categories, items] = await Promise.all([
      this.prisma.menuCategory.findMany({
        where: { vendorId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, sortOrder: true },
      }),
      this.prisma.item.findMany({
        where: { vendorId, isAvailable: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          priceXAF: true,
          photoUrl: true,
          categoryId: true,
          isInStock: true,
          sortOrder: true,
          preparationMinutes: true,
        },
      }),
    ]);

    const hours = vendor.hours as WeeklyHours | null;
    return {
      vendor: {
        id: vendor.id,
        name: vendor.name,
        type: vendor.type,
        badge: vendor.badge,
        quartier: vendor.quartier,
        profilePhotoUrl: vendor.profilePhotoUrl,
        description: vendor.description,
        hours,
        isOpenNow: this.availability.computeIsOpenNow(vendor.type, vendor.isOpen, hours),
      },
      categories,
      items,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────

  /** Re-exports the shared util so existing callers (and tests) keep working. */
  computeFee(distanceKm: number): number {
    return computeDeliveryFeeXAF(distanceKm);
  }

  classifyPlan(distanceKm: number): 1 | 2 | 3 {
    if (distanceKm <= PLAN_1_RADIUS_KM) return 1;
    if (distanceKm <= PLAN_2_RADIUS_KM) return 2;
    return 3;
  }
}
