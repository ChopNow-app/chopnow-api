import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FinanceModule } from '../finance/finance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersExpiryService } from './orders-expiry.service';
import { StuckPickupDetectorService } from './stuck-pickup-detector.service';
import { OrderNotificationsService } from './order-notifications.service';
import { OrderNotificationsProcessor } from './order-notifications.processor';
import { ORDER_NOTIFICATIONS_QUEUE } from './order-notifications.constants';
import { OrderLifecycleScheduler } from './order-lifecycle.scheduler';
import { OrderLifecycleProcessor } from './order-lifecycle.processor';
import { ORDER_LIFECYCLE_QUEUE } from './order-lifecycle.constants';
import { PreOrderPromotionService } from './pre-order-promotion.service';

/**
 * Epic 3 — Commande & Paiement.
 *
 * Story 3.1  ✅ — cart + order creation, server-side fee math + minimum
 *                 order, X-Idempotency-Key (3.14).
 * Story 3.7  ✅ — vendor accept / refuse with reason.
 * Story 3.8  ✅ — consumer cancel before vendor acceptance.
 * Story 3.3 / 3.4 — Campay MoMo init + webhook (next PR).
 * Story 3.6 — order tracking (event already wired; client polls /orders/:id).
 *
 * OrdersService listens for payment.succeeded and flips PENDING → CONFIRMED
 * (PaymentStatus.PAID) — single side-effect path from the payments module.
 */
@Module({
  imports: [
    NotificationsModule,
    FinanceModule,
    BullModule.registerQueue({ name: ORDER_NOTIFICATIONS_QUEUE }),
    BullModule.registerQueue({ name: ORDER_LIFECYCLE_QUEUE }),
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrdersExpiryService,
    OrderNotificationsService,
    OrderNotificationsProcessor,
    OrderLifecycleScheduler,
    OrderLifecycleProcessor,
    PreOrderPromotionService,
    StuckPickupDetectorService,
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
