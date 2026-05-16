-- Vendor acceptance SLA — see schema.prisma Order.acceptanceDeadlineAt.
ALTER TABLE "orders" ADD COLUMN "acceptanceDeadlineAt" TIMESTAMP(3);

-- Partial index lets the OrdersExpiryService cron scan only rows that can
-- still expire (PENDING or CONFIRMED + deadline set + not yet past triage).
-- Drastically reduces scan cost once the table grows.
CREATE INDEX "orders_pending_deadline_idx"
  ON "orders" ("acceptanceDeadlineAt")
  WHERE status IN ('PENDING', 'CONFIRMED') AND "acceptanceDeadlineAt" IS NOT NULL;
