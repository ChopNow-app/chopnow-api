-- Story 1.1 follow-up: persist Twilio message SID + intermediate SENT status
-- so the status webhook (POST /api/twilio/status) can reconcile real delivery
-- state instead of optimistically marking DELIVERED on `messages.create()`.

ALTER TYPE "OtpStatus" ADD VALUE 'SENT' BEFORE 'DELIVERED';

ALTER TABLE "otp_logs" ADD COLUMN "providerMessageId" TEXT;
ALTER TABLE "otp_logs" ADD CONSTRAINT "otp_logs_providerMessageId_key" UNIQUE ("providerMessageId");
