-- Story 2.4 — vendor open/closed toggle + per-day hours.
-- isOpen: source-of-truth flag (informal toggles by hand, restaurant cron sets
-- based on `hours`). Default false so newly onboarded vendors stay invisible
-- in the catalogue until they opt in.
-- hours: nullable JSON, restaurant-only in practice (informal vendors ignore it).
ALTER TABLE "vendors" ADD COLUMN "isOpen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "vendors" ADD COLUMN "hours" JSONB;
