-- Story 2.1 (partial) — Restaurant KYC fields.
-- All nullable: existing INFORMAL + SEMI_FORMAL rows stay valid; SubmitVendorDto
-- enforces presence only when type=RESTAURANT.
ALTER TABLE "vendors" ADD COLUMN "rccmNumber" TEXT;
ALTER TABLE "vendors" ADD COLUMN "niuNumber" TEXT;
ALTER TABLE "vendors" ADD COLUMN "enseignePhotoUrl" TEXT;
