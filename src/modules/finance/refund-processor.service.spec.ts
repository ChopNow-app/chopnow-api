import { Test } from '@nestjs/testing';
import { CampayService } from '../../infra/campay/campay.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { LedgerService } from './ledger.service';
import { RefundProcessorService } from './refund-processor.service';

describe('RefundProcessorService', () => {
  let service: RefundProcessorService;
  let prisma: {
    order: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let campay: { initiateRefund: jest.Mock };
  let ledger: { recordTransaction: jest.Mock };
  let env: { campay: { refundsEnabled: boolean } };

  beforeEach(async () => {
    prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };
    campay = {
      initiateRefund: jest
        .fn()
        .mockResolvedValue({ reference: 'campay-refund-1', status: 'PENDING' }),
    };
    ledger = { recordTransaction: jest.fn().mockResolvedValue(undefined) };
    env = { campay: { refundsEnabled: false } };

    const module = await Test.createTestingModule({
      providers: [
        RefundProcessorService,
        { provide: PrismaService, useValue: prisma },
        { provide: CampayService, useValue: campay },
        { provide: LedgerService, useValue: ledger },
        { provide: EnvService, useValue: env },
        pinoLoggerProvider(RefundProcessorService.name),
      ],
    }).compile();

    service = module.get(RefundProcessorService);
  });

  describe('manual fire mode (CAMPAY_REFUNDS_ENABLED=false)', () => {
    it('skips refunds without locking or calling Campay', async () => {
      prisma.order.findMany.mockResolvedValueOnce([
        { id: 'o-1', code: 'TC-1', totalXAF: 4900, payerPhone: '+237670000001' },
      ]);

      await service.sweepPendingRefunds();

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(campay.initiateRefund).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });
  });

  describe('refunds enabled', () => {
    beforeEach(() => {
      env.campay.refundsEnabled = true;
    });

    it('locks the order, calls Campay, persists refundCampayRef, and writes the release-escrow ledger pair', async () => {
      prisma.order.findMany.mockResolvedValueOnce([
        { id: 'o-1', code: 'TC-1', totalXAF: 4900, payerPhone: '+237670000001' },
      ]);

      await service.sweepPendingRefunds();

      // Lock: status-guarded updateMany stamping refundInitiatedAt
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'o-1',
          paymentStatus: 'REFUND_PENDING',
          refundInitiatedAt: null,
        },
        data: { refundInitiatedAt: expect.any(Date), refundFailureReason: null },
      });
      // Campay call
      expect(campay.initiateRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          amountXAF: 4900,
          toPhone: '+237670000001',
          externalReference: 'refund:o-1',
        }),
      );
      // Persisted ref
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o-1' },
        data: { refundCampayRef: 'campay-refund-1' },
      });
      // Ledger pair: CUSTOMER_ESCROW + / REFUND_PAYABLE −
      expect(ledger.recordTransaction).toHaveBeenCalledTimes(1);
      const [input] = ledger.recordTransaction.mock.calls[0];
      expect(input.eventId).toBe('refund_initiated:o-1');
      expect(input.eventType).toBe('REFUND_ISSUED');
      expect(input.entries).toEqual([
        expect.objectContaining({ account: 'CUSTOMER_ESCROW', amountXAF: 4900, orderId: 'o-1' }),
        expect.objectContaining({ account: 'REFUND_PAYABLE', amountXAF: -4900, orderId: 'o-1' }),
      ]);
    });

    it('rolls back the lock and records failureReason when Campay throws', async () => {
      prisma.order.findMany.mockResolvedValueOnce([
        { id: 'o-1', code: 'TC-1', totalXAF: 4900, payerPhone: '+237670000001' },
      ]);
      campay.initiateRefund.mockRejectedValueOnce(new Error('insufficient_balance'));

      await service.sweepPendingRefunds();

      // Lock cleared + failure reason captured
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o-1' },
        data: { refundInitiatedAt: null, refundFailureReason: 'insufficient_balance' },
      });
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    it('race_lost when updateMany returns 0 (another worker already locked)', async () => {
      prisma.order.findMany.mockResolvedValueOnce([
        { id: 'o-1', code: 'TC-1', totalXAF: 4900, payerPhone: '+237670000001' },
      ]);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.sweepPendingRefunds();

      expect(campay.initiateRefund).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    it('skips orders with no payerPhone and records failure reason for admin', async () => {
      prisma.order.findMany.mockResolvedValueOnce([
        { id: 'o-1', code: 'TC-1', totalXAF: 4900, payerPhone: null },
      ]);

      await service.sweepPendingRefunds();

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o-1' },
        data: { refundFailureReason: 'missing_payer_phone' },
      });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(campay.initiateRefund).not.toHaveBeenCalled();
    });

    it('one row failing does not break the batch', async () => {
      prisma.order.findMany.mockResolvedValueOnce([
        { id: 'o-1', code: 'TC-1', totalXAF: 4900, payerPhone: '+237670000001' },
        { id: 'o-2', code: 'TC-2', totalXAF: 3000, payerPhone: '+237670000002' },
      ]);
      campay.initiateRefund
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ reference: 'campay-refund-2', status: 'PENDING' });

      await service.sweepPendingRefunds();

      // o-1 failed (lock rolled back), o-2 succeeded
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o-1' },
        data: { refundInitiatedAt: null, refundFailureReason: 'timeout' },
      });
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o-2' },
        data: { refundCampayRef: 'campay-refund-2' },
      });
    });
  });
});
