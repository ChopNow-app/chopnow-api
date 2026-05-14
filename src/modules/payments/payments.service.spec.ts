import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { CampayService } from '../../infra/campay/campay.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { DomainEvents } from '../../shared/events/domain-events';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: { order: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock } };
  let campay: { initiateCollect: jest.Mock };
  let redis: { setNX: jest.Mock; del: jest.Mock };
  let events: { emit: jest.Mock };
  let env: { appUrl: string; campay: { apiUrl?: string } };

  beforeEach(async () => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    campay = {
      initiateCollect: jest
        .fn()
        .mockResolvedValue({ reference: 'campay-ref-1', status: 'PENDING' }),
    };
    redis = {
      setNX: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(1),
    };
    events = { emit: jest.fn() };
    env = { appUrl: 'https://api.chopnow.app', campay: { apiUrl: 'https://demo.campay.net/api' } };

    const module = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CampayService, useValue: campay },
        { provide: RedisService, useValue: redis },
        { provide: EventEmitter2, useValue: events },
        { provide: EnvService, useValue: env },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  describe('initiateMomo', () => {
    function payableOrder(method = PaymentMethod.MTN_MOMO) {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        code: 'TC-AB12C',
        totalXAF: 3500,
        status: OrderStatus.PENDING,
        paymentMethod: method,
        paymentStatus: PaymentStatus.PENDING,
      });
    }

    it('calls Campay collect and flips paymentStatus to PROCESSING', async () => {
      payableOrder();
      const result = await service.initiateMomo('order-1', 'user-1', '670000000');

      expect(campay.initiateCollect).toHaveBeenCalledWith(
        expect.objectContaining({
          amountXAF: 3500,
          payerPhone: '+237670000000',
          externalReference: 'TC-AB12C',
          webhookUrl: 'https://api.chopnow.app/api/webhooks/campay',
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: {
          paymentReference: 'campay-ref-1',
          payerPhone: '+237670000000',
          paymentStatus: PaymentStatus.PROCESSING,
        },
      });
      expect(result).toEqual({
        reference: 'campay-ref-1',
        status: 'PENDING',
        message: expect.stringMatching(/Validez/i),
      });
    });

    it('rejects when order is not MoMo (cash)', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        paymentMethod: PaymentMethod.CASH,
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
      });
      await expect(service.initiateMomo('order-1', 'user-1', '670000000')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(campay.initiateCollect).not.toHaveBeenCalled();
    });

    it('rejects when order is no longer PENDING', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        paymentMethod: PaymentMethod.MTN_MOMO,
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.PENDING,
      });
      await expect(service.initiateMomo('order-1', 'user-1', '670000000')).rejects.toMatchObject({
        response: { code: 'order_not_payable' },
      });
    });

    it('rejects when a payment is already PROCESSING', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'user-1',
        paymentMethod: PaymentMethod.MTN_MOMO,
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PROCESSING,
      });
      await expect(service.initiateMomo('order-1', 'user-1', '670000000')).rejects.toMatchObject({
        response: { code: 'payment_already_processing' },
      });
    });

    it('rejects when the Redis re-entry lock is held (double-click)', async () => {
      payableOrder();
      redis.setNX.mockResolvedValueOnce(false);
      await expect(service.initiateMomo('order-1', 'user-1', '670000000')).rejects.toMatchObject({
        response: { code: 'payment_already_processing' },
      });
      expect(campay.initiateCollect).not.toHaveBeenCalled();
    });

    it('frees the lock if Campay throws so the user can retry', async () => {
      payableOrder();
      campay.initiateCollect.mockRejectedValueOnce(new Error('campay_http_502'));
      await expect(service.initiateMomo('order-1', 'user-1', '670000000')).rejects.toThrow(
        'campay_http_502',
      );
      expect(redis.del).toHaveBeenCalledWith('pay:order:order-1');
    });

    it('returns 404 when order belongs to a different user', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        userId: 'someone-else',
        paymentMethod: PaymentMethod.MTN_MOMO,
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
      });
      await expect(service.initiateMomo('order-1', 'user-1', '670000000')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('handleWebhook', () => {
    it('emits payment.succeeded on SUCCESSFUL', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'order-1',
        code: 'TC-AB12C',
        paymentStatus: PaymentStatus.PROCESSING,
      });
      await service.handleWebhook({
        status: 'SUCCESSFUL',
        reference: 'TC-AB12C',
        phone_number: '+237670000000',
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.PAYMENT_SUCCEEDED,
        expect.objectContaining({ orderId: 'order-1', providerReference: 'TC-AB12C' }),
      );
    });

    it('skips when the redis lock is already held (duplicate webhook < 100ms)', async () => {
      redis.setNX.mockResolvedValueOnce(false);
      const result = await service.handleWebhook({ status: 'SUCCESSFUL', reference: 'TC-AB12C' });
      expect(result).toEqual({ received: true });
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('no-ops when reference is unknown', async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      await service.handleWebhook({ status: 'SUCCESSFUL', reference: 'TC-UNKNOWN' });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('marks the order FAILED on FAILED status', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'order-1',
        paymentStatus: PaymentStatus.PROCESSING,
      });
      await service.handleWebhook({ status: 'FAILED', reference: 'TC-AB12C' });
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { paymentStatus: PaymentStatus.FAILED },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DomainEvents.PAYMENT_FAILED,
        expect.objectContaining({ orderId: 'order-1', reason: 'FAILED' }),
      );
    });

    it('does NOT flip an already-PAID order on a stale FAILED webhook', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'order-1',
        paymentStatus: PaymentStatus.PAID,
      });
      await service.handleWebhook({ status: 'FAILED', reference: 'TC-AB12C' });
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('returns 200 for a webhook missing reference (no retry storm)', async () => {
      const result = await service.handleWebhook({ status: 'SUCCESSFUL' });
      expect(result).toEqual({ received: true });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('ignores PENDING status (Campay sends those during USSD flow)', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'order-1',
        paymentStatus: PaymentStatus.PROCESSING,
      });
      await service.handleWebhook({ status: 'PENDING', reference: 'TC-AB12C' });
      expect(events.emit).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });
});
