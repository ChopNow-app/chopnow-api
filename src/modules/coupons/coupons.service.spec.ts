import { Test } from '@nestjs/testing';
import { CouponStatus, CouponType, Prisma } from '@prisma/client';
import { CouponsService } from './coupons.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

/**
 * Coupon validation + redemption (#167).
 *
 * The transactional redemption path is the high-stakes one: a bug here
 * means BIENVENUE either silently fails (consumer abandons cart) or
 * double-redeems (lost marketing spend). Every error branch in
 * validateRow has a dedicated test, and the (couponId, userId) P2002
 * race is exercised explicitly.
 */
describe('CouponsService', () => {
  let service: CouponsService;
  let prisma: {
    coupon: { findUnique: jest.Mock; update: jest.Mock };
    couponRedemption: { findFirst: jest.Mock; create: jest.Mock };
    order: { count: jest.Mock };
  };

  const baseCoupon = {
    id: 'cpn-1',
    code: 'BIENVENUE',
    description: 'Livraison gratuite',
    type: CouponType.FREE_DELIVERY,
    valueXAF: 0,
    status: CouponStatus.ACTIVE,
    validFrom: null,
    validUntil: null,
    minSubtotalXAF: null,
    firstOrderOnly: true,
    maxPerUser: 1,
    maxRedemptions: null,
    redemptionCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    prisma = {
      coupon: { findUnique: jest.fn(), update: jest.fn() },
      couponRedemption: { findFirst: jest.fn(), create: jest.fn() },
      order: { count: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CouponsService,
        { provide: PrismaService, useValue: prisma },
        pinoLoggerProvider(CouponsService.name),
      ],
    }).compile();
    service = moduleRef.get(CouponsService);
  });

  // ── validateForUser (the /validate endpoint path) ──────────────────

  describe('validateForUser', () => {
    it('returns the delivery-fee discount for a valid FREE_DELIVERY coupon on a first-order user', async () => {
      prisma.coupon.findUnique.mockResolvedValue(baseCoupon);
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      const result = await service.validateForUser('bienvenue', 'u1', 4500, 800);

      expect(result).toEqual({
        couponId: 'cpn-1',
        code: 'BIENVENUE',
        type: CouponType.FREE_DELIVERY,
        description: 'Livraison gratuite',
        discountXAF: 800,
      });
      // Case-insensitive lookup — service should uppercase before query.
      expect(prisma.coupon.findUnique).toHaveBeenCalledWith({ where: { code: 'BIENVENUE' } });
    });

    it('caps FIXED_AMOUNT_OFF discount at subtotal + delivery so total never goes negative', async () => {
      prisma.coupon.findUnique.mockResolvedValue({
        ...baseCoupon,
        type: CouponType.FIXED_AMOUNT_OFF,
        valueXAF: 10_000,
      });
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      const result = await service.validateForUser('BIENVENUE', 'u1', 2000, 500);

      // Cap: min(10_000, 2000 + 500) = 2500
      expect(result.discountXAF).toBe(2500);
    });

    it('rejects with coupon_not_found when the row does not exist', async () => {
      prisma.coupon.findUnique.mockResolvedValue(null);
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      await expect(service.validateForUser('UNKNOWN', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_not_found' },
      });
    });

    it('rejects with coupon_disabled when status != ACTIVE', async () => {
      prisma.coupon.findUnique.mockResolvedValue({ ...baseCoupon, status: CouponStatus.DISABLED });
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      await expect(service.validateForUser('BIENVENUE', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_disabled' },
      });
    });

    it('rejects with coupon_expired when now > validUntil', async () => {
      prisma.coupon.findUnique.mockResolvedValue({
        ...baseCoupon,
        validUntil: new Date(Date.now() - 1000),
      });
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      await expect(service.validateForUser('BIENVENUE', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_expired' },
      });
    });

    it('rejects with coupon_not_yet_active when now < validFrom', async () => {
      prisma.coupon.findUnique.mockResolvedValue({
        ...baseCoupon,
        validFrom: new Date(Date.now() + 60_000),
      });
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      await expect(service.validateForUser('BIENVENUE', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_not_yet_active' },
      });
    });

    it('rejects with coupon_first_order_only when the user has prior PAID orders', async () => {
      prisma.coupon.findUnique.mockResolvedValue(baseCoupon);
      prisma.order.count.mockResolvedValue(1);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      await expect(service.validateForUser('BIENVENUE', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_first_order_only' },
      });
    });

    it('rejects with coupon_min_subtotal when subtotalXAF < minSubtotalXAF', async () => {
      prisma.coupon.findUnique.mockResolvedValue({ ...baseCoupon, minSubtotalXAF: 5000 });
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      await expect(service.validateForUser('BIENVENUE', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_min_subtotal', minSubtotalXAF: 5000 },
      });
    });

    it('rejects with coupon_exhausted when maxRedemptions is hit', async () => {
      prisma.coupon.findUnique.mockResolvedValue({
        ...baseCoupon,
        maxRedemptions: 100,
        redemptionCount: 100,
      });
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue(null);

      await expect(service.validateForUser('BIENVENUE', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_exhausted' },
      });
    });

    it('rejects with coupon_already_redeemed when the user already has a redemption row', async () => {
      prisma.coupon.findUnique.mockResolvedValue(baseCoupon);
      prisma.order.count.mockResolvedValue(0);
      prisma.couponRedemption.findFirst.mockResolvedValue({ id: 'red-1' });

      await expect(service.validateForUser('BIENVENUE', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_already_redeemed' },
      });
    });

    it('rejects when the typed code is empty', async () => {
      await expect(service.validateForUser('   ', 'u1', 4500, 800)).rejects.toMatchObject({
        response: { code: 'coupon_not_found' },
      });
    });
  });

  // ── redeemInTransaction (atomic path called from OrderCreationService) ──

  describe('redeemInTransaction', () => {
    let tx: {
      coupon: { findUnique: jest.Mock; update: jest.Mock };
      couponRedemption: { create: jest.Mock };
      order: { count: jest.Mock };
    };

    beforeEach(() => {
      tx = {
        coupon: { findUnique: jest.fn(), update: jest.fn() },
        couponRedemption: { create: jest.fn() },
        order: { count: jest.fn() },
      };
    });

    it('writes the redemption row and bumps the counter on success', async () => {
      tx.coupon.findUnique.mockResolvedValue(baseCoupon);
      tx.order.count.mockResolvedValue(0);
      tx.couponRedemption.create.mockResolvedValue({ id: 'red-1' });
      tx.coupon.update.mockResolvedValue({ ...baseCoupon, redemptionCount: 1 });

      const result = await service.redeemInTransaction(
        tx as unknown as Prisma.TransactionClient,
        'bienvenue',
        'u1',
        'order-1',
        4500,
        800,
      );

      expect(result).toEqual({
        couponId: 'cpn-1',
        code: 'BIENVENUE',
        appliedDiscountXAF: 800,
      });
      expect(tx.couponRedemption.create).toHaveBeenCalledWith({
        data: {
          couponId: 'cpn-1',
          userId: 'u1',
          orderId: 'order-1',
          appliedDiscountXAF: 800,
          originalDeliveryFeeXAF: 800,
        },
      });
      expect(tx.coupon.update).toHaveBeenCalledWith({
        where: { id: 'cpn-1' },
        data: { redemptionCount: { increment: 1 } },
      });
    });

    it('maps a P2002 unique violation on (couponId, userId) to coupon_already_redeemed', async () => {
      tx.coupon.findUnique.mockResolvedValue(baseCoupon);
      tx.order.count.mockResolvedValue(0);
      tx.couponRedemption.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique violation', {
          code: 'P2002',
          clientVersion: '5.x',
        }),
      );

      await expect(
        service.redeemInTransaction(
          tx as unknown as Prisma.TransactionClient,
          'BIENVENUE',
          'u1',
          'order-1',
          4500,
          800,
        ),
      ).rejects.toMatchObject({ response: { code: 'coupon_already_redeemed' } });
      // Counter must NOT bump on a failed insert.
      expect(tx.coupon.update).not.toHaveBeenCalled();
    });

    it('excludes the currently-being-created order from the firstOrderOnly count', async () => {
      tx.coupon.findUnique.mockResolvedValue(baseCoupon);
      tx.order.count.mockResolvedValue(0);
      tx.couponRedemption.create.mockResolvedValue({ id: 'red-1' });
      tx.coupon.update.mockResolvedValue({ ...baseCoupon, redemptionCount: 1 });

      await service.redeemInTransaction(
        tx as unknown as Prisma.TransactionClient,
        'BIENVENUE',
        'u1',
        'order-current',
        4500,
        800,
      );

      const countArgs = tx.order.count.mock.calls[0][0];
      expect(countArgs.where.id).toEqual({ not: 'order-current' });
    });

    it('rolls validation back inside the transaction when prior PAID orders exist (no insert)', async () => {
      tx.coupon.findUnique.mockResolvedValue(baseCoupon);
      tx.order.count.mockResolvedValue(2);

      await expect(
        service.redeemInTransaction(
          tx as unknown as Prisma.TransactionClient,
          'BIENVENUE',
          'u1',
          'order-1',
          4500,
          800,
        ),
      ).rejects.toMatchObject({ response: { code: 'coupon_first_order_only' } });
      expect(tx.couponRedemption.create).not.toHaveBeenCalled();
      expect(tx.coupon.update).not.toHaveBeenCalled();
    });
  });
});
