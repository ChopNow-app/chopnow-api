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
    order: { findUnique: jest.Mock; findMany: jest.Mock; create: jest.Mock; update: jest.Mock };
    item: { findMany: jest.Mock };
    vendor: { findUnique: jest.Mock };
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
      },
      item: { findMany: jest.fn() },
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

    it('creates a PENDING order with server-computed totals and emits order.created', async () => {
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

      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.ORDER_CREATED,
        expect.objectContaining({ orderId: 'order-new', vendorId: 'v-1' }),
      );
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
  });

  describe('cancelOrder', () => {
    it('cancels a PENDING order and emits order.cancelled', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
      });

      await service.cancelOrder('order-1', 'user-1');

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { status: OrderStatus.CANCELLED, cancelledAt: expect.any(Date) },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.ORDER_CANCELLED,
        expect.objectContaining({ orderId: 'order-1', cancelledBy: 'consumer' }),
      );
    });

    it('refuses to cancel after vendor accepted', async () => {
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

    it('flips CONFIRMED → ACCEPTED + emits order.accepted', async () => {
      vendorOrder(OrderStatus.CONFIRMED);
      await service.acceptOrder('order-1', 'user-1');
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { status: OrderStatus.ACCEPTED, acceptedAt: expect.any(Date) },
      });
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.ORDER_ACCEPTED, expect.any(Object));
    });

    it('also accepts PENDING (cash flow) → ACCEPTED', async () => {
      vendorOrder(OrderStatus.PENDING);
      await service.acceptOrder('order-1', 'user-1');
      expect(prisma.order.update).toHaveBeenCalled();
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
  });

  describe('refuseOrder', () => {
    it('flips CONFIRMED → REFUSED with reason label', async () => {
      prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        vendorId: 'v-1',
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });

      await service.refuseOrder('order-1', 'user-1', {
        reason: RefusalReason.POWER_OUTAGE,
        note: 'Pas de courant depuis 30 min',
      });

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
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
    it('flips PENDING/CONFIRMED → CONFIRMED + PAID and emits order.paid', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        paymentStatus: PaymentStatus.PENDING,
        payerPhone: null,
      });
      prisma.order.update.mockResolvedValue({ id: 'order-1', paidAt: new Date() });

      await service.onPaymentSucceeded({
        orderId: 'order-1',
        providerReference: 'campay-123',
        payerPhone: '+237670000000',
      });

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: expect.objectContaining({
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          paymentReference: 'campay-123',
          payerPhone: '+237670000000',
        }),
      });
      expect(events.emit).toHaveBeenCalledWith(DomainEvents.ORDER_PAID, expect.any(Object));
    });

    it('is idempotent — a second call on an already PAID order is a no-op', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        paymentStatus: PaymentStatus.PAID,
      });

      await service.onPaymentSucceeded({ orderId: 'order-1', providerReference: 'campay-123' });

      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  it('does NOT emit order.paid handler synchronously from createOrder', async () => {
    // Guard against accidental coupling — order.created and order.paid are
    // separate signals.
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
    const emitted = events.emit.mock.calls.map((c) => c[0]);
    expect(emitted).toContain(DomainEvents.ORDER_CREATED);
    expect(emitted).not.toContain(DomainEvents.ORDER_PAID);
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
});
