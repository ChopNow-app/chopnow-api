import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { OrderStatus, PaymentStatus, Prisma, VendorStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeDeliveryFeeXAF } from '../../shared/pricing/delivery-fee.util';
import { DomainEvents } from '../../shared/events/domain-events';
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
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
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
      select: { id: true, status: true, isOpen: true },
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

    // 5) Initial status: cash + momo both start PENDING; momo flips to
    // CONFIRMED once the Campay webhook lands (Story 3.3).
    const code = this.generateOrderCode();
    const pickupCode = this.generate4DigitCode();
    const deliveryCode = this.generate4DigitCode();
    const acceptanceDeadlineAt = new Date(Date.now() + ACCEPTANCE_TTL_SECONDS * 1000);
    const order = await this.prisma.$transaction(async (tx) => {
      return tx.order.create({
        data: {
          code,
          userId,
          vendorId: vendor.id,
          status: OrderStatus.PENDING,
          subtotalXAF,
          deliveryFeeXAF,
          totalXAF,
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
          acceptanceDeadlineAt,
          idempotencyKey: idempotencyKey ?? null,
          items: { createMany: { data: lines } },
        },
        include: { items: true },
      });
    });

    this.events.emit(DomainEvents.ORDER_CREATED, {
      orderId: order.id,
      code: order.code,
      vendorId: order.vendorId,
      userId: order.userId,
      paymentMethod: order.paymentMethod,
    });

    return order;
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

    if (!CONSUMER_CAN_CANCEL.has(order.status)) {
      throw new ConflictException({
        code: 'order_not_cancellable',
        message: 'The vendor has already accepted this order. Please contact support to cancel.',
      });
    }

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
    });

    this.events.emit(DomainEvents.ORDER_CANCELLED, {
      orderId: order.id,
      paymentStatus: order.paymentStatus,
      cancelledBy: 'consumer',
    });

    // MoMo refund is wired in Story 3.8 once the payments module handles
    // Campay refund calls — log the intent now so admin can replay if needed.
    if (order.paymentStatus === PaymentStatus.PAID) {
      this.logger.warn(
        `Order ${order.id} cancelled while PAID — refund needed (Story 3.8 pending wiring)`,
      );
    }
    return updated;
  }

  // ── vendor decision path ──────────────────────────────────────────

  async listVendorOrders(userId: string, status?: OrderStatus) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');

    const orders = await this.prisma.order.findMany({
      where: { vendorId: vendor.id, ...(status ? { status } : {}) },
      orderBy: { placedAt: 'desc' },
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
      throw new ConflictException({
        code: 'order_not_pending',
        message: 'This order is no longer awaiting your decision.',
      });
    }
    const now = new Date();
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.ACCEPTED, acceptedAt: now },
    });
    this.events.emit(DomainEvents.ORDER_ACCEPTED, {
      orderId: order.id,
      vendorId: order.vendorId,
      acceptedAt: now,
    });
    return updated;
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
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.REFUSED, refusedAt: now, refusalReason: reasonLabel },
    });
    this.events.emit(DomainEvents.ORDER_REFUSED, {
      orderId: order.id,
      vendorId: order.vendorId,
      reason: dto.reason,
      refusedAt: now,
    });
    // Refund wiring: same TODO as cancelOrder.
    if (order.paymentStatus === PaymentStatus.PAID) {
      this.logger.warn(`Order ${order.id} refused by vendor while PAID — refund needed`);
    }
    return updated;
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
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.READY_PICKUP, preparedAt: now },
    });

    this.events.emit(DomainEvents.ORDER_READY, {
      orderId,
      vendorId: order.vendorId,
      preparedAt: now,
    });

    return { status: OrderStatus.READY_PICKUP, preparedAt: now };
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
        `Low rating on order ${order.id}: vendor=${dto.vendorScore} rider=${dto.riderScore}`,
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
    if (!order || order.paymentStatus === PaymentStatus.PAID) return; // idempotent

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        paymentReference: payload.providerReference,
        payerPhone: payload.payerPhone ?? order.payerPhone,
        paidAt: new Date(),
      },
    });
    this.events.emit(DomainEvents.ORDER_PAID, { orderId: updated.id, paidAt: updated.paidAt });
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
