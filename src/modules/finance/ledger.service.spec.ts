import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LedgerAccount, LedgerEventType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { LedgerService } from './ledger.service';

describe('LedgerService', () => {
  let service: LedgerService;
  let prisma: { ledgerEntry: { createMany: jest.Mock } };

  beforeEach(async () => {
    prisma = { ledgerEntry: { createMany: jest.fn().mockResolvedValue({ count: 0 }) } };

    const module = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: PrismaService, useValue: prisma },
        pinoLoggerProvider(LedgerService.name),
      ],
    }).compile();

    service = module.get(LedgerService);
  });

  it('records a balanced two-entry transaction', async () => {
    await service.recordTransaction({
      eventId: 'evt-1',
      eventType: LedgerEventType.PAYMENT_RECEIVED,
      entries: [
        { account: LedgerAccount.CAMPAY_FLOAT, amountXAF: 2000, orderId: 'order-1' },
        { account: LedgerAccount.CUSTOMER_ESCROW, amountXAF: -2000, orderId: 'order-1' },
      ],
    });

    expect(prisma.ledgerEntry.createMany).toHaveBeenCalledTimes(1);
    const payload = prisma.ledgerEntry.createMany.mock.calls[0][0];
    expect(payload.data).toHaveLength(2);
    expect(payload.data[0]).toMatchObject({
      eventId: 'evt-1',
      eventType: LedgerEventType.PAYMENT_RECEIVED,
      account: LedgerAccount.CAMPAY_FLOAT,
      amountXAF: 2000,
    });
  });

  it('rejects unbalanced entries with ledger_unbalanced', async () => {
    await expect(
      service.recordTransaction({
        eventId: 'evt-2',
        eventType: LedgerEventType.PAYMENT_RECEIVED,
        entries: [
          { account: LedgerAccount.CAMPAY_FLOAT, amountXAF: 2000, orderId: 'order-2' },
          { account: LedgerAccount.CUSTOMER_ESCROW, amountXAF: -1500, orderId: 'order-2' },
        ],
      }),
    ).rejects.toMatchObject({
      response: { code: 'ledger_unbalanced' },
    });

    expect(prisma.ledgerEntry.createMany).not.toHaveBeenCalled();
  });

  it('rejects zero-amount entries', async () => {
    await expect(
      service.recordTransaction({
        eventId: 'evt-3',
        eventType: LedgerEventType.PAYMENT_RECEIVED,
        entries: [
          { account: LedgerAccount.CAMPAY_FLOAT, amountXAF: 0, orderId: 'order-3' },
          { account: LedgerAccount.CUSTOMER_ESCROW, amountXAF: 0, orderId: 'order-3' },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'ledger_zero_amount' } });
  });

  it('rejects fewer than two entries', async () => {
    await expect(
      service.recordTransaction({
        eventId: 'evt-4',
        eventType: LedgerEventType.PAYMENT_RECEIVED,
        entries: [{ account: LedgerAccount.CAMPAY_FLOAT, amountXAF: 1000, orderId: 'order-4' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects entries with no FK reference', async () => {
    await expect(
      service.recordTransaction({
        eventId: 'evt-5',
        eventType: LedgerEventType.ADJUSTMENT,
        entries: [
          {
            account: LedgerAccount.PLATFORM_REVENUE,
            amountXAF: 500,
            description: 'fee correction',
          },
          {
            account: LedgerAccount.PLATFORM_RESERVE,
            amountXAF: -500,
            description: 'fee correction',
          },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'ledger_entry_orphan' } });
  });

  it('requires description on ADJUSTMENT entries', async () => {
    await expect(
      service.recordTransaction({
        eventId: 'evt-6',
        eventType: LedgerEventType.ADJUSTMENT,
        entries: [
          { account: LedgerAccount.PLATFORM_REVENUE, amountXAF: 500, vendorId: 'v-1' },
          { account: LedgerAccount.VENDOR_PAYABLE, amountXAF: -500, vendorId: 'v-1' },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'ledger_adjustment_missing_description' } });
  });

  it('rejects non-integer amounts', async () => {
    await expect(
      service.recordTransaction({
        eventId: 'evt-7',
        eventType: LedgerEventType.PAYMENT_RECEIVED,
        entries: [
          { account: LedgerAccount.CAMPAY_FLOAT, amountXAF: 100.5, orderId: 'order-7' },
          { account: LedgerAccount.CUSTOMER_ESCROW, amountXAF: -100.5, orderId: 'order-7' },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'ledger_non_integer_amount' } });
  });

  it('records a balanced multi-leg transaction (payout settlement)', async () => {
    // PAYMENT_RECEIVED earlier put 2000 into CUSTOMER_ESCROW.
    // ORDER_DELIVERED moves it: 1500 to vendor, 300 to rider, 200 to platform.
    await service.recordTransaction({
      eventId: 'evt-delivered',
      eventType: LedgerEventType.ORDER_DELIVERED,
      entries: [
        { account: LedgerAccount.CUSTOMER_ESCROW, amountXAF: 2000, orderId: 'order-8' },
        {
          account: LedgerAccount.VENDOR_PAYABLE,
          amountXAF: -1500,
          orderId: 'order-8',
          vendorId: 'v-1',
        },
        {
          account: LedgerAccount.RIDER_PAYABLE,
          amountXAF: -300,
          orderId: 'order-8',
          riderId: 'r-1',
        },
        { account: LedgerAccount.PLATFORM_REVENUE, amountXAF: -200, orderId: 'order-8' },
      ],
    });

    expect(prisma.ledgerEntry.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.ledgerEntry.createMany.mock.calls[0][0].data).toHaveLength(4);
  });
});
