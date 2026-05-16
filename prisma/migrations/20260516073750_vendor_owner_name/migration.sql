-- Story 2.0 hardening — capture vendor owner / gérant name at onboarding.
-- Nullable so existing rows aren't broken; new submissions enforce it via
-- the SubmitVendorDto's required @IsString() at the API layer.
ALTER TABLE "vendors" ADD COLUMN "ownerName" TEXT;
