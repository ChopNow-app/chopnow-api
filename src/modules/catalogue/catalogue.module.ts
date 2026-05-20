import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { BrowseController } from './browse.controller';
import { BrowseService } from './browse.service';
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
 * Story 2.4  ✅ — availability toggle + hours
 * Story 2.5  ✅ — consumer browse (GET /catalogue)
 * Story 2.6  ✅ — vendor public page (GET /vendors/:id)
 * Story 2.10 ✅ — 1-tap stock toggle
 * Story 2.11 (partial) ✅ — item photo upload (single WebP)
 * Story 2.1 — restaurant formel onboarding (pending)
 * Story 2.12 — FTS search (post-MVP)
 */
@Module({
  imports: [FinanceModule],
  controllers: [VendorController, MenuController, AvailabilityController, BrowseController],
  providers: [VendorService, MenuService, AvailabilityService, BrowseService],
  exports: [VendorService, MenuService, AvailabilityService, BrowseService],
})
export class CatalogueModule {}
