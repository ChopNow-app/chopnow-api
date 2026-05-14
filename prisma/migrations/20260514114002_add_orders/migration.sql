-- Epic 3 — orders + order_items + payment-related enums.

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING',
  'CONFIRMED',
  'ACCEPTED',
  'IN_PREP',
  'READY_PICKUP',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
  'REFUSED',
  'EXPIRED'
);

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('MTN_MOMO', 'ORANGE_MONEY', 'CASH');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "orders" (
  "id"                  TEXT NOT NULL,
  "code"                TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "vendorId"            TEXT NOT NULL,
  "status"              "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "subtotalXAF"         INTEGER NOT NULL,
  "deliveryFeeXAF"      INTEGER NOT NULL,
  "totalXAF"            INTEGER NOT NULL,
  "noteForVendor"       VARCHAR(120),
  "paymentMethod"       "PaymentMethod" NOT NULL,
  "paymentStatus"       "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "paymentReference"    TEXT,
  "payerPhone"          TEXT,
  "deliveryLat"         DOUBLE PRECISION NOT NULL,
  "deliveryLng"         DOUBLE PRECISION NOT NULL,
  "deliveryQuartier"    TEXT NOT NULL,
  "deliveryLandmark"    TEXT,
  "deliveryDescription" TEXT,
  "deliveryPhone"       TEXT NOT NULL,
  "refusalReason"       TEXT,
  "placedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt"              TIMESTAMP(3),
  "acceptedAt"          TIMESTAMP(3),
  "refusedAt"           TIMESTAMP(3),
  "preparedAt"          TIMESTAMP(3),
  "pickedUpAt"          TIMESTAMP(3),
  "deliveredAt"         TIMESTAMP(3),
  "cancelledAt"         TIMESTAMP(3),
  "idempotencyKey"      TEXT,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
  "id"               TEXT NOT NULL,
  "orderId"          TEXT NOT NULL,
  "itemId"           TEXT,
  "nameSnapshot"     TEXT NOT NULL,
  "priceXAFSnapshot" INTEGER NOT NULL,
  "quantity"         INTEGER NOT NULL,
  "lineXAF"          INTEGER NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "orders_code_key" ON "orders" ("code");
CREATE UNIQUE INDEX "orders_paymentReference_key" ON "orders" ("paymentReference");
CREATE UNIQUE INDEX "orders_userId_idempotencyKey_key" ON "orders" ("userId", "idempotencyKey");
CREATE INDEX "orders_userId_idx" ON "orders" ("userId");
CREATE INDEX "orders_vendorId_idx" ON "orders" ("vendorId");
CREATE INDEX "orders_status_idx" ON "orders" ("status");
CREATE INDEX "orders_placedAt_idx" ON "orders" ("placedAt");
CREATE INDEX "order_items_orderId_idx" ON "order_items" ("orderId");

-- AddForeignKey
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "vendors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "items" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
