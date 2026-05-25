import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Coupon,
  CouponStatus,
  CouponType,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Promo coupon validation + atomic redemption (#167).
 *
 * The whole point of this module is to avoid the founder honoring
 * BIENVENUE manually post-hoc (Campay refunds after the fact, which is
 * error-prone and doesn't scale past pilot). All policy lives on the
 * `coupons` row; this service is the validator + the writer of the
 * audit row.
 *
 * Two entrypoints:
 *   - `validateForUser(code, userId, subtotalXAF, deliveryFeeXAF)` —
 *     a no-write check the frontend calls when the consumer types a
 *     code into the /cart input. Returns the would-be discount so the
 *     UI can show "Livraison gratuite (-800 FCFA)" without committing.
 *   - `redeemInTransaction(tx, code, userId, orderId, ...)` — atomic
 *     redemption called from inside OrderCreationService's
 *     `prisma.$transaction`. Re-runs every validation rule inside the
 *     transaction so a race between /validate and POST /orders can't
 *     bypass `firstOrderOnly` or `maxRedemptions`. The unique
 *     `(couponId, userId)` constraint catches concurrent double-submits.
 *
 * Domain errors are thrown as BadRequestException with a stable `code`
 * field for the frontend to switch on:
 *   - coupon_not_found      — no row with this code
 *   - coupon_disabled       — status != ACTIVE
 *   - coupon_not_yet_active — now < validFrom
 *   - coupon_expired        — now > validUntil
 *   - coupon_first_order_only — user already has prior PAID order
 *   - coupon_min_subtotal   — order subtotal below required floor
 *   - coupon_already_redeemed — user already redeemed this coupon
 *   - coupon_exhausted      — global maxRedemptions hit
 */

export interface CouponValidationResult {
  couponId: string;
  code: string;
  type: CouponType;
  description: string;
  discountXAF: number;
}

@Injectable()
export class CouponsService {
  constructor(
    @InjectPinoLogger(CouponsService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Read-only validation. Called by:
   *   - the frontend's /cart "Code promo" input (no transaction)
   *   - this service's own redeemInTransaction (re-runs inside tx)
   *
   * `userPriorPaidOrderCount` is injected so the caller can compute it
   * inside their transaction (avoids a second round-trip to Postgres
   * when we're already inside one).
   */
  private validateRow(
    coupon: Coupon | null,
    code: string,
    subtotalXAF: number,
    deliveryFeeXAF: number,
    userPriorPaidOrderCount: number,
  ): CouponValidationResult {
    if (!coupon) {
      throw new BadRequestException({
        code: 'coupon_not_found',
        message: `Code "${code}" introuvable.`,
      });
    }
    if (coupon.status !== CouponStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'coupon_disabled',
        message: 'Ce code promo n’est plus actif.',
      });
    }
    const now = new Date();
    if (coupon.validFrom && now < coupon.validFrom) {
      throw new BadRequestException({
        code: 'coupon_not_yet_active',
        message: 'Ce code promo n’est pas encore activable.',
      });
    }
    if (coupon.validUntil && now > coupon.validUntil) {
      throw new BadRequestException({
        code: 'coupon_expired',
        message: 'Ce code promo a expiré.',
      });
    }
    if (coupon.minSubtotalXAF !== null && subtotalXAF < coupon.minSubtotalXAF) {
      throw new BadRequestException({
        code: 'coupon_min_subtotal',
        message: `Commande minimum requise : ${coupon.minSubtotalXAF} FCFA.`,
        minSubtotalXAF: coupon.minSubtotalXAF,
      });
    }
    if (coupon.firstOrderOnly && userPriorPaidOrderCount > 0) {
      throw new BadRequestException({
        code: 'coupon_first_order_only',
        message: 'Ce code est réservé à ta première commande.',
      });
    }
    if (coupon.maxRedemptions !== null && coupon.redemptionCount >= coupon.maxRedemptions) {
      throw new BadRequestException({
        code: 'coupon_exhausted',
        message: 'Ce code promo a atteint sa limite d’utilisations.',
      });
    }

    const discountXAF = this.computeDiscount(coupon, subtotalXAF, deliveryFeeXAF);

    return {
      couponId: coupon.id,
      code: coupon.code,
      type: coupon.type,
      description: coupon.description,
      discountXAF,
    };
  }

  /**
   * Cap rules:
   *   - FREE_DELIVERY  → discount = deliveryFeeXAF (the platform absorbs
   *     the full fee; the rider's share computation downstream still
   *     reads deliveryFeeXAF unchanged)
   *   - FIXED_AMOUNT_OFF → discount = min(valueXAF, subtotal + delivery)
   *     so we never produce a negative total
   */
  private computeDiscount(coupon: Coupon, subtotalXAF: number, deliveryFeeXAF: number): number {
    switch (coupon.type) {
      case CouponType.FREE_DELIVERY:
        return deliveryFeeXAF;
      case CouponType.FIXED_AMOUNT_OFF:
        return Math.min(coupon.valueXAF, subtotalXAF + deliveryFeeXAF);
      default:
        // Exhaustiveness — Prisma enum guarantees this is unreachable.
        throw new BadRequestException({ code: 'coupon_unsupported_type' });
    }
  }

  async validateForUser(
    rawCode: string,
    userId: string,
    subtotalXAF: number,
    deliveryFeeXAF: number,
  ): Promise<CouponValidationResult> {
    const code = rawCode.trim().toUpperCase();
    if (!code) {
      throw new BadRequestException({ code: 'coupon_not_found', message: 'Code requis.' });
    }
    const [coupon, priorOrderCount, alreadyRedeemed] = await Promise.all([
      this.prisma.coupon.findUnique({ where: { code } }),
      this.prisma.order.count({
        where: {
          userId,
          paymentStatus: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
          status: { notIn: [OrderStatus.CANCELLED] },
        },
      }),
      // Quick pre-flight: if a row already exists we surface a
      // distinct error code so the UI says "already used" instead of
      // letting the user retry. The atomic guard is still the unique
      // constraint inside redeemInTransaction.
      this.prisma.couponRedemption.findFirst({
        where: { userId, coupon: { code } },
        select: { id: true },
      }),
    ]);

    if (alreadyRedeemed) {
      throw new BadRequestException({
        code: 'coupon_already_redeemed',
        message: 'Tu as déjà utilisé ce code.',
      });
    }

    return this.validateRow(coupon, code, subtotalXAF, deliveryFeeXAF, priorOrderCount);
  }

  /**
   * Called from inside OrderCreationService.createOrder's transaction,
   * AFTER the Order row has been created (we need orderId). Re-runs
   * validation against the tx-scoped view so a concurrent order can't
   * sneak a second BIENVENUE through.
   *
   * Returns the applied discount + couponId. Caller is responsible for
   * subtracting `discountXAF` from totalXAF on the Order row (we don't
   * mutate Order from here to keep the create call site as the single
   * place that owns Order writes).
   */
  async redeemInTransaction(
    tx: Prisma.TransactionClient,
    rawCode: string,
    userId: string,
    orderId: string,
    subtotalXAF: number,
    deliveryFeeXAF: number,
  ): Promise<{ couponId: string; code: string; appliedDiscountXAF: number }> {
    const code = rawCode.trim().toUpperCase();
    if (!code) {
      throw new BadRequestException({ code: 'coupon_not_found' });
    }

    const coupon = await tx.coupon.findUnique({ where: { code } });
    const priorPaidOrderCount = await tx.order.count({
      where: {
        userId,
        paymentStatus: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
        status: { notIn: [OrderStatus.CANCELLED] },
        // Exclude the order we're currently creating — its paymentStatus
        // is PENDING so it wouldn't match anyway, but explicit guard
        // documents intent.
        id: { not: orderId },
      },
    });
    const result = this.validateRow(coupon, code, subtotalXAF, deliveryFeeXAF, priorPaidOrderCount);

    try {
      await tx.couponRedemption.create({
        data: {
          couponId: result.couponId,
          userId,
          orderId,
          appliedDiscountXAF: result.discountXAF,
          originalDeliveryFeeXAF: deliveryFeeXAF,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // (couponId, userId) unique violation — concurrent submit raced us.
        throw new BadRequestException({
          code: 'coupon_already_redeemed',
          message: 'Tu as déjà utilisé ce code.',
        });
      }
      throw err;
    }

    // Best-effort counter bump for the global cap. Not atomic with the
    // insert above (intentional — see schema comment); pilot scale
    // makes a few-row overshoot acceptable. Switch to a SELECT FOR UPDATE
    // here if we ever ship a campaign with a hard global cap.
    await tx.coupon.update({
      where: { id: result.couponId },
      data: { redemptionCount: { increment: 1 } },
    });

    this.logger.info(
      { couponCode: result.code, userId, orderId, discountXAF: result.discountXAF },
      'coupon.redeemed',
    );

    return {
      couponId: result.couponId,
      code: result.code,
      appliedDiscountXAF: result.discountXAF,
    };
  }
}
