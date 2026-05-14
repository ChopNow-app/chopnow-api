-- Story 3.2 — saved address can carry its own delivery phone (different from
-- the user's main phone, e.g. partner's home).
ALTER TABLE "addresses" ADD COLUMN "phone" TEXT;
