-- Story 3.9 — post-delivery rating. One per order, both vendor + rider score
-- required (no partial ratings publicly).

CREATE TABLE "order_ratings" (
  "id"          TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "vendorId"    TEXT NOT NULL,
  "vendorScore" INTEGER NOT NULL,
  "riderScore"  INTEGER NOT NULL,
  "comment"     VARCHAR(200),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_ratings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_ratings_vendor_score_chk" CHECK ("vendorScore" BETWEEN 1 AND 5),
  CONSTRAINT "order_ratings_rider_score_chk"  CHECK ("riderScore"  BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX "order_ratings_orderId_key" ON "order_ratings" ("orderId");
CREATE INDEX "order_ratings_vendorId_idx" ON "order_ratings" ("vendorId");
CREATE INDEX "order_ratings_userId_idx"   ON "order_ratings" ("userId");

ALTER TABLE "order_ratings"
  ADD CONSTRAINT "order_ratings_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_ratings"
  ADD CONSTRAINT "order_ratings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_ratings"
  ADD CONSTRAINT "order_ratings_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
