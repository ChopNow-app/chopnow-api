import { Test } from '@nestjs/testing';
import { CampayService } from '../../infra/campay/campay.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { PayoutTransferWorker } from './payout-transfer-worker.service';

describe('PayoutTransferWorker', () => {
  let service: PayoutTransferWorker;
  let prisma: {
    vendorPayout: { findMany: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
    riderPayout: { findMany: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
  };
  let campay: { initiateTransfer: jest.Mock };
  let env: { campay: { transfersEnabled: boolean } };

  beforeEach(async () => {
    prisma = {
      vendorPayout: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      riderPayout: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    campay = {
      initiateTransfer: jest
        .fn()
        .mockResolvedValue({ reference: 'campay-tx-1', status: 'PENDING' }),
    };
    env = { campay: { transfersEnabled: false } };

    const module = await Test.createTestingModule({
      providers: [
        PayoutTransferWorker,
        { provide: PrismaService, useValue: prisma },
        { provide: CampayService, useValue: campay },
        { provide: EnvService, useValue: env },
        pinoLoggerProvider(PayoutTransferWorker.name),
      ],
    }).compile();

    service = module.get(PayoutTransferWorker);
  });

  describe('sweepPendingTransfers (manual fire mode — CAMPAY_TRANSFERS_ENABLED=false)', () => {
    it('skips every PENDING payout without locking when transfers are disabled', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        { id: 'v-payout-1', momoPhone: '+237670000001', netXAF: 4230 },
      ]);
      prisma.riderPayout.findMany.mockResolvedValueOnce([
        { id: 'r-payout-1', momoPhone: '+237670000002', netXAF: 1560 },
      ]);

      await service.sweepPendingTransfers();

      // No status flips, no Campay calls.
      expect(prisma.vendorPayout.updateMany).not.toHaveBeenCalled();
      expect(prisma.riderPayout.updateMany).not.toHaveBeenCalled();
      expect(campay.initiateTransfer).not.toHaveBeenCalled();
    });
  });

  describe('sweepPendingTransfers (transfers enabled)', () => {
    beforeEach(() => {
      env.campay.transfersEnabled = true;
    });

    it('flips PENDING → IN_FLIGHT, fires the Campay transfer, and persists campayRef on success', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        { id: 'v-payout-1', momoPhone: '+237670000001', netXAF: 4230 },
      ]);

      await service.sweepPendingTransfers();

      // Status guard
      expect(prisma.vendorPayout.updateMany).toHaveBeenCalledWith({
        where: { id: 'v-payout-1', status: 'PENDING' },
        data: { status: 'IN_FLIGHT', sentAt: expect.any(Date) },
      });
      // Campay call
      expect(campay.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amountXAF: 4230,
          toPhone: '+237670000001',
          externalReference: 'vendor_payout:v-payout-1',
        }),
      );
      // Reference persisted
      expect(prisma.vendorPayout.update).toHaveBeenCalledWith({
        where: { id: 'v-payout-1' },
        data: { campayRef: 'campay-tx-1' },
      });
    });

    it('marks payout FAILED when Campay throws', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        { id: 'v-payout-1', momoPhone: '+237670000001', netXAF: 4230 },
      ]);
      campay.initiateTransfer.mockRejectedValueOnce(new Error('insufficient_balance'));

      await service.sweepPendingTransfers();

      expect(prisma.vendorPayout.update).toHaveBeenCalledWith({
        where: { id: 'v-payout-1' },
        data: { status: 'FAILED', failureReason: 'insufficient_balance' },
      });
    });

    it('race_lost when updateMany matches zero (another worker already locked the row)', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        { id: 'v-payout-1', momoPhone: '+237670000001', netXAF: 4230 },
      ]);
      prisma.vendorPayout.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.sweepPendingTransfers();

      // Lock attempt counted but Campay never called.
      expect(campay.initiateTransfer).not.toHaveBeenCalled();
      expect(prisma.vendorPayout.update).not.toHaveBeenCalled();
    });

    it('processes vendor + rider payouts in the same run', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        { id: 'v-payout-1', momoPhone: '+237670000001', netXAF: 4230 },
      ]);
      prisma.riderPayout.findMany.mockResolvedValueOnce([
        { id: 'r-payout-1', momoPhone: '+237670000002', netXAF: 1560 },
      ]);

      await service.sweepPendingTransfers();

      expect(campay.initiateTransfer).toHaveBeenCalledTimes(2);
      const calls = campay.initiateTransfer.mock.calls.map(
        (c: [{ externalReference: string }]) => c[0].externalReference,
      );
      expect(calls).toContain('vendor_payout:v-payout-1');
      expect(calls).toContain('rider_payout:r-payout-1');
    });

    it('one row failing does not break the batch', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        { id: 'v-1', momoPhone: '+237670000001', netXAF: 4230 },
        { id: 'v-2', momoPhone: '+237670000002', netXAF: 2500 },
      ]);
      campay.initiateTransfer
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ reference: 'campay-tx-2', status: 'PENDING' });

      await service.sweepPendingTransfers();

      // v-1 failed, v-2 succeeded
      expect(prisma.vendorPayout.update).toHaveBeenCalledWith({
        where: { id: 'v-1' },
        data: { status: 'FAILED', failureReason: 'timeout' },
      });
      expect(prisma.vendorPayout.update).toHaveBeenCalledWith({
        where: { id: 'v-2' },
        data: { campayRef: 'campay-tx-2' },
      });
    });
  });
});
