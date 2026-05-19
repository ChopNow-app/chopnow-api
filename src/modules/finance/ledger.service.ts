import { ConflictException, Injectable } from '@nestjs/common';
import { LedgerAccount, LedgerEventType, Prisma } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';

// Per ADR-0005: append-only double-entry ledger. Every money movement is
// a single transaction with N entries that must sum to zero.
//
// Service-layer invariant — production code MUST always go through
// `recordTransaction`. Never write a single `ledger_entry` row directly.

export interface LedgerEntryInput {
  account: LedgerAccount;
  amountXAF: number;
  orderId?: string;
  vendorId?: string;
  riderId?: string;
  payoutId?: string;
  refundId?: string;
  description?: string;
}

export interface RecordTransactionInput {
  eventId: string;
  eventType: LedgerEventType;
  entries: LedgerEntryInput[];
}

@Injectable()
export class LedgerService {
  constructor(
    @InjectPinoLogger(LedgerService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  // Records a single double-entry transaction. All entries share the same
  // eventId and must sum to zero. Optionally runs inside an existing
  // Prisma transaction so a money move and its ledger trace commit (or
  // roll back) together.
  async recordTransaction(
    input: RecordTransactionInput,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    this.validate(input);

    const client = tx ?? this.prisma;
    await client.ledgerEntry.createMany({
      data: input.entries.map((entry) => ({
        eventId: input.eventId,
        eventType: input.eventType,
        account: entry.account,
        amountXAF: entry.amountXAF,
        orderId: entry.orderId ?? null,
        vendorId: entry.vendorId ?? null,
        riderId: entry.riderId ?? null,
        payoutId: entry.payoutId ?? null,
        refundId: entry.refundId ?? null,
        description: entry.description ?? null,
      })),
    });

    this.logger.debug(
      {
        event: 'ledger_entry_recorded',
        eventId: input.eventId,
        eventType: input.eventType,
        entryCount: input.entries.length,
      },
      'ledger transaction recorded',
    );
  }

  private validate(input: RecordTransactionInput): void {
    if (!input.eventId) {
      throw new ConflictException({
        code: 'ledger_event_id_required',
        message: 'eventId must be provided',
      });
    }
    if (input.entries.length < 2) {
      throw new ConflictException({
        code: 'ledger_too_few_entries',
        message: 'a transaction must have at least two entries (debit + credit)',
      });
    }

    let sum = 0;
    for (const entry of input.entries) {
      if (entry.amountXAF === 0) {
        throw new ConflictException({
          code: 'ledger_zero_amount',
          message: 'amountXAF must be non-zero',
        });
      }
      if (!Number.isInteger(entry.amountXAF)) {
        throw new ConflictException({
          code: 'ledger_non_integer_amount',
          message: 'amountXAF must be an integer (XAF has no decimals)',
        });
      }
      if (
        !entry.orderId &&
        !entry.vendorId &&
        !entry.riderId &&
        !entry.payoutId &&
        !entry.refundId
      ) {
        throw new ConflictException({
          code: 'ledger_entry_orphan',
          message:
            'each entry must reference at least one of: order, vendor, rider, payout, refund',
        });
      }
      if (input.eventType === LedgerEventType.ADJUSTMENT && !entry.description) {
        throw new ConflictException({
          code: 'ledger_adjustment_missing_description',
          message: 'ADJUSTMENT entries require a description',
        });
      }
      sum += entry.amountXAF;
    }

    if (sum !== 0) {
      throw new ConflictException({
        code: 'ledger_unbalanced',
        message: `entries must sum to zero (got ${sum})`,
      });
    }
  }
}
