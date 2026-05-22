import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VendorType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { UpdateAvailabilityDto, UpdateHoursDto } from './dto/availability.dto';

type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface DayHours {
  open: string;
  close: string;
}
export type WeeklyHours = Partial<Record<DayKey, DayHours>>;

/**
 * Story 2.4 — vendor availability + opening hours.
 *
 * `isOpen` is the live flag the catalogue reads. For INFORMAL vendors it's the
 * only signal (they have no hours). For RESTAURANT vendors, a future cron
 * (Story 6.x) will flip `isOpen` based on `hours`; until then the restaurant
 * also toggles by hand.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwn(userId: string) {
    const vendor = await this.requireVendor(userId);
    return {
      isOpen: vendor.isOpen,
      hours: (vendor.hours as WeeklyHours | null) ?? null,
      // Computed-now helper so the dashboard doesn't have to reimplement
      // weekday/clock comparisons. For INFORMAL this just mirrors isOpen.
      isOpenNow: this.computeIsOpenNow(
        vendor.type,
        vendor.isOpen,
        vendor.hours as WeeklyHours | null,
      ),
    };
  }

  async setAvailability(userId: string, dto: UpdateAvailabilityDto) {
    const vendor = await this.requireVendor(userId);
    return this.prisma.vendor.update({
      where: { id: vendor.id },
      data: { isOpen: dto.isOpen },
      select: { id: true, isOpen: true, updatedAt: true },
    });
  }

  async setHours(userId: string, dto: UpdateHoursDto) {
    const vendor = await this.requireVendor(userId);
    // Strip undefined keys; storing `{ mon: undefined, ... }` in JSON would
    // come back as missing fields anyway, but explicit is cleaner.
    const hours: WeeklyHours = {};
    for (const day of DAY_KEYS) {
      const value = dto[day];
      if (value) hours[day] = { open: value.open, close: value.close };
    }
    return this.prisma.vendor.update({
      where: { id: vendor.id },
      data: { hours: hours as unknown as Prisma.InputJsonValue },
      select: { id: true, hours: true, updatedAt: true },
    });
  }

  private async requireVendor(userId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, type: true, isOpen: true, hours: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');
    return vendor;
  }

  /**
   * Live "is the vendor open right now?" helper. Order of precedence:
   *   1. INFORMAL → trust isOpen verbatim (no hours concept)
   *   2. RESTAURANT → isOpen must be true AND now must fall inside the day's
   *      configured slot. If hours is null/empty, isOpen alone is enough
   *      (restaurant hasn't configured yet — manual toggle still works).
   */
  computeIsOpenNow(type: VendorType, isOpen: boolean, hours: WeeklyHours | null): boolean {
    if (!isOpen) return false;
    if (type === VendorType.INFORMAL) return true;
    if (!hours || Object.keys(hours).length === 0) return true;

    const now = new Date();
    const today = DAY_KEYS[now.getDay()];
    const slot = hours[today];
    if (!slot) return false;

    const hhmm = `${now.getHours().toString().padStart(2, '0')}:${now
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
    return hhmm >= slot.open && hhmm < slot.close;
  }
}
