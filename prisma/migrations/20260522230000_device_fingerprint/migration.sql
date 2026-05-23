-- Phase C1 — per-device tracking + RefreshToken.deviceId fingerprint.
--
-- A `Device` row represents one (user, browser-or-PWA-install) pair.
-- The row's id IS the value stored client-side in the HttpOnly
-- `chopnow_did` cookie — a random UUID, unguessable, so doubling as
-- the cookie value adds no enumeration risk. New devices issue an email
-- alert to the user (Phase C2).

CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAgentHash" TEXT,
    "userAgentLabel" TEXT,
    "ipAddress" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "devices_userId_idx" ON "devices"("userId");

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RefreshToken now optionally links to the device that minted it. Old
-- rows stay NULL (no device known); new rows get a deviceId from the
-- chopnow_did cookie at issue time.
ALTER TABLE "refresh_tokens" ADD COLUMN "deviceId" TEXT;

CREATE INDEX "refresh_tokens_deviceId_idx" ON "refresh_tokens"("deviceId");

ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
