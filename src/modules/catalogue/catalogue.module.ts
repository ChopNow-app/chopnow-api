import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { VendorController } from './vendor.controller';
import { VendorService } from './vendor.service';

/**
 * Epic 2 — Catalogue & Gestion Vendeur.
 *
 * Story 2.0  ✅ — informal vendor onboarding (POST /vendors)
 * Story 1.8  ✅ — vendor self-update (PATCH /vendors/me)
 * Story 2.2  ✅ — informal menu management (items CRUD + stock toggle)
 * Story 2.3  ✅ — restaurant menu management (categories CRUD)
 * Story 2.4  ✅ — availability toggle + hours (PATCH /availability, PUT /hours)
 * Story 2.10 ✅ — 1-tap stock toggle (PATCH /vendors/me/items/:id/stock)
 * Story 2.11 (partial) ✅ — item photo upload (single WebP; multi-variant deferred)
 * Story 2.1 — restaurant formel onboarding (pending)
 * Story 2.5 — consumer browse (next PR)
 * Story 2.6 — vendor public page (next PR)
 */
@Module({
  controllers: [VendorController, MenuController, AvailabilityController],
  providers: [VendorService, MenuService, AvailabilityService],
  exports: [VendorService, MenuService, AvailabilityService],
})
export class CatalogueModule {}
