import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { PrismaService } from '../prisma/prisma.service';
import { CampayWebhookDedupService } from './campay-webhook-dedup.service';

describe('CampayWebhookDedupService', () => {
  let service: CampayWebhookDedupService;
  let prisma: {
    campayWebhookEvent: {
      create: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      campayWebhookEvent: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        CampayWebhookDedupService,
        { provide: PrismaService, useValue: prisma },
        pinoLoggerProvider(CampayWebhookDedupService.name),
      ],
    }).compile();
    service = module.get(CampayWebhookDedupService);
  });

  describe('markProcessed', () => {
    it('returns isFirst=true and inserts the row when the (eventType, reference) is new', async () => {
      prisma.campayWebhookEvent.create.mockResolvedValueOnce({ id: 'e-1' });
      const r = await service.markProcessed({
        eventType: 'COLLECT',
        reference: 'campay-ref-1',
        payload: { status: 'SUCCESSFUL' },
      });
      expect(r).toEqual({ isFirst: true, existingResult: null });
      expect(prisma.campayWebhookEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'COLLECT',
          reference: 'campay-ref-1',
        }),
      });
    });

    it('returns isFirst=false on Prisma P2002 (unique violation) — duplicate webhook', async () => {
      const uniqueErr = new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      });
      prisma.campayWebhookEvent.create.mockRejectedValueOnce(uniqueErr);
      prisma.campayWebhookEvent.findUnique.mockResolvedValueOnce({
        result: 'order_paid_event_emitted',
        processedAt: new Date('2026-05-20T01:00:00Z'),
      });

      const r = await service.markProcessed({
        eventType: 'COLLECT',
        reference: 'campay-ref-1',
        payload: { status: 'SUCCESSFUL' },
      });

      expect(r).toEqual({ isFirst: false, existingResult: 'order_paid_event_emitted' });
    });

    it('rethrows non-P2002 errors (real database failures must not become silent no-ops)', async () => {
      prisma.campayWebhookEvent.create.mockRejectedValueOnce(new Error('connection refused'));
      await expect(
        service.markProcessed({
          eventType: 'TRANSFER',
          reference: 'campay-ref-2',
          payload: {},
        }),
      ).rejects.toThrow('connection refused');
    });
  });

  describe('recordResult', () => {
    it('updates the row only when result is currently null (best-effort, no-op on second call)', async () => {
      await service.recordResult({
        eventType: 'TRANSFER',
        reference: 'campay-ref-1',
        result: 'vendor_paid',
      });
      expect(prisma.campayWebhookEvent.updateMany).toHaveBeenCalledWith({
        where: { eventType: 'TRANSFER', reference: 'campay-ref-1', result: null },
        data: { result: 'vendor_paid' },
      });
    });

    it('swallows DB errors — never throws (best-effort audit)', async () => {
      prisma.campayWebhookEvent.updateMany.mockRejectedValueOnce(new Error('boom'));
      await expect(
        service.recordResult({ eventType: 'COLLECT', reference: 'campay-ref-1', result: 'x' }),
      ).resolves.toBeUndefined();
    });
  });
});
