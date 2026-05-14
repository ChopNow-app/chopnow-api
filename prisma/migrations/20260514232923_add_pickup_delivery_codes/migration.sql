-- Story 4.13: 4-digit pickup + delivery confirmation codes on every order.
-- Existing rows (smoke seed orders, prod orders) get random codes so the
-- NOT NULL columns can be added without a data backfill. New orders will
-- get codes from the service layer at creation time.
ALTER TABLE "orders"
  ADD COLUMN "pickupCode"   VARCHAR(4) NOT NULL DEFAULT lpad((floor(random()*10000))::int::text, 4, '0'),
  ADD COLUMN "deliveryCode" VARCHAR(4) NOT NULL DEFAULT lpad((floor(random()*10000))::int::text, 4, '0');

-- Drop the defaults — the application is the source of truth for codes on
-- new rows. Leaving the DB default in place would mask a code-generation
-- regression by silently writing PG's random instead of crashing.
ALTER TABLE "orders"
  ALTER COLUMN "pickupCode"   DROP DEFAULT,
  ALTER COLUMN "deliveryCode" DROP DEFAULT;
