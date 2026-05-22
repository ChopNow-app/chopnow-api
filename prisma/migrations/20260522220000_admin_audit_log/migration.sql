-- Phase A2 — admin audit log. Append-only record of every admin write
-- request: who did what, when, to which target, and with what outcome.

CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "payload" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_adminId_createdAt_idx"
  ON "admin_audit_logs"("adminId", "createdAt");

CREATE INDEX "admin_audit_logs_targetType_targetId_idx"
  ON "admin_audit_logs"("targetType", "targetId");

CREATE INDEX "admin_audit_logs_action_createdAt_idx"
  ON "admin_audit_logs"("action", "createdAt");

ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
