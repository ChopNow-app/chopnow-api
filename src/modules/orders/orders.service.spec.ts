import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  VendorStatus,
  VendorType,
} from '@prisma/client';
import { OrdersService } from './orders.service';
import { OrderCreationService } from './order-creation.service';
import { CouponsService } from '../coupons/coupons.service';
import { OrderVendorActionsService } from './order-vendor-actions.service';
import { OrderPaymentLifecycleService } from './order-payment-lifecycle.service';
import { OrderLifecycleScheduler } from './order-lifecycle.scheduler';
import { LedgerService } from '../finance/ledger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { RefusalReason } from './dto/vendor-decision.dto';
import { DomainEvents } from '../../shared/events/domain-events';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

describe('Orders module services', () => {
  // The split into four services (Creation / VendorActions /
  // PaymentLifecycle / Orders) happened after the umbrella service hit
  // ~1100 LOC. Tests still live in one file because they all share the
  // same mocked Prisma + EventEmitter2 + LedgerService graph — splitting
  // the spec would duplicate ~80 LOC of beforeEach across four files for
  // no readability win.
  let service: OrdersService;
  let creation: OrderCreationService;
  let vendorActions: OrderVendorActionsService;
  let paymentLifecycle: OrderPaymentLifecycleService;
  let prisma: {
    order: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    item: { findMany: jest.Mock };
    vendor: { findUnique: jest.Mock };
    orderItem: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
    orderRating: { create: jest.Mock };
    vendorPenalty: { create: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let events: { emit: jest.Mock };
  let ledger: { recordTransaction: jest.Mock };
  let lifecycleScheduler: {
    scheduleAcceptanceExpiry: jest.Mock;
    schedulePreOrderPromotion: jest.Mock;
  };

  const baseDto: CreateOrderDto = {
    vendorId: 'v-1',
    items: [
      { itemId: 'i-1', quantity: 2 },
      { itemId: 'i-2', quantity: 1 },
    ],
    paymentMethod: PaymentMethod.MTN_MOMO,
    noteForVendor: 'Sans piment',
    deliveryLat: 4.0511,
    deliveryLng: 9.7679,
    deliveryQuartier: 'Makepe',
    deliveryLandmark: 'Rond-Point Total',
    deliveryDescription: '2ème portail bleu',
    deliveryPhone: '670000123',
  };

  beforeEach(async () => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'order-new',
          ...data,
          items: data.items?.createMany?.data ?? [],
        })),
        update: jest.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })),
        // count: 1 = happy path (the conditional updateMany found the row in
        // the expected state and flipped it). Individual tests override this
        // to { count: 0 } to simulate losing the race against the cron.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      item: { findMany: jest.fn() },
      orderItem: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })),
      },
      vendor: { findUnique: jest.fn() },
      orderRating: {
        create: jest
          .fn()
          .mockImplementation(({ data }) => ({ id: 'rating-1', createdAt: new Date(), ...data })),
      },
      vendorPenalty: {
        create: jest
          .fn()
          .mockImplementation(({ data }) => ({ id: 'penalty-1', createdAt: new Date(), ...data })),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ distance_m: 1500 }]), // 1.5 km
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };
    events = { emit: jest.fn() };
    ledger = { recordTransaction: jest.fn().mockResolvedValue(undefined) };
    lifecycleScheduler = {
      scheduleAcceptanceExpiry: jest.fn().mockResolvedValue(undefined),
      schedulePreOrderPromotion: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        OrdersService,
        OrderCreationService,
        OrderVendorActionsService,
        OrderPaymentLifecycleService,
        pinoLoggerProvider(OrdersService.name),
        pinoLoggerProvider(OrderCreationService.name),
        pinoLoggerProvider(OrderVendorActionsService.name),
        pinoLoggerProvider(OrderPaymentLifecycleService.name),
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
        { provide: LedgerService, useValue: ledger },
        { provide: OrderLifecycleScheduler, useValue: lifecycleScheduler },
        // Coupons module (#167) — orders never call into it directly
        // unless dto.couponCode is set, but DI still requires the
        // provider. Tests that exercise the coupon path stub
        // `redeemInTransaction` explicitly via jest.spyOn.
        {
          provide: CouponsService,
          useValue: {
            validateForUser: jest.fn(),
            redeemInTransaction: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(OrdersService);
    creation = module.get(OrderCreationService);
    vendorActions = module.get(OrderVendorActionsService);
    paymentLifecycle = module.get(OrderPaymentLifecycleService);
  });

  describe('createOrder', () => {
    function readyHappyPath(
      opts: { acceptsPreOrders?: boolean; commissionRate?: number; type?: VendorType } = {},
    ) {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.ACTIVE,
        isOpen: true,
        acceptsPreOrders: opts.acceptsPreOrders ?? false,
        type: opts.type ?? VendorType.INFORMAL,
        commissionRate: new Prisma.Decimal(opts.commissionRate ?? 0.06),
      });
      prisma.item.findMany.mockResolvedValue([
        { id: 'i-1', name: 'Ndolé', priceXAF: 2000, isAvailable: true, isInStock: true },
        { id: 'i-2', name: 'Bissap', priceXAF: 500, isAvailable: true, isInStock: true },
      ]);
    }

    it('creates a PENDING order with server-computed totals — vendor not yet notified', async () => {
      readyHappyPath();

      const order = await creation.createOrder('user-1', baseDto);

      // Subtotal = 2*2000 + 1*500 = 4500
      // Fee: 1.5km → 250 + 150 = 400 → floor=500
      // Total = 5000
      expect(order.subtotalXAF).toBe(4500);
      expect(order.deliveryFeeXAF).toBe(500);
      expect(order.totalXAF).toBe(5000);
      expect(order.status).toBe(OrderStatus.PENDING);
      expect(order.paymentStatus).toBe(PaymentStatus.PENDING);
      expect(order.code).toMatch(/^TC-[A-Z0-9]{5}$/);

      // Snapshot prices on order_items
      expect(order.items).toEqual([
        expect.objectContaining({
          itemId: 'i-1',
          nameSnapshot: 'Ndolé',
          priceXAFSnapshot: 2000,
          quantity: 2,
          lineXAF: 4000,
        }),
        expect.objectContaining({ itemId: 'i-2', quantity: 1, lineXAF: 500 }),
      ]);

      // Payment-gated visibility (#178): vendor is NOT notified at order
      // creation — ORDER_CREATED fires only after onPaymentSucceeded.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('does NOT set acceptanceDeadlineAt at creation — set when payment confirms (#179)', async () => {
      readyHappyPath();
      await creation.createOrder('user-1', baseDto);
      const createArgs = prisma.order.create.mock.calls[0][0];
      expect(createArgs.data.acceptanceDeadlineAt).toBeUndefined();
    });

    it('rejects below the 1200 FCFA minimum', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.ACTIVE,
        isOpen: true,
      });
      // 1 line × 200 FCFA + fee → still well below MIN_ORDER_XAF
      prisma.item.findMany.mockResolvedValue([
        { id: 'i-1', name: 'Snack', priceXAF: 200, isAvailable: true, isInStock: true },
      ]);

      await expect(
        creation.createOrder('user-1', { ...baseDto, items: [{ itemId: 'i-1', quantity: 1 }] }),
      ).rejects.toMatchObject({ response: { code: 'order_below_minimum' } });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('rejects when vendor is not ACTIVE', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.PENDING_REVIEW,
        isOpen: true,
      });
      await expect(creation.createOrder('user-1', baseDto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects when vendor is closed (just toggled offline)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.ACTIVE,
        isOpen: false,
      });
      await expect(creation.createOrder('user-1', baseDto)).rejects.toMatchObject({
        response: { code: 'vendor_closed' },
      });
    });

    it('rejects when an item belongs to another vendor (or was just deleted)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.ACTIVE,
        isOpen: true,
      });
      prisma.item.findMany.mockResolvedValue([
        { id: 'i-1', name: 'X', priceXAF: 2000, isAvailable: true, isInStock: true },
        // i-2 missing from the find result → server can't resolve it → reject.
      ]);

      await expect(creation.createOrder('user-1', baseDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects when an item is out of stock', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.ACTIVE,
        isOpen: true,
      });
      prisma.item.findMany.mockResolvedValue([
        { id: 'i-1', name: 'A', priceXAF: 2000, isAvailable: true, isInStock: true },
        { id: 'i-2', name: 'Ndolé', priceXAF: 500, isAvailable: true, isInStock: false },
      ]);
      await expect(creation.createOrder('user-1', baseDto)).rejects.toMatchObject({
        response: { code: 'item_out_of_stock' },
      });
    });

    it('short-circuits on idempotency key — returns the existing order', async () => {
      const existing = { id: 'order-existing', items: [] };
      prisma.order.findUnique.mockResolvedValue(existing);

      const result = await creation.createOrder('user-1', baseDto, 'client-uuid-123');

      expect(result).toBe(existing);
      expect(prisma.vendor.findUnique).not.toHaveBeenCalled();
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    describe('item-availability flip telemetry (#173)', () => {
      it('logs a structured warning when an item flipped to isAvailable=false during the create window', async () => {
        readyHappyPath();
        // After order.create commits, the recheck sees one item now flipped
        // off with a fresh updatedAt — the race actually fired.
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', priceXAF: 2000, isAvailable: true, isInStock: true },
          { id: 'i-2', name: 'Bissap', priceXAF: 500, isAvailable: true, isInStock: true },
        ]);
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', isAvailable: false, isInStock: true, updatedAt: new Date() },
          {
            id: 'i-2',
            name: 'Bissap',
            isAvailable: true,
            isInStock: true,
            updatedAt: new Date(Date.now() - 60_000),
          },
        ]);
        const warnSpy = jest.spyOn(creation['logger'], 'warn').mockImplementation(() => undefined);

        await creation.createOrder('user-1', baseDto);

        // PinoLogger structured-fields API: warn(fields, message).
        // Look for the call whose `event` field is the flip-race code.
        const flippedWarn = warnSpy.mock.calls.find(
          (c) => (c[0] as { event?: string })?.event === 'order_item_flip_race',
        );
        expect(flippedWarn).toBeDefined();
        const fields = flippedWarn?.[0] as {
          flippedItems: Array<{ name: string }>;
          flippedCount: number;
        };
        const names = fields.flippedItems.map((i) => i.name);
        expect(names).toContain('Ndolé'); // the flipped one
        expect(names).not.toContain('Bissap'); // legitimately stale updatedAt — ignored
        expect(fields.flippedCount).toBe(1);
        warnSpy.mockRestore();
      });

      it('does NOT log when items remain available after the order commits (happy path)', async () => {
        readyHappyPath();
        // Recheck sees everything still on.
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', priceXAF: 2000, isAvailable: true, isInStock: true },
          { id: 'i-2', name: 'Bissap', priceXAF: 500, isAvailable: true, isInStock: true },
        ]);
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', isAvailable: true, isInStock: true, updatedAt: new Date() },
          { id: 'i-2', name: 'Bissap', isAvailable: true, isInStock: true, updatedAt: new Date() },
        ]);
        const warnSpy = jest.spyOn(creation['logger'], 'warn').mockImplementation(() => undefined);

        await creation.createOrder('user-1', baseDto);

        const flippedWarn = warnSpy.mock.calls.find(
          (c) => (c[0] as { event?: string })?.event === 'order_item_flip_race',
        );
        expect(flippedWarn).toBeUndefined();
        warnSpy.mockRestore();
      });

      it('telemetry failure does NOT propagate to the order pipeline (order already committed)', async () => {
        readyHappyPath();
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', priceXAF: 2000, isAvailable: true, isInStock: true },
          { id: 'i-2', name: 'Bissap', priceXAF: 500, isAvailable: true, isInStock: true },
        ]);
        // Second call (the recheck) throws. The order has already been
        // committed; the throw must not propagate.
        prisma.item.findMany.mockRejectedValueOnce(new Error('DB connection lost'));

        await expect(creation.createOrder('user-1', baseDto)).resolves.toBeDefined();
      });
    });

    describe('pre-orders (#187)', () => {
      // Pin the clock at 10:00 UTC (11:00 Douala). That leaves plenty of room
      // both for the >4h lead requirement and for staying inside the v1
      // same-day cap (22:59 UTC = 23:59 Douala).
      const FAKE_NOW = new Date('2026-06-15T10:00:00.000Z');
      beforeEach(() => {
        jest.useFakeTimers().setSystemTime(FAKE_NOW);
      });
      afterEach(() => {
        jest.useRealTimers();
      });

      const farInThePast = new Date('2026-06-15T09:00:00.000Z'); // 1h ago
      const inFiveHours = new Date('2026-06-15T15:00:00.000Z'); // valid (>4h, <24h)
      const tomorrowSameTime = new Date('2026-06-16T08:00:00.000Z'); // exactly 22h ahead (valid v1.1)
      const farInTheFuture = new Date('2026-06-16T11:00:00.000Z'); // 25h ahead — too far

      it('rejects when scheduledFor is set but vendor does not accept pre-orders', async () => {
        readyHappyPath({ acceptsPreOrders: false });
        await expect(
          creation.createOrder('user-1', { ...baseDto, scheduledFor: inFiveHours }),
        ).rejects.toMatchObject({
          response: { code: 'pre_orders_not_accepted_by_this_vendor' },
        });
        expect(prisma.order.create).not.toHaveBeenCalled();
      });

      it('rejects when scheduledFor is less than 4h away (too soon)', async () => {
        readyHappyPath({ acceptsPreOrders: true });
        await expect(
          creation.createOrder('user-1', {
            ...baseDto,
            scheduledFor: new Date(Date.now() + 30 * 60_000), // 30 min away
          }),
        ).rejects.toMatchObject({ response: { code: 'pre_order_too_soon' } });
      });

      it('rejects when scheduledFor is past (negative lead time)', async () => {
        readyHappyPath({ acceptsPreOrders: true });
        await expect(
          creation.createOrder('user-1', { ...baseDto, scheduledFor: farInThePast }),
        ).rejects.toMatchObject({ response: { code: 'pre_order_too_soon' } });
      });

      it('rejects when scheduledFor is more than 24h away (v1.1 day-ahead cap)', async () => {
        readyHappyPath({ acceptsPreOrders: true });
        await expect(
          creation.createOrder('user-1', { ...baseDto, scheduledFor: farInTheFuture }),
        ).rejects.toMatchObject({ response: { code: 'pre_order_too_far_in_future' } });
      });

      it('accepts a day-ahead pre-order (v1.1) — tomorrow same time, within 24h cap', async () => {
        readyHappyPath({ acceptsPreOrders: true });
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', priceXAF: 2000, isAvailable: true, isInStock: true },
          { id: 'i-2', name: 'Bissap', priceXAF: 500, isAvailable: true, isInStock: true },
        ]);
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', isAvailable: true, isInStock: true, updatedAt: new Date() },
          { id: 'i-2', name: 'Bissap', isAvailable: true, isInStock: true, updatedAt: new Date() },
        ]);
        await creation.createOrder('user-1', { ...baseDto, scheduledFor: tomorrowSameTime });
        const data = prisma.order.create.mock.calls[0][0].data;
        expect(data.scheduledFor).toEqual(tomorrowSameTime);
      });

      it('persists scheduledFor when valid pre-order accepted by the vendor', async () => {
        readyHappyPath({ acceptsPreOrders: true });
        // Mock the recheck call so checkPostCreateItemAvailability doesn't blow up
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', priceXAF: 2000, isAvailable: true, isInStock: true },
          { id: 'i-2', name: 'Bissap', priceXAF: 500, isAvailable: true, isInStock: true },
        ]);
        prisma.item.findMany.mockResolvedValueOnce([
          { id: 'i-1', name: 'Ndolé', isAvailable: true, isInStock: true, updatedAt: new Date() },
          { id: 'i-2', name: 'Bissap', isAvailable: true, isInStock: true, updatedAt: new Date() },
        ]);
        await creation.createOrder('user-1', { ...baseDto, scheduledFor: inFiveHours });
        const data = prisma.order.create.mock.calls[0][0].data;
        expect(data.scheduledFor).toEqual(inFiveHours);
      });

      it('persists scheduledFor=null for an immediate order (omitted in DTO)', async () => {
        readyHappyPath();
        await creation.createOrder('user-1', baseDto);
        const data = prisma.order.create.mock.calls[0][0].data;
        expect(data.scheduledFor).toBeNull();
      });
    });

    describe('commission snapshot (ADR-0005)', () => {
      it('snapshots the vendor commissionRate onto the Order at creation', async () => {
        readyHappyPath({ commissionRate: 0.06 });
        await creation.createOrder('user-1', baseDto);
        const data = prisma.order.create.mock.calls[0][0].data;
        expect(Number(data.commissionRate)).toBe(0.06);
      });

      it('captures whatever rate the vendor has — pilot 17% restaurant', async () => {
        readyHappyPath({ commissionRate: 0.17, type: VendorType.RESTAURANT });
        await creation.createOrder('user-1', baseDto);
        const data = prisma.order.create.mock.calls[0][0].data;
        expect(Number(data.commissionRate)).toBe(0.17);
      });
    });
  });

  describe('cancelOrder', () => {
    it('cancels a PENDING order via status-guarded update and emits order.cancelled', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
      });

      await service.cancelOrder('order-1', 'user-1');

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order-1',
          status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
        },
        data: { status: OrderStatus.CANCELLED, cancelledAt: expect.any(Date) },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.ORDER_CANCELLED,
        expect.objectContaining({ orderId: 'order-1', cancelledBy: 'consumer' }),
      );
    });

    it('refuses to cancel after vendor accepted (clean error for stale URL revisit)', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        status: OrderStatus.ACCEPTED,
        paymentStatus: PaymentStatus.PAID,
      });
      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'order_not_cancellable' },
      });
    });

    it('throws order_state_changed when the vendor accepted between read and write (#174)', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PAID,
      });
      // Simulate the sub-100ms race: pre-check saw PENDING, then vendor's
      // acceptOrder flipped the row to ACCEPTED before our updateMany lands.
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'order_state_changed' },
      });
      // Critical: no ORDER_CANCELLED event — the vendor's ORDER_ACCEPTED
      // already fired (dispatch may have started); a follow-up cancelled
      // event would tell the consumer their order was cancelled while a
      // rider is en route.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('returns 404 when order belongs to a different user', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'someone-else',
        status: OrderStatus.PENDING,
      });
      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects consumer cancel on pre-orders (#187) with pre_order_consumer_cannot_cancel', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        scheduledFor: new Date(Date.now() + 6 * 3600_000),
      });
      await expect(service.cancelOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'pre_order_consumer_cannot_cancel' },
      });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('vendorCancelPreOrder (#187)', () => {
    function preOrderInState(status: OrderStatus) {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        vendorId: 'v-1',
        userId: 'consumer-1',
        status,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.MTN_MOMO,
        totalXAF: 4900,
        scheduledFor: new Date(Date.now() + 6 * 3600_000),
      });
    }

    it('cancels an ACCEPTED pre-order: updateMany guard, refund pending, penalty row, ORDER_CANCELLED', async () => {
      preOrderInState(OrderStatus.ACCEPTED);

      const result = await vendorActions.vendorCancelPreOrder(
        'order-1',
        'user-vendor',
        'Pas de courant',
      );

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order-1',
          status: { in: [OrderStatus.ACCEPTED, OrderStatus.IN_PREP] },
        },
        data: expect.objectContaining({
          status: OrderStatus.CANCELLED,
          paymentStatus: PaymentStatus.REFUND_PENDING,
          cancelledAt: expect.any(Date),
          refusalReason: expect.stringContaining('VENDOR_PREORDER_CANCEL'),
        }),
      });
      // Penalty = 10% of 4900 = 490 → rounded DOWN to 50 = 450.
      expect(prisma.vendorPenalty.create).toHaveBeenCalledWith({
        data: {
          vendorId: 'v-1',
          orderId: 'order-1',
          reason: 'PRE_ORDER_VENDOR_CANCEL_AFTER_ACCEPT',
          amountXAF: 450,
        },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.ORDER_CANCELLED,
        expect.objectContaining({ cancelledBy: 'vendor_preorder' }),
      );
      expect(result).toEqual({ status: OrderStatus.CANCELLED, penaltyXAF: 450 });
    });

    it('cancels an IN_PREP pre-order — same path applies', async () => {
      preOrderInState(OrderStatus.IN_PREP);
      await vendorActions.vendorCancelPreOrder('order-1', 'user-vendor');
      expect(prisma.order.updateMany).toHaveBeenCalled();
      expect(prisma.vendorPenalty.create).toHaveBeenCalled();
    });

    it('rejects when the order is NOT a pre-order (scheduledFor null)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        vendorId: 'v-1',
        status: OrderStatus.ACCEPTED,
        paymentStatus: PaymentStatus.PAID,
        scheduledFor: null,
      });
      await expect(
        vendorActions.vendorCancelPreOrder('order-1', 'user-vendor'),
      ).rejects.toMatchObject({
        response: { code: 'not_a_pre_order' },
      });
      expect(prisma.vendorPenalty.create).not.toHaveBeenCalled();
    });

    it('rejects when status is PENDING/CONFIRMED (use refuseOrder for pre-acceptance — no penalty)', async () => {
      preOrderInState(OrderStatus.CONFIRMED);
      await expect(
        vendorActions.vendorCancelPreOrder('order-1', 'user-vendor'),
      ).rejects.toMatchObject({
        response: { code: 'pre_order_not_in_cancellable_state' },
      });
      expect(prisma.vendorPenalty.create).not.toHaveBeenCalled();
    });

    it('rejects when status has progressed past IN_PREP (READY_PICKUP)', async () => {
      preOrderInState(OrderStatus.READY_PICKUP);
      await expect(
        vendorActions.vendorCancelPreOrder('order-1', 'user-vendor'),
      ).rejects.toMatchObject({
        response: { code: 'pre_order_not_in_cancellable_state' },
      });
    });

    it('lost-race short-circuit: updateMany returns 0 → 409 order_state_changed, no penalty row', async () => {
      preOrderInState(OrderStatus.ACCEPTED);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        vendorActions.vendorCancelPreOrder('order-1', 'user-vendor'),
      ).rejects.toMatchObject({
        response: { code: 'order_state_changed' },
      });
      expect(prisma.vendorPenalty.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('writes paired ledger entries (VENDOR_PAYABLE debit + PLATFORM_REVENUE credit) using penalty.id as eventId (ADR-0005 / #194)', async () => {
      preOrderInState(OrderStatus.ACCEPTED);

      await vendorActions.vendorCancelPreOrder('order-1', 'user-vendor');

      expect(ledger.recordTransaction).toHaveBeenCalledTimes(1);
      const [input, tx] = ledger.recordTransaction.mock.calls[0];
      // eventId matches the VendorPenalty row id so the two systems stay traceable.
      expect(input.eventId).toBe('penalty-1');
      expect(input.eventType).toBe('PENALTY_APPLIED');
      // Paired entries must sum to zero. Penalty is 450 (10% of 4900, floor to 50).
      expect(input.entries).toEqual([
        expect.objectContaining({
          account: 'VENDOR_PAYABLE',
          amountXAF: 450,
          vendorId: 'v-1',
          orderId: 'order-1',
        }),
        expect.objectContaining({
          account: 'PLATFORM_REVENUE',
          amountXAF: -450,
          vendorId: 'v-1',
          orderId: 'order-1',
        }),
      ]);
      // Recorded inside the prisma transaction — not on the standalone client.
      expect(tx).toBe(prisma);
    });

    it('rolls back the entire cancellation if the ledger write fails — no penalty row, no events', async () => {
      preOrderInState(OrderStatus.ACCEPTED);
      ledger.recordTransaction.mockRejectedValueOnce(new Error('ledger boom'));

      await expect(vendorActions.vendorCancelPreOrder('order-1', 'user-vendor')).rejects.toThrow(
        'ledger boom',
      );
      // The ORDER_CANCELLED event must NOT have fired — the transaction
      // rolled back, so the order is still ACCEPTED and no consumer
      // refund-pending message should be sent.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('penalty rounding: 5000 FCFA total → 500 → floors to 500; 4949 → 494 → floors to 450', async () => {
      // 4949 * 0.10 = 494.9 → Math.floor(494.9 / 50) * 50 = 9 * 50 = 450
      preOrderInState(OrderStatus.ACCEPTED);
      prisma.order.findUnique.mockResolvedValueOnce({
        id: 'order-1',
        vendorId: 'v-1',
        userId: 'consumer-1',
        status: OrderStatus.ACCEPTED,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.MTN_MOMO,
        totalXAF: 4949,
        scheduledFor: new Date(Date.now() + 6 * 3600_000),
      });
      await vendorActions.vendorCancelPreOrder('order-1', 'user-vendor');
      expect(prisma.vendorPenalty.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amountXAF: 450 }) }),
      );
    });
  });

  describe('acceptOrder', () => {
    function vendorOrder(status: OrderStatus) {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        vendorId: 'v-1',
        status,
        paymentStatus: PaymentStatus.PAID,
      });
    }

    it('flips CONFIRMED → ACCEPTED + emits order.accepted (with status-guarded update)', async () => {
      vendorOrder(OrderStatus.CONFIRMED);
      await vendorActions.acceptOrder('order-1', 'user-1');
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order-1',
          status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
        },
        data: { status: OrderStatus.ACCEPTED, acceptedAt: expect.any(Date) },
      });
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.ORDER_ACCEPTED, expect.any(Object));
    });

    it('also accepts PENDING (cash flow) → ACCEPTED', async () => {
      vendorOrder(OrderStatus.PENDING);
      await vendorActions.acceptOrder('order-1', 'user-1');
      expect(prisma.order.updateMany).toHaveBeenCalled();
    });

    it('refuses when order is already in a non-decidable state', async () => {
      vendorOrder(OrderStatus.READY_PICKUP);
      await expect(vendorActions.acceptOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'order_not_pending' },
      });
    });

    it('returns 404 when order belongs to a different vendor', async () => {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        vendorId: 'v-OTHER',
        status: OrderStatus.CONFIRMED,
      });
      await expect(vendorActions.acceptOrder('order-1', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws order_state_changed when the cron flipped status between read and write', async () => {
      vendorOrder(OrderStatus.CONFIRMED);
      // Simulate the sub-100ms race: requireVendorOrder() read PENDING/CONFIRMED,
      // then between that read and our updateMany the cron transitioned the
      // row to REFUSED. updateMany matches zero rows.
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(vendorActions.acceptOrder('order-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'order_state_changed' },
      });
      // Critical: no event must fire — the consumer already got the auto-refuse
      // WhatsApp, we cannot follow it with an ORDER_ACCEPTED event.
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('refuseOrder', () => {
    function vendorOrder(status: OrderStatus) {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        vendorId: 'v-1',
        status,
        paymentStatus: PaymentStatus.PAID,
      });
    }

    it('flips CONFIRMED → REFUSED with reason label (status-guarded update)', async () => {
      vendorOrder(OrderStatus.CONFIRMED);

      await vendorActions.refuseOrder('order-1', 'user-1', {
        reason: RefusalReason.POWER_OUTAGE,
        note: 'Pas de courant depuis 30 min',
      });

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order-1',
          status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
        },
        data: {
          status: OrderStatus.REFUSED,
          refusedAt: expect.any(Date),
          refusalReason: 'POWER_OUTAGE: Pas de courant depuis 30 min',
        },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.ORDER_REFUSED,
        expect.objectContaining({ reason: RefusalReason.POWER_OUTAGE }),
      );
    });

    it('throws order_state_changed when the cron auto-refused first (race)', async () => {
      vendorOrder(OrderStatus.CONFIRMED);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        vendorActions.refuseOrder('order-1', 'user-1', { reason: RefusalReason.CLOSED }),
      ).rejects.toMatchObject({ response: { code: 'order_state_changed' } });
      // No second ORDER_REFUSED event — the cron already emitted one with the
      // EXPIRED reason; we cannot double-fire with the vendor's reason or the
      // consumer-side timeline reads as two refusals in a row.
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('rateOrder (Story 3.9)', () => {
    const justDelivered = () => ({
      id: 'order-1',
      userId: 'user-1',
      vendorId: 'v-1',
      status: OrderStatus.DELIVERED,
      deliveredAt: new Date(Date.now() - 60_000),
      rating: null,
    });

    it('creates a rating with both scores + comment', async () => {
      prisma.order.findUnique.mockResolvedValue(justDelivered());
      await service.rateOrder('order-1', 'user-1', {
        vendorScore: 5,
        riderScore: 4,
        comment: 'Excellent',
      });
      expect(prisma.orderRating.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          userId: 'user-1',
          vendorId: 'v-1',
          vendorScore: 5,
          riderScore: 4,
          comment: 'Excellent',
        },
      });
    });

    it('rejects when order is not DELIVERED', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...justDelivered(),
        status: OrderStatus.ACCEPTED,
      });
      await expect(
        service.rateOrder('order-1', 'user-1', { vendorScore: 5, riderScore: 5 }),
      ).rejects.toMatchObject({ response: { code: 'order_not_rateable' } });
    });

    it('rejects when the order is already rated', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...justDelivered(),
        rating: { id: 'rating-existing' },
      });
      await expect(
        service.rateOrder('order-1', 'user-1', { vendorScore: 5, riderScore: 5 }),
      ).rejects.toMatchObject({ response: { code: 'order_already_rated' } });
    });

    it('rejects after the 24h window', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...justDelivered(),
        deliveredAt: new Date(Date.now() - 25 * 3600 * 1000),
      });
      await expect(
        service.rateOrder('order-1', 'user-1', { vendorScore: 5, riderScore: 5 }),
      ).rejects.toMatchObject({ response: { code: 'rating_window_expired' } });
    });

    it('returns 404 when order belongs to a different user', async () => {
      prisma.order.findUnique.mockResolvedValue({ ...justDelivered(), userId: 'other' });
      await expect(
        service.rateOrder('order-1', 'user-1', { vendorScore: 5, riderScore: 5 }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('onPaymentSucceeded', () => {
    function pendingOrder(overrides: Record<string, unknown> = {}) {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        code: 'TC-ABCDE',
        vendorId: 'v-1',
        userId: 'user-1',
        paymentMethod: PaymentMethod.MTN_MOMO,
        paymentStatus: PaymentStatus.PENDING,
        payerPhone: null,
        scheduledFor: null,
        subtotalXAF: 4500,
        deliveryFeeXAF: 400,
        totalXAF: 4900,
        commissionRate: new Prisma.Decimal(0.06),
        ...overrides,
      });
    }

    it('flips PENDING → CONFIRMED + PAID with status-guarded updateMany and 60s acceptance deadline', async () => {
      pendingOrder();

      await paymentLifecycle.onPaymentSucceeded({
        orderId: 'order-1',
        providerReference: 'campay-123',
        payerPhone: '+237670000000',
      });

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order-1',
          // Race guard (#172): only flip if the row is still in a non-PAID
          // state. A concurrent Campay-retried webhook matches zero rows.
          paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        },
        data: expect.objectContaining({
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          paymentReference: 'campay-123',
          payerPhone: '+237670000000',
          acceptanceDeadlineAt: expect.any(Date),
        }),
      });
    });

    it('emits ORDER_PAID + ORDER_CREATED on success — ORDER_CREATED is what triggers vendor push (#178)', async () => {
      pendingOrder();
      await paymentLifecycle.onPaymentSucceeded({
        orderId: 'order-1',
        providerReference: 'campay-123',
      });
      const emitted = events.emit.mock.calls.map((c) => c[0]);
      expect(emitted).toContain(DomainEvents.ORDER_PAID);
      expect(emitted).toContain(DomainEvents.ORDER_CREATED);
    });

    it('is idempotent — a second call on an already PAID order is a no-op', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        paymentStatus: PaymentStatus.PAID,
      });

      await paymentLifecycle.onPaymentSucceeded({
        orderId: 'order-1',
        providerReference: 'campay-123',
      });

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('lost-race short-circuit — updateMany matches zero rows, NO events emitted, NO ledger written (#172, 7.1a)', async () => {
      pendingOrder();
      // Concurrent Campay-retried webhook already flipped this row PAID
      // between findUnique and updateMany. Our update matches zero rows.
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await paymentLifecycle.onPaymentSucceeded({
        orderId: 'order-1',
        providerReference: 'campay-123',
      });

      // Critical: NO event must fire — the other webhook already emitted
      // ORDER_PAID + ORDER_CREATED. Double-emit would double-notify the
      // vendor (push + WhatsApp twice). Same for the ledger: only the
      // winning webhook writes PAYMENT_RECEIVED entries.
      expect(events.emit).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    describe('commission snapshots (ADR-0005)', () => {
      it('computes commissionXAF + riderShareXAF + platformFeeXAF from the snapshotted rate AND writes PAYMENT_RECEIVED ledger entries (7.1a)', async () => {
        pendingOrder(); // subtotal 4500, fee 400, commissionRate 0.06, total 4900

        await paymentLifecycle.onPaymentSucceeded({
          orderId: 'order-1',
          providerReference: 'campay-1',
        });

        const data = prisma.order.updateMany.mock.calls[0][0].data;
        expect(data.commissionXAF).toBe(270);
        expect(data.riderShareXAF).toBe(260);
        expect(data.platformFeeXAF).toBe(410);

        // 7.1a ledger entries: CAMPAY_FLOAT +4900 / CUSTOMER_ESCROW -4900
        expect(ledger.recordTransaction).toHaveBeenCalledTimes(1);
        const [input, tx] = ledger.recordTransaction.mock.calls[0];
        expect(input.eventId).toBe('payment:order-1');
        expect(input.eventType).toBe('PAYMENT_RECEIVED');
        expect(input.entries).toEqual([
          expect.objectContaining({
            account: 'CAMPAY_FLOAT',
            amountXAF: 4900,
            orderId: 'order-1',
          }),
          expect.objectContaining({
            account: 'CUSTOMER_ESCROW',
            amountXAF: -4900,
            orderId: 'order-1',
          }),
        ]);
        expect(tx).toBe(prisma);
      });

      it('uses the order-snapshotted rate, not the current vendor rate (audit immutability)', async () => {
        // Order was placed when the vendor's rate was 17%. The vendor's
        // rate may have changed since; the snapshot still wins.
        pendingOrder({
          subtotalXAF: 3500,
          deliveryFeeXAF: 700,
          totalXAF: 4200,
          commissionRate: new Prisma.Decimal(0.17),
        });

        await paymentLifecycle.onPaymentSucceeded({
          orderId: 'order-1',
          providerReference: 'campay-2',
        });

        const data = prisma.order.updateMany.mock.calls[0][0].data;
        // 3500 × 0.17 = 595
        expect(data.commissionXAF).toBe(595);
        // 700 × 0.65 = 455
        expect(data.riderShareXAF).toBe(455);
        // 595 + (700 − 455) = 840
        expect(data.platformFeeXAF).toBe(840);
      });
    });

    describe('pre-orders (#187)', () => {
      it('pre-order payment: flips PAID + emits ORDER_PAID but NOT ORDER_CREATED, NO acceptanceDeadlineAt', async () => {
        pendingOrder({ scheduledFor: new Date(Date.now() + 6 * 3600_000) });

        await paymentLifecycle.onPaymentSucceeded({
          orderId: 'order-1',
          providerReference: 'campay-123',
        });

        // The acceptanceDeadlineAt is set by PreOrderPromotionService at
        // scheduledFor - 60min, NOT at payment time.
        const updateArgs = prisma.order.updateMany.mock.calls[0][0];
        expect(updateArgs.data.acceptanceDeadlineAt).toBeUndefined();
        expect(updateArgs.data.status).toBe(OrderStatus.CONFIRMED);
        expect(updateArgs.data.paymentStatus).toBe(PaymentStatus.PAID);

        const emitted = events.emit.mock.calls.map((c) => c[0]);
        expect(emitted).toContain(DomainEvents.ORDER_PAID); // accounting still fires
        // Vendor notification waits for the promotion cron.
        expect(emitted).not.toContain(DomainEvents.ORDER_CREATED);
      });
    });
  });

  it('does NOT emit any order event synchronously from createOrder — vendor is unaware until payment confirms', async () => {
    // Payment-gated visibility (#178): the vendor must not see / be notified
    // about an unpaid order. createOrder is now a pure insert.
    prisma.vendor.findUnique.mockResolvedValue({
      id: 'v-1',
      status: VendorStatus.ACTIVE,
      isOpen: true,
    });
    prisma.item.findMany.mockResolvedValue([
      { id: 'i-1', name: 'X', priceXAF: 2000, isAvailable: true, isInStock: true },
      { id: 'i-2', name: 'Y', priceXAF: 500, isAvailable: true, isInStock: true },
    ]);
    await creation.createOrder('user-1', baseDto);
    expect(events.emit).not.toHaveBeenCalled();
  });

  describe('getOrderPublic (share-link safe view)', () => {
    it('returns only non-PII fields when order exists', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'o-1',
        code: 'TC-A23F4',
        status: OrderStatus.PICKED_UP,
        placedAt: new Date('2026-05-15T12:00:00Z'),
        acceptedAt: new Date('2026-05-15T12:02:00Z'),
        preparedAt: null,
        pickedUpAt: new Date('2026-05-15T12:18:00Z'),
        deliveredAt: null,
        cancelledAt: null,
        vendor: { name: 'Chez Maman Smoke' },
      });
      const result = await service.getOrderPublic('o-1');
      expect(result).toEqual({
        id: 'o-1',
        code: 'TC-A23F4',
        status: OrderStatus.PICKED_UP,
        placedAt: expect.any(Date),
        acceptedAt: expect.any(Date),
        preparedAt: null,
        pickedUpAt: expect.any(Date),
        deliveredAt: null,
        cancelledAt: null,
        vendor: { name: 'Chez Maman Smoke' },
      });
      // Confirm the prisma select narrows the fetch — no PII columns requested.
      const selectArg = prisma.order.findUnique.mock.calls[0][0].select;
      expect(selectArg).not.toHaveProperty('userId');
      expect(selectArg).not.toHaveProperty('deliveryPhone');
      expect(selectArg).not.toHaveProperty('deliveryCode');
      expect(selectArg).not.toHaveProperty('pickupCode');
      expect(selectArg).not.toHaveProperty('paymentReference');
      expect(selectArg.vendor.select).toEqual({ name: true });
    });

    it('throws 404 when order id is unknown', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.getOrderPublic('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setItemPrepared', () => {
    function setup(orderStatus: OrderStatus, itemsAfterUpdate: Array<{ preparedAt: Date | null }>) {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        vendorId: 'v-1',
        status: orderStatus,
      });
      prisma.orderItem.findUnique.mockResolvedValue({ id: 'oi-1', orderId: 'order-1' });
      prisma.orderItem.findMany.mockResolvedValue(itemsAfterUpdate);
    }

    it('first prepared item flips ACCEPTED → IN_PREP', async () => {
      setup(OrderStatus.ACCEPTED, [{ preparedAt: new Date() }, { preparedAt: null }]);
      const result = await vendorActions.setItemPrepared('order-1', 'oi-1', 'user-1', true);
      expect(result.status).toBe(OrderStatus.IN_PREP);
      expect(result.preparedAt).toBeInstanceOf(Date);
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: OrderStatus.IN_PREP } }),
      );
    });

    it('last unprepared toggle flips IN_PREP → ACCEPTED', async () => {
      setup(OrderStatus.IN_PREP, [{ preparedAt: null }, { preparedAt: null }]);
      const result = await vendorActions.setItemPrepared('order-1', 'oi-1', 'user-1', false);
      expect(result.status).toBe(OrderStatus.ACCEPTED);
      expect(result.preparedAt).toBeNull();
    });

    it('keeps IN_PREP when only some items are prepared', async () => {
      setup(OrderStatus.IN_PREP, [{ preparedAt: new Date() }, { preparedAt: null }]);
      const result = await vendorActions.setItemPrepared('order-1', 'oi-1', 'user-1', true);
      expect(result.status).toBe(OrderStatus.IN_PREP);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('refuses when order has already moved past the preparation phase', async () => {
      setup(OrderStatus.READY_PICKUP, []);
      await expect(
        vendorActions.setItemPrepared('order-1', 'oi-1', 'user-1', true),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'order_not_in_prep_phase' }),
      });
    });

    it('refuses an item that belongs to another order (no cross-tenant leak)', async () => {
      setup(OrderStatus.IN_PREP, []);
      prisma.orderItem.findUnique.mockResolvedValue({ id: 'oi-1', orderId: 'order-other' });
      await expect(
        vendorActions.setItemPrepared('order-1', 'oi-1', 'user-1', true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('markOrderReady', () => {
    function setup(orderStatus: OrderStatus, items: Array<{ preparedAt: Date | null }>) {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        vendorId: 'v-1',
        status: orderStatus,
      });
      prisma.orderItem.findMany.mockResolvedValue(items);
    }

    it('flips to READY_PICKUP + emits ORDER_READY when every item is prepared', async () => {
      setup(OrderStatus.IN_PREP, [{ preparedAt: new Date() }, { preparedAt: new Date() }]);
      const result = await vendorActions.markOrderReady('order-1', 'user-1');
      expect(result.status).toBe(OrderStatus.READY_PICKUP);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order-1',
          status: { in: [OrderStatus.ACCEPTED, OrderStatus.IN_PREP] },
        },
        data: { status: OrderStatus.READY_PICKUP, preparedAt: expect.any(Date) },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.ORDER_READY,
        expect.objectContaining({ orderId: 'order-1', vendorId: 'v-1' }),
      );
    });

    it('refuses when at least one item is still unprepared', async () => {
      setup(OrderStatus.IN_PREP, [{ preparedAt: new Date() }, { preparedAt: null }]);
      await expect(vendorActions.markOrderReady('order-1', 'user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'items_not_all_prepared' }),
      });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('refuses when order is no longer in the preparation phase', async () => {
      setup(OrderStatus.READY_PICKUP, [{ preparedAt: new Date() }]);
      await expect(vendorActions.markOrderReady('order-1', 'user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'order_not_in_prep_phase' }),
      });
    });

    it('throws order_state_changed when status flipped between read and update', async () => {
      setup(OrderStatus.IN_PREP, [{ preparedAt: new Date() }]);
      // The pre-check passed (status was IN_PREP), then something flipped it
      // — e.g. an admin cancellation. updateMany matches zero rows.
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(vendorActions.markOrderReady('order-1', 'user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'order_state_changed' }),
      });
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
