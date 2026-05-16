-- Item.kind + Item.stockLevel (see schema.prisma).
-- Backfill: every existing item is FOOD with stockLevel derived from
-- isInStock so the catalogue browse path keeps producing identical results.

CREATE TYPE "ItemKind" AS ENUM ('FOOD', 'DRINK');
CREATE TYPE "StockLevel" AS ENUM ('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK');

ALTER TABLE "items"
  ADD COLUMN "kind" "ItemKind" NOT NULL DEFAULT 'FOOD',
  ADD COLUMN "stockLevel" "StockLevel" NOT NULL DEFAULT 'IN_STOCK';

-- Map legacy isInStock=false to OUT_OF_STOCK so the menu screen renders
-- the right badge from day one.
UPDATE "items" SET "stockLevel" = 'OUT_OF_STOCK' WHERE "isInStock" = false;
