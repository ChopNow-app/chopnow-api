import { Injectable } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { LedgerAccount, LedgerEventType, OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { RIDER_DELIVERY_SHARE } from '../finance/commission.constants';
import { LedgerService } from '../finance/ledger.service';
import { OrderLifecycleScheduler } from './order-lifecycle.scheduler';
import { ACCEPTANCE_TTL_SECONDS, PRE_ORDER_NOTIFICATION_LEAD_MINUTES } from './orders.constants';

/**
 * Subscribes to PAYMENT_SUCCEEDED and drives the post-payment lifecycle:
 *
 *   - Flip Order.status: PENDING → CONFIRMED, paymentStatus → PAID
 *   - Snapshot commission, rider share, platform fee from the rate
 *     captured at order creation (never re-read — that would erase audit
 *     history per ADR-0005)
 *   - Write the paired CAMPAY_FLOAT / CUSTOMER_ESCROW ledger entries
 *   - Immediate flow: emit ORDER_CREATED + schedule the 60s expiry job
 *   - Pre-order flow: schedule the delayed promotion at
 *     `scheduledFor - lead window`
 *
 * The status-guarded `updateMany` closes the Campay double-webhook race
 * (#172): the first webhook's call matches and writes the ledger; the
 * second matches zero rows and the transaction rolls back without
 * commit.
 *
 * Used to live on OrdersService — moved here to keep the lifecycle event
 * graph in one place and slim the umbrella service.
 */
@Injectable()
export class OrderPaymentLifecycleService {
  constructor(
    @InjectPinoLogger(OrderPaymentLifecycleService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly ledger: LedgerService,
    private readonly lifecycleScheduler: OrderLifecycleScheduler,
  ) {}

  @OnEvent(DomainEvents.PAYMENT_SUCCEEDED)
  async onPaymentSucceeded(payload: {
    orderId: string;
    providerReference: string;
    payerPhone?: string;
  }) {
    const order = await this.prisma.order.findUnique({ where: { id: payload.orderId } });
    if (!order || order.paymentStatus === PaymentStatus.PAID) return; // idempotent fast-path

    const now = new Date();
    // Pre-order (#187) vs immediate flow split: a pre-order's vendor
    // notification + 60s countdown shouldn't fire on payment — they fire
    // at scheduledFor - PRE_ORDER_NOTIFICATION_LEAD via PreOrderPromotionService.
    // Immediate orders keep the existing behaviour: deadline + ORDER_CREATED
    // both land here.
    const isPreOrder = Boolean(order.scheduledFor);
    // Compute money snapshots from the rate captured at order creation
    // (never re-read from the vendor — that would erase audit history).
    const commissionRate = Number(order.commissionRate);
    const commissionXAF = Math.round(order.subtotalXAF * commissionRate);
    const riderShareXAF = Math.round(order.deliveryFeeXAF * RIDER_DELIVERY_SHARE);
    const deliveryMarginXAF = order.deliveryFeeXAF - riderShareXAF;
    const platformFeeXAF = commissionXAF + deliveryMarginXAF;
    const dataPatch: Prisma.OrderUncheckedUpdateManyInput = {
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      paymentReference: payload.providerReference,
      payerPhone: payload.payerPhone ?? order.payerPhone,
      paidAt: now,
      commissionXAF,
      riderShareXAF,
      platformFeeXAF,
    };
    if (!isPreOrder) {
      // Set the acceptance deadline NOW (not at order creation). Issue #179:
      // the 60s vendor countdown should match "when the vendor can actually
      // act on it," not "when the consumer hit submit." Otherwise a slow
      // MoMo confirm eats the vendor's response window.
      dataPatch.acceptanceDeadlineAt = new Date(now.getTime() + ACCEPTANCE_TTL_SECONDS * 1000);
    }
    // Status-guarded conditional update + paired ledger entries, atomic.
    // Closes the Campay double-webhook race (#172) — the first webhook's
    // updateMany matches and writes ledger; the second matches zero rows
    // and the ledger write is skipped entirely (no transaction commits).
    // Per ADR-0005, PAYMENT_RECEIVED moves money from Campay's float into
    // the customer escrow we hold until delivery:
    //   CAMPAY_FLOAT    : +totalXAF   (debit — money landed)
    //   CUSTOMER_ESCROW : -totalXAF   (credit — we owe it back until delivered)
    const won = await this.prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: {
          id: order.id,
          paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        },
        data: dataPatch,
      });
      if (res.count === 0) return false;
      await this.ledger.recordTransaction(
        {
          eventId: `payment:${order.id}`,
          eventType: LedgerEventType.PAYMENT_RECEIVED,
          entries: [
            {
              account: LedgerAccount.CAMPAY_FLOAT,
              amountXAF: order.totalXAF,
              orderId: order.id,
              description: `Campay payment for order ${order.code ?? order.id}`,
            },
            {
              account: LedgerAccount.CUSTOMER_ESCROW,
              amountXAF: -order.totalXAF,
              orderId: order.id,
              description: 'Customer escrow held until delivery',
            },
          ],
        },
        tx,
      );
      return true;
    });
    if (!won) return; // lost the race — another concurrent webhook already won

    // ORDER_PAID stays for payment-pipeline observability (no listeners
    // today, but semantically meaningful for audit). Fires for both flows.
    this.events.emit(DomainEvents.ORDER_PAID, { orderId: order.id, paidAt: now });

    if (isPreOrder) {
      // Pre-order: vendor isn't notified until the scheduledFor - lead
      // window. Fast path = delayed BullMQ job firing exactly at that
      // moment; PreOrderPromotionService at every-minute cadence stays as
      // the safety net in case Redis dropped the job.
      if (order.scheduledFor) {
        const promoteAt = new Date(
          order.scheduledFor.getTime() - PRE_ORDER_NOTIFICATION_LEAD_MINUTES * 60_000,
        );
        await this.lifecycleScheduler.schedulePreOrderPromotion(order.id, promoteAt);
      }
      this.logger.info(
        {
          event: 'pre_order_paid_awaiting_promotion',
          orderId: order.id,
          scheduledFor: order.scheduledFor,
        },
        'Pre-order paid — promotion deferred until scheduledFor - lead window',
      );
      return;
    }

    // Immediate flow: ORDER_CREATED triggers vendor notification (push + WhatsApp
    // fallback via OrderNotificationsService.onOrderCreated). Moved here
    // from createOrder per issue #178 — the vendor must not see an unpaid
    // order in their queue, and the push/WhatsApp must not fire before
    // payment is confirmed.
    this.events.emit(DomainEvents.ORDER_CREATED, {
      orderId: order.id,
      code: order.code,
      vendorId: order.vendorId,
      userId: order.userId,
      paymentMethod: order.paymentMethod,
    });

    // Schedule the 60s auto-refuse on the delayed-job fast path. The 10s
    // cron (OrdersExpiryService) stays as a safety net in case Redis lost
    // the job — but the user-visible deadline now fires on the precise
    // tick rather than up to 10s late.
    if (dataPatch.acceptanceDeadlineAt) {
      await this.lifecycleScheduler.scheduleAcceptanceExpiry(
        order.id,
        dataPatch.acceptanceDeadlineAt as Date,
      );
    }
  }
}
