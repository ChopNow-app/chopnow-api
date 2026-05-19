import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentMethod, PaymentStatus, VendorStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { RefusalReason } from './dto/vendor-decision.dto';
import { DomainEvents } from '../../shared/events/domain-events';

describe('OrdersService', () => {
  let service: OrdersService;
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
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let events: { emit: jest.Mock };

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
      $queryRaw: jest.fn().mockResolvedValue([{ distance_m: 1500 }]), // 1.5 km
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };
    events = { emit: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = module.get(OrdersService);
  });

  describe('createOrder', () => {
    function readyHappyPath() {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.ACTIVE,
        isOpen: true,
      });
      prisma.item.findMany.mockResolvedValue([
        { id: 'i-1', name: 'Ndolé', priceXAF: 2000, isAvailable: true, isInStock: true },
        { id: 'i-2', name: 'Bissap', priceXAF: 500, isAvailable: true, isInStock: true },
      ]);
    }

    it('creates a PENDING order with server-computed totals — vendor not yet notified', async () => {
      readyHappyPath();

      const order = await service.createOrder('user-1', baseDto);

      // Subtotal = 2*2000 + 1*500 = 4500
      // Fee: 1.5km → 250 + 150 = 400 (multiple of 50, above 350 floor)
      // Total = 4900
      expect(order.subtotalXAF).toBe(4500);
      expect(order.deliveryFeeXAF).toBe(400);
      expect(order.totalXAF).toBe(4900);
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
      await service.createOrder('user-1', baseDto);
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
        service.createOrder('user-1', { ...baseDto, items: [{ itemId: 'i-1', quantity: 1 }] }),
      ).rejects.toMatchObject({ response: { code: 'order_below_minimum' } });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('rejects when vendor is not ACTIVE', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.PENDING_REVIEW,
        isOpen: true,
      });
      await expect(service.createOrder('user-1', baseDto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects when vendor is closed (just toggled offline)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        status: VendorStatus.ACTIVE,
        isOpen: false,
      });
      await expect(service.createOrder('user-1', baseDto)).rejects.toMatchObject({
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

      await expect(service.createOrder('user-1', baseDto)).rejects.toBeInstanceOf(
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
      await expect(service.createOrder('user-1', baseDto)).rejects.toMatchObject({
        response: { code: 'item_out_of_stock' },
      });
    });

    it('short-circuits on idempotency key — returns the existing order', async () => {
      const existing = { id: 'order-existing', items: [] };
      prisma.order.findUnique.mockResolvedValue(existing);

      const result = await service.createOrder('user-1', baseDto, 'client-uuid-123');

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
        const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

        await service.createOrder('user-1', baseDto);

        const flippedWarn = warnSpy.mock.calls.find((c) =>
          String(c[0]).includes('item-availability flip race'),
        );
        expect(flippedWarn).toBeDefined();
        const msg = String(flippedWarn?.[0]);
        expect(msg).toContain('Ndolé'); // the flipped one
        expect(msg).not.toContain('Bissap'); // legitimately stale updatedAt — ignored
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
        const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

        await service.createOrder('user-1', baseDto);

        const flippedWarn = warnSpy.mock.calls.find((c) =>
          String(c[0]).includes('item-availability flip race'),
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

        await expect(service.createOrder('user-1', baseDto)).resolves.toBeDefined();
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
      await service.acceptOrder('order-1', 'user-1');
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
      await service.acceptOrder('order-1', 'user-1');
      expect(prisma.order.updateMany).toHaveBeenCalled();
    });

    it('refuses when order is already in a non-decidable state', async () => {
      vendorOrder(OrderStatus.READY_PICKUP);
      await expect(service.acceptOrder('order-1', 'user-1')).rejects.toMatchObject({
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
      await expect(service.acceptOrder('order-1', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws order_state_changed when the cron flipped status between read and write', async () => {
      vendorOrder(OrderStatus.CONFIRMED);
      // Simulate the sub-100ms race: requireVendorOrder() read PENDING/CONFIRMED,
      // then between that read and our updateMany the cron transitioned the
      // row to REFUSED. updateMany matches zero rows.
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.acceptOrder('order-1', 'user-1')).rejects.toMatchObject({
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

      await service.refuseOrder('order-1', 'user-1', {
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
        service.refuseOrder('order-1', 'user-1', { reason: RefusalReason.CLOSED }),
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
    function pendingOrder() {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        code: 'TC-ABCDE',
        vendorId: 'v-1',
        userId: 'user-1',
        paymentMethod: PaymentMethod.MTN_MOMO,
        paymentStatus: PaymentStatus.PENDING,
        payerPhone: null,
      });
    }

    it('flips PENDING → CONFIRMED + PAID with status-guarded updateMany and 60s acceptance deadline', async () => {
      pendingOrder();

      await service.onPaymentSucceeded({
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
      await service.onPaymentSucceeded({ orderId: 'order-1', providerReference: 'campay-123' });
      const emitted = events.emit.mock.calls.map((c) => c[0]);
      expect(emitted).toContain(DomainEvents.ORDER_PAID);
      expect(emitted).toContain(DomainEvents.ORDER_CREATED);
    });

    it('is idempotent — a second call on an already PAID order is a no-op', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        paymentStatus: PaymentStatus.PAID,
      });

      await service.onPaymentSucceeded({ orderId: 'order-1', providerReference: 'campay-123' });

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('lost-race short-circuit — updateMany matches zero rows, NO events emitted (#172)', async () => {
      pendingOrder();
      // Concurrent Campay-retried webhook already flipped this row PAID
      // between findUnique and updateMany. Our update matches zero rows.
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.onPaymentSucceeded({ orderId: 'order-1', providerReference: 'campay-123' });

      // Critical: NO event must fire — the other webhook already emitted
      // ORDER_PAID + ORDER_CREATED. Double-emit would double-notify the
      // vendor (push + WhatsApp twice).
      expect(events.emit).not.toHaveBeenCalled();
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
    await service.createOrder('user-1', baseDto);
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
      const result = await service.setItemPrepared('order-1', 'oi-1', 'user-1', true);
      expect(result.status).toBe(OrderStatus.IN_PREP);
      expect(result.preparedAt).toBeInstanceOf(Date);
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: OrderStatus.IN_PREP } }),
      );
    });

    it('last unprepared toggle flips IN_PREP → ACCEPTED', async () => {
      setup(OrderStatus.IN_PREP, [{ preparedAt: null }, { preparedAt: null }]);
      const result = await service.setItemPrepared('order-1', 'oi-1', 'user-1', false);
      expect(result.status).toBe(OrderStatus.ACCEPTED);
      expect(result.preparedAt).toBeNull();
    });

    it('keeps IN_PREP when only some items are prepared', async () => {
      setup(OrderStatus.IN_PREP, [{ preparedAt: new Date() }, { preparedAt: null }]);
      const result = await service.setItemPrepared('order-1', 'oi-1', 'user-1', true);
      expect(result.status).toBe(OrderStatus.IN_PREP);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('refuses when order has already moved past the preparation phase', async () => {
      setup(OrderStatus.READY_PICKUP, []);
      await expect(
        service.setItemPrepared('order-1', 'oi-1', 'user-1', true),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'order_not_in_prep_phase' }),
      });
    });

    it('refuses an item that belongs to another order (no cross-tenant leak)', async () => {
      setup(OrderStatus.IN_PREP, []);
      prisma.orderItem.findUnique.mockResolvedValue({ id: 'oi-1', orderId: 'order-other' });
      await expect(
        service.setItemPrepared('order-1', 'oi-1', 'user-1', true),
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
      const result = await service.markOrderReady('order-1', 'user-1');
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
      await expect(service.markOrderReady('order-1', 'user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'items_not_all_prepared' }),
      });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('refuses when order is no longer in the preparation phase', async () => {
      setup(OrderStatus.READY_PICKUP, [{ preparedAt: new Date() }]);
      await expect(service.markOrderReady('order-1', 'user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'order_not_in_prep_phase' }),
      });
    });

    it('throws order_state_changed when status flipped between read and update', async () => {
      setup(OrderStatus.IN_PREP, [{ preparedAt: new Date() }]);
      // The pre-check passed (status was IN_PREP), then something flipped it
      // — e.g. an admin cancellation. updateMany matches zero rows.
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.markOrderReady('order-1', 'user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'order_state_changed' }),
      });
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
