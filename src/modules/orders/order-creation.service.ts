import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus, VendorStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeDeliveryFeeXAF } from '../../shared/pricing/delivery-fee.util';
import { CouponsService } from '../coupons/coupons.service';
import type { CreateOrderDto } from './dto/create-order.dto';
import {
  MIN_ORDER_XAF,
  PRE_ORDER_MAX_LEAD_HOURS,
  PRE_ORDER_MIN_LEAD_HOURS,
  type DistanceRow,
} from './orders.constants';

/**
 * Story 3.1 — order creation.
 *
 * Validates the cart against vendor + items + stock, computes fee/total
 * server-side, enforces minimum order. Idempotent via `Idempotency-Key`
 * header (Story 3.14): a retried request with the same key returns the
 * original order. Pre-orders (#187) validated for window + vendor opt-in.
 *
 * Initial status: every order starts PENDING + paymentStatus=PENDING.
 * The vendor is NOT notified at this point — the order is invisible to
 * them until the Campay webhook flips paymentStatus to PAID, at which
 * point OrderPaymentLifecycleService.onPaymentSucceeded fires
 * ORDER_CREATED and sets the 60s acceptance deadline.
 */
@Injectable()
export class OrderCreationService {
  constructor(
    @InjectPinoLogger(OrderCreationService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly coupons: CouponsService,
  ) {}

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
    // grossTotalXAF is the pre-discount amount used for the minimum-order
    // check. We deliberately apply MIN_ORDER_XAF to subtotal+delivery
    // (pre-coupon) so a tiny basket that "looks" big only because of a
    // -2000 FCFA coupon doesn't sneak under the floor.
    const grossTotalXAF = subtotalXAF + deliveryFeeXAF;

    if (grossTotalXAF < MIN_ORDER_XAF) {
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
    // Payment-gated visibility model (#178 / #179): vendor sees nothing
    // until the Campay webhook flips paymentStatus to PAID.
    const code = this.generateOrderCode();
    const pickupCode = this.generate4DigitCode();
    const deliveryCode = this.generate4DigitCode();
    const order = await this.prisma.$transaction(async (tx) => {
      // Create the order at full price first — couponCode + discountXAF
      // are added via update once the coupon redemption is locked in
      // (we need the orderId to write the CouponRedemption row).
      const created = await tx.order.create({
        data: {
          code,
          userId,
          vendorId: vendor.id,
          status: OrderStatus.PENDING,
          subtotalXAF,
          deliveryFeeXAF,
          totalXAF: grossTotalXAF,
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
          // OrderPaymentLifecycleService.onPaymentSucceeded (immediate) or
          // PreOrderPromotionService (pre-orders) so the countdown matches
          // "when the vendor can act on it," not "when the consumer hit
          // submit."
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

      // Promo coupon redemption (#167) — atomic with order creation.
      // If the consumer typed a code, redeem it INSIDE this transaction.
      // Any validation failure (first-order-only, expired, already used,
      // etc.) throws BadRequestException, which rolls back the order
      // create above — so the user gets a clean "invalid code" response
      // without an orphaned order row.
      if (dto.couponCode) {
        const redemption = await this.coupons.redeemInTransaction(
          tx,
          dto.couponCode,
          userId,
          created.id,
          subtotalXAF,
          deliveryFeeXAF,
        );
        const discounted = await tx.order.update({
          where: { id: created.id },
          data: {
            discountXAF: redemption.appliedDiscountXAF,
            couponCode: redemption.code,
            totalXAF: grossTotalXAF - redemption.appliedDiscountXAF,
          },
          include: { items: true },
        });
        return discounted;
      }

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
