import { Module } from '@nestjs/common';
import { VendorController } from './vendor.controller';
import { VendorService } from './vendor.service';

/**
 * Epic 2 — Catalogue & Gestion Vendeur.
 * Vendors, items, availability, search, photos.
 *
 * Story 2.0 ✅ — informal vendor onboarding (POST /vendors).
 * Story 2.1 — restaurant formel onboarding (pending).
 * Story 2.2+ — menu management, browse, search, etc.
 */
@Module({
  controllers: [VendorController],
  providers: [VendorService],
  exports: [VendorService],
})
export class CatalogueModule {}
