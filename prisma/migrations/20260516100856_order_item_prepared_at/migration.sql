-- Vendor preparation checklist — see schema.prisma OrderItem.preparedAt.
ALTER TABLE "order_items" ADD COLUMN "preparedAt" TIMESTAMP(3);
