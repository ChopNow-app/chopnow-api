-- Phase A1 — TOTP 2FA for admin login.

CREATE TABLE "admin_totp_secrets" (
    "userId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_totp_secrets_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "admin_totp_secrets"
  ADD CONSTRAINT "admin_totp_secrets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "admin_recovery_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_recovery_codes_userId_consumedAt_idx"
  ON "admin_recovery_codes"("userId", "consumedAt");

ALTER TABLE "admin_recovery_codes"
  ADD CONSTRAINT "admin_recovery_codes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
