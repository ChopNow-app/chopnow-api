import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { RateOrderDto } from './dto/rate-order.dto';
import { CONSUMER_CAN_CANCEL, maskPhone } from './orders.constants';

/**
 * Umbrella service for order read paths + consumer write paths that
 * don't fit a more specific bucket. Sister services:
 *
 *   - `OrderCreationService`           — createOrder + helpers
 *   - `OrderVendorActionsService`      — accept / refuse / kitchen / preorder-cancel
 *   - `OrderPaymentLifecycleService`   — @OnEvent(PAYMENT_SUCCEEDED) handler
 *
 * What lives here:
 *   - Reads: getOrder, getOrderPublic, listConsumerOrders, listVendorOrders
 *   - Consumer write paths: cancelOrder, rateOrder
 *
 * The split was made after the file crossed ~1100 LOC; seams chosen so
 * each service owns a single coherent responsibility. The controller
 * injects all four services and dispatches per route.
 */
@Injectable()
export class OrdersService {
  constructor(
    @InjectPinoLogger(OrdersService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ── consumer read path ────────────────────────────────────────────

  async getOrder(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        vendor: { select: { id: true, userId: true, name: true } },
        // Surface the rating so the frontend can hide the rating form once
        // the consumer has rated (Story 3.9).
        rating: { select: { id: true, vendorScore: true, riderScore: true, comment: true } },
      },
    });
    if (!order) throw new NotFoundException('order_not_found');

    // Read auth: consumer owner, or vendor whose row matches.
    const isOwner = order.userId === userId;
    const isVendorSide = order.vendor.userId === userId;
    if (!isOwner && !isVendorSide) {
      // 404, not 403 — never confirm that an order id exists.
      throw new NotFoundException('order_not_found');
    }

    // Story 4.13 — scope codes by viewer role so neither party leaks the
    // other's secret. Consumer sees their delivery code; vendor sees their
    // pickup code. Rider gets neither via this endpoint (they read codes
    // off the physical people they meet).
    //
    // Story 3.17 — never expose deliveryPhone to the vendor. They use the
    // masked voice proxy (POST /orders/:id/vendor-call-consumer) to reach
    // the customer; the raw number would let them bypass the platform.
    return {
      ...order,
      pickupCode: isVendorSide ? order.pickupCode : undefined,
      deliveryCode: isOwner ? order.deliveryCode : undefined,
      deliveryPhone: isVendorSide ? maskPhone(order.deliveryPhone) : order.deliveryPhone,
    };
  }

  /**
   * Public-safe view of an order, intended for /t/<orderId> share links.
   * Returns ONLY non-PII fields: order code, status, vendor display name,
   * lifecycle timestamps. No customer/rider/payment info, no codes.
   *
   * Security model: UUID v4 is unguessable (122 bits of entropy), so the
   * link itself is the access token. Don't leak it in screenshots/CS tickets.
   */
  async getOrderPublic(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        code: true,
        status: true,
        placedAt: true,
        acceptedAt: true,
        preparedAt: true,
        pickedUpAt: true,
        deliveredAt: true,
        cancelledAt: true,
        vendor: { select: { name: true } },
      },
    });
    if (!order) throw new NotFoundException('order_not_found');
    return order;
  }

  async listConsumerOrders(userId: string, limit = 30) {
    const orders = await this.prisma.order.findMany({
      where: { userId },
      orderBy: { placedAt: 'desc' },
      take: limit,
      include: { items: true, vendor: { select: { id: true, name: true, badge: true } } },
    });
    // Story 4.13 — strip pickupCode (vendor's secret) before sending to the
    // consumer.
    return orders.map((o) => ({ ...o, pickupCode: undefined }));
  }

  // ── vendor read path ──────────────────────────────────────────────

  async listVendorOrders(
    userId: string,
    status?: OrderStatus,
    type: 'immediate' | 'preorder' = 'immediate',
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');

    // Pre-order / immediate split (#187). `type=immediate` keeps today's
    // behaviour — orders with scheduledFor=null. `type=preorder` returns
    // only orders with scheduledFor set, ordered by scheduledFor ASC so
    // the vendor sees the soonest pickup at the top.
    const scheduledFilter =
      type === 'preorder' ? { scheduledFor: { not: null } } : { scheduledFor: null };

    const orders = await this.prisma.order.findMany({
      where: {
        vendorId: vendor.id,
        // Payment-gated visibility (#178). An order that hasn't been paid
        // for must never reach the vendor's queue — otherwise they'd see
        // it briefly, the consumer would abandon the MoMo flow, the cron
        // would auto-refuse, and the vendor's "no-show rate" metric is
        // actually consumer cart abandonment.
        paymentStatus: PaymentStatus.PAID,
        ...scheduledFilter,
        ...(status ? { status } : {}),
      },
      orderBy: type === 'preorder' ? { scheduledFor: 'asc' } : { placedAt: 'desc' },
      take: 100,
      include: { items: true },
    });
    // Story 4.13 — strip deliveryCode (consumer's secret) before sending to
    // the vendor. Vendor only ever needs pickupCode.
    // Story 3.17 — also mask deliveryPhone; vendor uses the voice proxy.
    return orders.map((o) => ({
      ...o,
      deliveryCode: undefined,
      deliveryPhone: maskPhone(o.deliveryPhone),
    }));
  }

  // ── consumer cancellation ─────────────────────────────────────────

  async cancelOrder(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundException('order_not_found');

    // Pre-orders (#187): consumer cannot cancel a paid pre-order. The whole
    // point of a pre-order is the vendor commits prep ahead of time; allowing
    // free consumer cancel up to pickup would let consumers waste vendor
    // ingredients with impunity. Only the vendor can cancel a pre-order
    // (with a penalty if they've already accepted — see
    // OrderVendorActionsService.vendorCancelPreOrder).
    if (order.scheduledFor) {
      throw new ConflictException({
        code: 'pre_order_consumer_cannot_cancel',
        message: 'Une pré-commande ne peut pas être annulée par le client. Contactez le support.',
      });
    }

    if (!CONSUMER_CAN_CANCEL.has(order.status)) {
      throw new ConflictException({
        code: 'order_not_cancellable',
        message: 'The vendor has already accepted this order. Please contact support to cancel.',
      });
    }

    // Status-guarded conditional update (#174). The pre-check above gives a
    // clean error message for the common case where the consumer revisits a
    // stale URL. The race we close here is the sub-100ms window between
    // findUnique() and the write where the vendor's acceptOrder lands first:
    // both pre-checks pass, both writes succeed, last write wins, and either
    // the consumer thinks they cancelled an order that's being prepared or
    // the vendor thinks they accepted an order the consumer was told was
    // cancelled. updateMany matches zero rows and we 409 — same pattern as
    // PR #169 (the symmetric guard on acceptOrder / refuseOrder).
    const now = new Date();
    const res = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
      },
      data: { status: OrderStatus.CANCELLED, cancelledAt: now },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'order_state_changed',
        message: 'The vendor has already accepted this order. Please contact support to cancel.',
      });
    }

    this.events.emit(DomainEvents.ORDER_CANCELLED, {
      orderId: order.id,
      paymentStatus: order.paymentStatus,
      cancelledBy: 'consumer',
    });

    // MoMo refund is wired in Story 3.8 once the payments module handles
    // Campay refund calls — log the intent now so admin can replay if needed.
    if (order.paymentStatus === PaymentStatus.PAID) {
      this.logger.warn(
        {
          event: 'order_cancelled_while_paid',
          orderId: order.id,
          paymentMethod: order.paymentMethod,
        },
        'Order cancelled while PAID — refund needed (Story 3.8 pending wiring)',
      );
    }
    return this.prisma.order.findUnique({ where: { id: order.id } });
  }

  // ── consumer rating ───────────────────────────────────────────────

  /**
   * Story 3.9 — consumer rates the order post-delivery.
   *
   * Constraints:
   *   - Only the consumer who placed the order can rate it (ownership).
   *   - Only DELIVERED orders are rateable.
   *   - 24h window from deliveredAt (after that → 410 expired).
   *   - One rating per order (unique on orderId — second submission rejects).
   */
  async rateOrder(orderId: string, userId: string, dto: RateOrderDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        vendorId: true,
        status: true,
        deliveredAt: true,
        rating: { select: { id: true } },
      },
    });
    if (!order || order.userId !== userId) throw new NotFoundException('order_not_found');

    if (order.status !== OrderStatus.DELIVERED || !order.deliveredAt) {
      throw new ConflictException({
        code: 'order_not_rateable',
        message: 'You can only rate orders that have been delivered.',
      });
    }
    if (order.rating) {
      throw new ConflictException({
        code: 'order_already_rated',
        message: 'This order already has a rating.',
      });
    }
    const ageMs = Date.now() - order.deliveredAt.getTime();
    if (ageMs > 24 * 3600 * 1000) {
      throw new ConflictException({
        code: 'rating_window_expired',
        message: 'The 24-hour rating window has closed.',
      });
    }

    const rating = await this.prisma.orderRating.create({
      data: {
        orderId: order.id,
        userId,
        vendorId: order.vendorId,
        vendorScore: dto.vendorScore,
        riderScore: dto.riderScore,
        comment: dto.comment ?? null,
      },
    });

    // Story 3.9 — admin alert on low scores. Notification fan-out happens
    // via the existing domain-event bus; consumer comes online with
    // Story 6.x admin panel.
    if (dto.vendorScore <= 2 || dto.riderScore <= 2) {
      this.logger.warn(
        {
          event: 'order_low_rating',
          orderId: order.id,
          vendorScore: dto.vendorScore,
          riderScore: dto.riderScore,
        },
        'Low rating posted — admin should review',
      );
    }
    return rating;
  }
}

// Re-export constants that other modules import from this file's previous
// location so we don't break their import paths in this refactor.
export {
  ACCEPTANCE_TTL_SECONDS,
  PRE_ORDER_MIN_LEAD_HOURS,
  PRE_ORDER_MAX_LEAD_HOURS,
  PRE_ORDER_NOTIFICATION_LEAD_MINUTES,
  PRE_ORDER_PENALTY_RATE,
  PRE_ORDER_PENALTY_ROUND_TO_XAF,
} from './orders.constants';
