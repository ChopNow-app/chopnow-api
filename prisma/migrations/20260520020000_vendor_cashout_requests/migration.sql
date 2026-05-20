-- On-demand cashout request table for INFORMAL vendors (ADR-0005, 7.2b).
-- Vendor-side: POST /api/vendors/me/cashout-request creates a row.
-- Admin-side: POST /api/admin/vendors/:id/cashout transitions APPROVED +
-- creates a VendorPayout via the existing 7.2a path.

CREATE TYPE "CashoutRequestStatus" AS ENUM (
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

CREATE TABLE "vendor_cashout_requests" (
  "id"               TEXT NOT NULL,
  "vendorId"         TEXT NOT NULL,
  "requestedXAF"     INTEGER NOT NULL,
  "status"           "CashoutRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "approvedAt"       TIMESTAMP(3),
  "approvedByUserId" TEXT,
  "rejectedAt"       TIMESTAMP(3),
  "rejectionReason"  TEXT,
  "payoutId"         TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vendor_cashout_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vendor_cashout_requests_vendorId_fkey" FOREIGN KEY ("vendorId")
    REFERENCES "vendors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "vendor_cashout_requests_vendorId_status_idx"
  ON "vendor_cashout_requests" ("vendorId", "status");
CREATE INDEX "vendor_cashout_requests_status_createdAt_idx"
  ON "vendor_cashout_requests" ("status", "createdAt");
