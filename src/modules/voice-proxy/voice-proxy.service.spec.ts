import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { VoiceProxyService } from './voice-proxy.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

describe('VoiceProxyService', () => {
  let service: VoiceProxyService;
  let prisma: {
    order: { findUnique: jest.Mock };
    rider: { findUnique: jest.Mock };
  };
  let twilio: { startBridgedCall: jest.Mock };
  let env: { appUrl: string; twilio: { voiceFrom?: string } };

  beforeEach(async () => {
    prisma = { order: { findUnique: jest.fn() }, rider: { findUnique: jest.fn() } };
    twilio = { startBridgedCall: jest.fn().mockResolvedValue('CA_test_sid') };
    env = { appUrl: 'https://api.chopnow.app', twilio: { voiceFrom: '+14155238886' } };

    const module = await Test.createTestingModule({
      providers: [
        VoiceProxyService,
        pinoLoggerProvider(VoiceProxyService.name),
        { provide: PrismaService, useValue: prisma },
        { provide: TwilioService, useValue: twilio },
        { provide: EnvService, useValue: env },
      ],
    }).compile();
    service = module.get(VoiceProxyService);
  });

  describe('startRiderToConsumer', () => {
    function eligible(status: OrderStatus = OrderStatus.PICKED_UP) {
      prisma.rider.findUnique.mockResolvedValue({
        id: 'r-1',
        user: { phone: '+237670000111' },
      });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        riderId: 'r-1',
        status,
        deliveryPhone: '670000222',
      });
    }

    it('asks Twilio to dial the rider with the bridge URL', async () => {
      eligible();
      const result = await service.startRiderToConsumer('order-1', 'user-rider');
      expect(twilio.startBridgedCall).toHaveBeenCalledWith(
        '+237670000111',
        'https://api.chopnow.app/api/webhooks/twilio/voice/bridge?orderId=order-1&to=consumer',
      );
      expect(result).toEqual({ callSid: 'CA_test_sid' });
    });

    it.each([
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PREP,
      OrderStatus.READY_PICKUP,
      OrderStatus.PICKED_UP,
    ])('allows status %s', async (status) => {
      eligible(status);
      await expect(service.startRiderToConsumer('order-1', 'user-rider')).resolves.toBeDefined();
    });

    it.each([OrderStatus.PENDING, OrderStatus.DELIVERED, OrderStatus.CANCELLED])(
      'rejects status %s (no calls before pickup or after drop-off)',
      async (status) => {
        eligible(status);
        await expect(service.startRiderToConsumer('order-1', 'user-rider')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(twilio.startBridgedCall).not.toHaveBeenCalled();
      },
    );

    it('returns 404 when the caller is not the assigned rider', async () => {
      prisma.rider.findUnique.mockResolvedValue({ id: 'r-1', user: { phone: '+237670000111' } });
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        riderId: 'r-OTHER',
        status: OrderStatus.PICKED_UP,
        deliveryPhone: '670000222',
      });
      await expect(service.startRiderToConsumer('order-1', 'user-rider')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('buildBridgeTwiml', () => {
    it('returns Dial TwiML when the order is eligible', async () => {
      prisma.order.findUnique.mockResolvedValue({
        deliveryPhone: '670000222',
        status: OrderStatus.PICKED_UP,
        vendor: { whatsappPhone: '+237670000333' },
        rider: { user: { phone: '+237670000444' } },
      });
      const xml = await service.buildBridgeTwiml('order-1', 'consumer');
      expect(xml).toContain('<Response>');
      expect(xml).toContain('<Dial callerId="+14155238886"');
      expect(xml).toContain('<Number>+237670000222</Number>');
      // timeLimit slightly under the 180s cap to give buffer for connection
      expect(xml).toMatch(/timeLimit="\d+"/);
    });

    it('returns Hangup TwiML when the order is no longer eligible', async () => {
      prisma.order.findUnique.mockResolvedValue({
        deliveryPhone: '670000222',
        status: OrderStatus.DELIVERED,
        vendor: { whatsappPhone: '+237670000333' },
        rider: null,
      });
      const xml = await service.buildBridgeTwiml('order-1', 'consumer');
      expect(xml).toContain('<Hangup/>');
      expect(xml).not.toContain('<Dial');
    });

    it('handles unknown order id without leaking', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      const xml = await service.buildBridgeTwiml('nope', 'consumer');
      expect(xml).toContain('<Hangup/>');
    });

    it('dials the vendor when target=vendor', async () => {
      prisma.order.findUnique.mockResolvedValue({
        status: OrderStatus.IN_PREP,
        deliveryPhone: '670000222',
        vendor: { whatsappPhone: '+237670000333' },
        rider: null,
      });
      const xml = await service.buildBridgeTwiml('order-1', 'vendor');
      expect(xml).toContain('<Number>+237670000333</Number>');
      expect(xml).toContain('restaurant');
    });

    it('dials the rider when target=rider', async () => {
      prisma.order.findUnique.mockResolvedValue({
        status: OrderStatus.PICKED_UP,
        deliveryPhone: '670000222',
        vendor: { whatsappPhone: '+237670000333' },
        rider: { user: { phone: '+237670000444' } },
      });
      const xml = await service.buildBridgeTwiml('order-1', 'rider');
      expect(xml).toContain('<Number>+237670000444</Number>');
      expect(xml).toContain('livreur');
    });

    it('hangs up if the target has no number assigned (e.g. unassigned rider)', async () => {
      prisma.order.findUnique.mockResolvedValue({
        status: OrderStatus.IN_PREP,
        deliveryPhone: '670000222',
        vendor: { whatsappPhone: '+237670000333' },
        rider: null,
      });
      const xml = await service.buildBridgeTwiml('order-1', 'rider');
      expect(xml).toContain('<Hangup/>');
      expect(xml).toContain('indisponible');
    });
  });
});
