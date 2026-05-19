import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  LedgerAccount,
  LedgerEventType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  VendorStatus,
} from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeDeliveryFeeXAF } from '../../shared/pricing/delivery-fee.util';
import { DomainEvents } from '../../shared/events/domain-events';
import { RIDER_DELIVERY_SHARE } from '../finance/commission.constants';
import { LedgerService } from '../finance/ledger.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { RateOrderDto } from './dto/rate-order.dto';
import { RefuseOrderDto } from './dto/vendor-decision.dto';

// Story 3.1 — minimum order to protect margin (≤ 1200 FCFA generates ~26 FCFA
// net, near loss). Hard-coded for MVP; surface as an admin config later.
const MIN_ORDER_XAF = 1200;

// Vendor acceptance SLA — Order.acceptanceDeadlineAt is set to placedAt +
// this many seconds at order creation. The UI counts down to that absolute
// deadline (not from-now), so the vendor sees the same remaining time even
// after a tab reload. 60s is humane vs the prototype's 40s while still
// keeping consumer wait short. The OrdersExpiryService auto-refuses past
// this with reason EXPIRED_NO_VENDOR_RESPONSE.
export const ACCEPTANCE_TTL_SECONDS = 60;

// Pre-orders (#187 — INFORMAL vendors only).
// Minimum lead time between order placement and scheduledFor. Set conservatively
// to the same value as the default cancellation cutoff — a pre-order placed
// inside that window wouldn't give the vendor enough room to prep.
export const PRE_ORDER_MIN_LEAD_HOURS = 4;
// Maximum lead time: 24h ahead of `now` (v1.1 day-ahead). The frontend day
// toggle exposes "Aujourd'hui / Demain" within this window. Multi-day (T+N)
// is v2 — bumping this to e.g. 7 * 24 would technically work but the UX
// changes substantially.
export const PRE_ORDER_MAX_LEAD_HOURS = 24;
// How early before scheduledFor the promotion cron flips the order to "vendor
// must decide" — sets acceptanceDeadlineAt and emits ORDER_CREATED.
export const PRE_ORDER_NOTIFICATION_LEAD_MINUTES = 60;
// Vendor penalty for cancel-after-accept: 10% of totalXAF rounded down to the
// nearest 50 FCFA (currency tick on the Cameroon market).
export const PRE_ORDER_PENALTY_RATE = 0.1;
export const PRE_ORDER_PENALTY_ROUND_TO_XAF = 50;

// Status sets — keep transition gates explicit so a bug in one branch can't
// silently teleport an order past the wrong gate.
const VENDOR_CAN_DECIDE: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING, // cash flow lands here before vendor decision
  OrderStatus.CONFIRMED, // MoMo flow after webhook
]);
const CONSUMER_CAN_CANCEL: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
]);

interface DistanceRow {
  distance_m: number;
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectPinoLogger(OrdersService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly ledger: LedgerService,
  ) {}

  // ── consumer write path ────────────────────────────────────────────

  async createOrder(userId: string, dto: CreateOrderDto, idempotencyKey?: string) {
    // Idempotency short-circuit — same client retry → same order back.
    if (idempotencyKey) {
      const existing = await this.prisma.order.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        include: { items: true },
      });
      if (existing) return existing;
    }

    // 1) Vendor must exist + be ACTIVE + isOpen — closed/pending vendors
    // aren't legal targets.
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: dto.vendorId },
      select: {
        id: true,
        status: true,
        isOpen: true,
        acceptsPreOrders: true,
        type: true,
        commissionRate: true,
      },
    });
    if (!vendor || vendor.status !== VendorStatus.ACTIVE) {
      throw new NotFoundException({
        code: 'vendor_not_found',
        message: 'Vendor unavailable or not yet approved.',
      });
    }
    if (!vendor.isOpen) {
      throw new ConflictException({
        code: 'vendor_closed',
        message: 'This vendor just went offline. Please pick another vendor.',
      });
    }

    // 2) Load + verify items. All cart lines must belong to this vendor,
    // be available, in stock, and resolved server-side (no client-supplied
    // prices — those come from the DB).
    const itemIds = dto.items.map((l) => l.itemId);
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, vendorId: vendor.id },
      select: { id: true, name: true, priceXAF: true, isAvailable: true, isInStock: true },
    });
    if (items.length !== itemIds.length) {
      throw new BadRequestException({
        code: 'item_not_in_vendor_menu',
        message: "One or more items don't belong to this vendor or were just removed.",
      });
    }
    const unavailable = items.find((i) => !i.isAvailable || !i.isInStock);
    if (unavailable) {
      throw new ConflictException({
        code: 'item_out_of_stock',
        message: `"${unavailable.name}" is currently out of stock.`,
      });
    }

    // 3) Subtotal from DB prices.
    const itemMap = new Map(items.map((i) => [i.id, i]));
    const lines = dto.items.map((cartLine) => {
      const item = itemMap.get(cartLine.itemId)!;
      const lineXAF = item.priceXAF * cartLine.quantity;
      return {
        itemId: item.id,
        nameSnapshot: item.name,
        priceXAFSnapshot: item.priceXAF,
        quantity: cartLine.quantity,
        lineXAF,
      };
    });
    const subtotalXAF = lines.reduce((sum, l) => sum + l.lineXAF, 0);

    // 4) Delivery fee from PostGIS distance.
    const distanceKm = await this.computeDistanceKm(vendor.id, dto.deliveryLat, dto.deliveryLng);
    const deliveryFeeXAF = computeDeliveryFeeXAF(distanceKm);
    const totalXAF = subtotalXAF + deliveryFeeXAF;

    if (totalXAF < MIN_ORDER_XAF) {
      throw new BadRequestException({
        code: 'order_below_minimum',
        message: `Commande minimum ${MIN_ORDER_XAF} FCFA — ajoutez un plat pour continuer.`,
      });
    }

    // 4.5) Pre-order validation (#187 — INFORMAL vendors only).
    // scheduledFor stays null when the consumer wants immediate delivery
    // (today's flow, identical behaviour). When set, the vendor must accept
    // pre-orders and the time must fall within [now + MIN_LEAD, now + MAX_LEAD].
    if (dto.scheduledFor) {
      if (!vendor.acceptsPreOrders) {
        throw new BadRequestException({
          code: 'pre_orders_not_accepted_by_this_vendor',
          message: "Ce vendeur n'accepte pas les commandes à l'avance.",
        });
      }
      const scheduledMs = dto.scheduledFor.getTime();
      const nowMs = Date.now();
      const minLeadMs = nowMs + PRE_ORDER_MIN_LEAD_HOURS * 3600_000;
      const maxLeadMs = nowMs + PRE_ORDER_MAX_LEAD_HOURS * 3600_000;
      if (scheduledMs < minLeadMs) {
        throw new BadRequestException({
          code: 'pre_order_too_soon',
          message: `Une pré-commande doit être planifiée au moins ${PRE_ORDER_MIN_LEAD_HOURS}h à l'avance.`,
        });
      }
      if (scheduledMs > maxLeadMs) {
        throw new BadRequestException({
          code: 'pre_order_too_far_in_future',
          message: `Une pré-commande ne peut être planifiée plus de ${PRE_ORDER_MAX_LEAD_HOURS}h à l'avance.`,
        });
      }
    }

    // 5) Initial status: every order starts PENDING + paymentStatus=PENDING.
    // The vendor is NOT notified at this point — the order is invisible to
    // them until the Campay webhook flips paymentStatus to PAID, at which
    // point onPaymentSucceeded fires ORDER_CREATED and sets the 60s
    // acceptance deadline. This is the payment-gated visibility model from
    // issues #178 / #179 — without it, a consumer who walks away mid-MoMo
    // would burn a vendor's acceptance countdown for an unpaid order.
    const code = this.generateOrderCode();
    const pickupCode = this.generate4DigitCode();
    const deliveryCode = this.generate4DigitCode();
    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          code,
          userId,
          vendorId: vendor.id,
          status: OrderStatus.PENDING,
          subtotalXAF,
          deliveryFeeXAF,
          totalXAF,
          // Snapshot the vendor's effective commission rate AT THIS MOMENT.
          // Future tier flips or admin overrides do not retroactively change
          // what this order earned (ADR-0005).
          commissionRate: vendor.commissionRate,
          noteForVendor: dto.noteForVendor ?? null,
          paymentMethod: dto.paymentMethod,
          paymentStatus: PaymentStatus.PENDING,
          deliveryLat: dto.deliveryLat,
          deliveryLng: dto.deliveryLng,
          deliveryQuartier: dto.deliveryQuartier,
          deliveryLandmark: dto.deliveryLandmark ?? null,
          deliveryDescription: dto.deliveryDescription ?? null,
          deliveryPhone: dto.deliveryPhone,
          pickupCode,
          deliveryCode,
          // acceptanceDeadlineAt deliberately left null — it's set by
          // onPaymentSucceeded (immediate) or PreOrderPromotionService
          // (pre-orders) so the countdown matches "when the vendor can act
          // on it," not "when the consumer hit submit."
          scheduledFor: dto.scheduledFor ?? null,
          idempotencyKey: idempotencyKey ?? null,
          items: { createMany: { data: lines } },
        },
        include: { items: true },
      });

      this.logger.info(
        {
          event: 'order_commission_snapshotted',
          orderId: created.id,
          vendorId: vendor.id,
          vendorType: vendor.type,
          commissionRate: Number(vendor.commissionRate),
        },
        'order commission rate snapshotted at creation',
      );

      return created;
    });

    // Telemetry only (#173): catch the rare race where the vendor flipped
    // an item to isAvailable=false (or isInStock=false) AFTER our findMany
    // saw it as available but BEFORE order.create committed. At pilot
    // volume this should fire ~never; if it does, we want to know without
    // having paid the perf cost of SERIALIZABLE isolation on every order.
    // Awaited (not fire-and-forget) so the log is guaranteed to land
    // before the response goes out — the extra ~5ms is negligible.
    await this.checkPostCreateItemAvailability(order.id, itemIds);

    return order;
  }

  /**
   * Issue #173 telemetry: log a structured warning when a freshly-created
   * order references items whose `isAvailable` / `isInStock` flag flipped
   * to false during the create window. Indicators that the rare
   * vendor-toggles-during-submit race actually fired in production.
   *
   * Defensive narrowing: only items updated within the last 10 seconds
   * count — older "always was off" rows would imply a different bug
   * (item.findMany filter failed) and we report those separately.
   */
  private async checkPostCreateItemAvailability(orderId: string, itemIds: string[]): Promise<void> {
    try {
      const rechecked = await this.prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, name: true, isAvailable: true, isInStock: true, updatedAt: true },
      });
      const flippedRecently = rechecked.filter(
        (i) =>
          (!i.isAvailable || !i.isInStock) &&
          i.updatedAt instanceof Date &&
          Date.now() - i.updatedAt.getTime() < 10_000,
      );
      if (flippedRecently.length === 0) return;
      this.logger.warn(
        {
          event: 'order_item_flip_race',
          orderId,
          flippedCount: flippedRecently.length,
          flippedItems: flippedRecently.map((i) => ({
            id: i.id,
            name: i.name,
            isAvailable: i.isAvailable,
            isInStock: i.isInStock,
          })),
        },
        'Order created during item-availability flip race — vendor may refuse on accept screen',
      );
    } catch (err) {
      // Telemetry must never break the order pipeline. Order is already
      // committed; if the recheck query fails, log and move on.
      this.logger.warn(
        { event: 'order_item_recheck_failed', orderId, error: (err as Error).message },
        'Item availability recheck failed',
      );
    }
  }

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
    return {
      ...order,
      pickupCode: isVendorSide ? order.pickupCode : undefined,
      deliveryCode: isOwner ? order.deliveryCode : undefined,
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

  // ── consumer cancellation ─────────────────────────────────────────

  async cancelOrder(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundException('order_not_found');

    // Pre-orders (#187): consumer cannot cancel a paid pre-order. The whole
    // point of a pre-order is the vendor commits prep ahead of time; allowing
    // free consumer cancel up to pickup would let consumers waste vendor
    // ingredients with impunity. Only the vendor can cancel a pre-order
    // (with a penalty if they've already accepted — see vendorCancelPreOrder).
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

  // ── vendor decision path ──────────────────────────────────────────

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
    return orders.map((o) => ({ ...o, deliveryCode: undefined }));
  }

  async acceptOrder(orderId: string, userId: string) {
    const order = await this.requireVendorOrder(orderId, userId);
    if (!VENDOR_CAN_DECIDE.has(order.status)) {
      // Cheap "you already decided" error message for the common case where
      // the vendor double-taps or revisits a stale URL. The conditional
      // updateMany below catches the rare sub-100ms race against the
      // auto-refuse cron.
      throw new ConflictException({
        code: 'order_not_pending',
        message: 'This order is no longer awaiting your decision.',
      });
    }
    const now = new Date();
    // Status-guarded update mirrors OrdersExpiryService.sweepExpired so the
    // vendor's Accept cannot silently overwrite a cron-driven REFUSED.
    // count===0 means the order changed state between requireVendorOrder()
    // and this update — almost always: the cron got there first.
    const res = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
      },
      data: { status: OrderStatus.ACCEPTED, acceptedAt: now },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'order_state_changed',
        message:
          "Cette commande vient d'être refusée automatiquement (délai dépassé). Reviens au dashboard.",
      });
    }
    this.events.emit(DomainEvents.ORDER_ACCEPTED, {
      orderId: order.id,
      vendorId: order.vendorId,
      acceptedAt: now,
    });
    return this.prisma.order.findUnique({ where: { id: order.id } });
  }

  async refuseOrder(orderId: string, userId: string, dto: RefuseOrderDto) {
    const order = await this.requireVendorOrder(orderId, userId);
    if (!VENDOR_CAN_DECIDE.has(order.status)) {
      throw new ConflictException({
        code: 'order_not_pending',
        message: 'This order is no longer awaiting your decision.',
      });
    }
    const reasonLabel = dto.note ? `${dto.reason}: ${dto.note}` : dto.reason;
    const now = new Date();
    // Same status guard as acceptOrder — if the cron beat us to REFUSED, we
    // don't want to emit a second ORDER_REFUSED (would re-send the consumer
    // WhatsApp) or overwrite the auto-refuse reason with the vendor's pick.
    const res = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
      },
      data: { status: OrderStatus.REFUSED, refusedAt: now, refusalReason: reasonLabel },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'order_state_changed',
        message: "Cette commande a déjà changé d'état. Reviens au dashboard.",
      });
    }
    this.events.emit(DomainEvents.ORDER_REFUSED, {
      orderId: order.id,
      vendorId: order.vendorId,
      reason: dto.reason,
      refusedAt: now,
    });
    // Refund wiring: same TODO as cancelOrder.
    if (order.paymentStatus === PaymentStatus.PAID) {
      this.logger.warn(
        {
          event: 'order_refused_while_paid',
          orderId: order.id,
          paymentMethod: order.paymentMethod,
        },
        'Order refused by vendor while PAID — refund needed',
      );
    }
    return this.prisma.order.findUnique({ where: { id: order.id } });
  }

  // ── vendor preparation path ───────────────────────────────────────

  /**
   * Toggle a single OrderItem's prepared flag (the vendor's checkbox on the
   * /vendor/preparation screen).
   *
   * Side-effect on order status:
   *   - If status is ACCEPTED and we just prepared the FIRST item → flip to IN_PREP
   *   - If status is IN_PREP and we just unprepared the LAST prepared item → flip back to ACCEPTED
   * Status flips happen inside the same transaction as the OrderItem update so
   * a partial failure can't leave the order in an inconsistent state.
   *
   * Refuses outside ACCEPTED / IN_PREP — once the vendor has marked the order
   * READY_PICKUP, the kitchen-side checklist is closed.
   */
  async setItemPrepared(
    orderId: string,
    itemId: string,
    userId: string,
    prepared: boolean,
  ): Promise<{ orderId: string; itemId: string; preparedAt: Date | null; status: OrderStatus }> {
    const order = await this.requireVendorOrder(orderId, userId);
    if (order.status !== OrderStatus.ACCEPTED && order.status !== OrderStatus.IN_PREP) {
      throw new ConflictException({
        code: 'order_not_in_prep_phase',
        message: 'This order is no longer in the preparation phase.',
      });
    }

    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId } });
    if (!item || item.orderId !== orderId) {
      throw new NotFoundException('order_item_not_found');
    }

    const newPreparedAt = prepared ? new Date() : null;

    return this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: itemId },
        data: { preparedAt: newPreparedAt },
      });

      // Recompute aggregate state from the items so the status flip is based
      // on the post-update truth, not the optimistic local view.
      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: { preparedAt: true },
      });
      const anyPrepared = items.some((i) => i.preparedAt !== null);
      const nextStatus =
        anyPrepared && order.status === OrderStatus.ACCEPTED
          ? OrderStatus.IN_PREP
          : !anyPrepared && order.status === OrderStatus.IN_PREP
            ? OrderStatus.ACCEPTED
            : order.status;

      if (nextStatus !== order.status) {
        await tx.order.update({ where: { id: orderId }, data: { status: nextStatus } });
      }

      return { orderId, itemId, preparedAt: newPreparedAt, status: nextStatus };
    });
  }

  /**
   * Mark the whole order ready for pickup. Requires every OrderItem to have
   * preparedAt set (the "all checkboxes ticked" precondition of the CTA).
   * Flips status to READY_PICKUP, stamps Order.preparedAt, and emits
   * ORDER_READY so any downstream notifier (rider PWA, consumer WhatsApp)
   * can fan out.
   */
  async markOrderReady(
    orderId: string,
    userId: string,
  ): Promise<{ status: OrderStatus; preparedAt: Date }> {
    const order = await this.requireVendorOrder(orderId, userId);
    if (order.status !== OrderStatus.ACCEPTED && order.status !== OrderStatus.IN_PREP) {
      throw new ConflictException({
        code: 'order_not_in_prep_phase',
        message: 'This order is no longer in the preparation phase.',
      });
    }

    const items = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { preparedAt: true },
    });
    if (items.length === 0 || items.some((i) => i.preparedAt === null)) {
      throw new ConflictException({
        code: 'items_not_all_prepared',
        message: 'All articles must be marked prepared before marking the order ready.',
      });
    }

    const now = new Date();
    // Status-guarded update: a vendor who manages to refuse-then-mark-ready
    // (or whose order somehow went past READY_PICKUP via another path)
    // shouldn't be able to overwrite the order state. count===0 → 409.
    const res = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: { in: [OrderStatus.ACCEPTED, OrderStatus.IN_PREP] },
      },
      data: { status: OrderStatus.READY_PICKUP, preparedAt: now },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'order_state_changed',
        message: "Cette commande a changé d'état pendant la préparation. Reviens au dashboard.",
      });
    }

    this.events.emit(DomainEvents.ORDER_READY, {
      orderId,
      vendorId: order.vendorId,
      preparedAt: now,
    });

    return { status: OrderStatus.READY_PICKUP, preparedAt: now };
  }

  // ── pre-order vendor cancel (post-acceptance) ─────────────────────

  /**
   * #187 — vendor cancels a pre-order they previously accepted. This is the
   * costly path: vendor commits at acceptance time, breaking the commitment
   * later (kitchen disaster, ran out of an ingredient, etc.) means refunding
   * the consumer AND incurring a penalty.
   *
   * Pre-acceptance refusal (refuseOrder, or the auto-refuse cron) is free —
   * a vendor who hasn't said yes yet hasn't committed. Hence why this method
   * gates on `status ∈ {ACCEPTED, IN_PREP}` and not on PENDING/CONFIRMED.
   *
   * Effects in one transaction:
   *   1. Order.status → CANCELLED, cancelledAt = now
   *   2. paymentStatus → REFUND_PENDING (Story 3.8 sweeps to REFUNDED via Campay)
   *   3. VendorPenalty row created, amount = 10% of totalXAF (rounded down to 50)
   *
   * Emits ORDER_CANCELLED with `cancelledBy='vendor_preorder'` so downstream
   * notifications can humanize the message ("le vendeur a dû annuler ta
   * pré-commande, un remboursement est en cours").
   */
  async vendorCancelPreOrder(
    orderId: string,
    userId: string,
    note?: string,
  ): Promise<{ status: OrderStatus; penaltyXAF: number }> {
    const order = await this.requireVendorOrder(orderId, userId);
    if (!order.scheduledFor) {
      throw new ConflictException({
        code: 'not_a_pre_order',
        message: 'This method is only valid for pre-orders.',
      });
    }
    if (order.status !== OrderStatus.ACCEPTED && order.status !== OrderStatus.IN_PREP) {
      throw new ConflictException({
        code: 'pre_order_not_in_cancellable_state',
        message: 'A pre-order can only be vendor-cancelled after acceptance and before pickup.',
      });
    }

    const now = new Date();
    const penaltyXAF =
      Math.floor((order.totalXAF * PRE_ORDER_PENALTY_RATE) / PRE_ORDER_PENALTY_ROUND_TO_XAF) *
      PRE_ORDER_PENALTY_ROUND_TO_XAF;

    // All four writes atomic: order flip + payment flip + penalty row +
    // paired ledger entries. Status-guarded updateMany on the order flip so
    // a concurrent rider-side status change (pickup scan landing at the
    // same instant) can't be overwritten. count===0 → race lost, no penalty
    // written, throw 409. If the ledger write fails the entire transaction
    // rolls back — the VendorPenalty row and the ledger entries are kept
    // in lock-step (ADR-0005).
    const ledgerEventId = await this.prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: {
          id: order.id,
          status: { in: [OrderStatus.ACCEPTED, OrderStatus.IN_PREP] },
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: now,
          refusalReason: note ? `VENDOR_PREORDER_CANCEL: ${note}` : 'VENDOR_PREORDER_CANCEL',
          paymentStatus: PaymentStatus.REFUND_PENDING,
        },
      });
      if (res.count === 0) {
        throw new ConflictException({
          code: 'order_state_changed',
          message: "Cette commande a changé d'état pendant l'annulation. Reviens au dashboard.",
        });
      }
      const penalty = await tx.vendorPenalty.create({
        data: {
          vendorId: order.vendorId,
          orderId: order.id,
          reason: 'PRE_ORDER_VENDOR_CANCEL_AFTER_ACCEPT',
          amountXAF: penaltyXAF,
        },
      });
      // ADR-0005 ledger bridge. Sign convention (positive = debit):
      //  - VENDOR_PAYABLE +penalty   → debit (reduces what we owe them)
      //  - PLATFORM_REVENUE −penalty → credit (recognises the penalty as income)
      // Sum = 0. The penalty.id is the ledger eventId so the two systems
      // stay traceable. Future refund leg (Story 3.8) will write its own
      // event with a different eventId.
      await this.ledger.recordTransaction(
        {
          eventId: penalty.id,
          eventType: LedgerEventType.PENALTY_APPLIED,
          entries: [
            {
              account: LedgerAccount.VENDOR_PAYABLE,
              amountXAF: penaltyXAF,
              vendorId: order.vendorId,
              orderId: order.id,
              description: `Pre-order cancellation penalty (10% of ${order.totalXAF} FCFA, rounded down to 50)`,
            },
            {
              account: LedgerAccount.PLATFORM_REVENUE,
              amountXAF: -penaltyXAF,
              vendorId: order.vendorId,
              orderId: order.id,
              description: 'Pre-order cancellation penalty — platform revenue',
            },
          ],
        },
        tx,
      );
      return penalty.id;
    });

    this.events.emit(DomainEvents.ORDER_CANCELLED, {
      orderId: order.id,
      paymentStatus: PaymentStatus.REFUND_PENDING,
      cancelledBy: 'vendor_preorder',
    });

    this.logger.warn(
      {
        event: 'pre_order_vendor_cancelled_after_accept',
        orderId: order.id,
        vendorId: order.vendorId,
        userId: order.userId,
        totalXAF: order.totalXAF,
        penaltyXAF,
        scheduledFor: order.scheduledFor,
        ledgerEventId,
      },
      'Vendor cancelled pre-order after acceptance — refund pending + penalty recorded',
    );
    this.logger.warn(
      {
        event: 'pre_order_refund_required',
        orderId: order.id,
        amountXAF: order.totalXAF,
        paymentMethod: order.paymentMethod,
      },
      'Pre-order vendor-cancel — Campay refund needed (Story 3.8 pending wiring)',
    );

    return { status: OrderStatus.CANCELLED, penaltyXAF };
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

  // ── internal payment hooks (called by payments module — Story 3.3+) ─

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
      // Pre-order: vendor isn't notified until PreOrderPromotionService runs.
      // The order sits CONFIRMED+PAID in the DB; listVendorOrders('preorder')
      // shows it in the vendor's upcoming queue.
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
  }

  // ── helpers ──────────────────────────────────────────────────────

  private async requireVendorOrder(orderId: string, userId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) throw new ForbiddenException('vendor_not_found');

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    // 404 (not 403) when the order belongs to a different vendor — same
    // no-enumeration principle as /vendors/:id.
    if (!order || order.vendorId !== vendor.id) {
      throw new NotFoundException('order_not_found');
    }
    return order;
  }

  /** Distance between vendor pin and delivery address, in km, via PostGIS. */
  private async computeDistanceKm(vendorId: string, lat: number, lng: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<DistanceRow[]>`
      SELECT ST_Distance(
        v.location,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      ) AS distance_m
      FROM vendors v
      WHERE v.id = ${vendorId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('vendor_not_found');
    }
    return rows[0].distance_m / 1000;
  }

  /**
   * Short human-readable code "TC-XXXXX" (5 base32 chars).
   * Collision odds: 1 in 33^5 ≈ 39M; uniqueness enforced by DB anyway. The
   * generated value is decoupled from the UUID so customer-service can quote
   * it over the phone without spelling out hyphens.
   */
  private generateOrderCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — phone-spelling friendly
    const bytes = randomBytes(5);
    let out = 'TC-';
    for (let i = 0; i < 5; i++) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }

  /**
   * Story 4.13 — 4-digit pickup/delivery confirmation code.
   *
   * Crypto-random source (not Math.random) because these gate physical
   * actions worth ~3000 FCFA each — a predictable PRNG would let a rider
   * skip pickup verification by guessing. Collision space is intentionally
   * small (10k); per-order uniqueness is enforced by tying the code to a
   * specific orderId, not globally.
   */
  private generate4DigitCode(): string {
    const n = randomBytes(2).readUInt16BE(0) % 10000;
    return n.toString().padStart(4, '0');
  }
}

// Re-export so the controller doesn't need to import Prisma directly.
export type { Prisma };
