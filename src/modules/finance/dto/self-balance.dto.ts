import { ApiProperty } from '@nestjs/swagger';
import { PayoutStatus, VendorType } from '@prisma/client';

export class PayoutSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ format: 'date-time' })
  periodStart!: string;

  @ApiProperty({ format: 'date-time' })
  periodEnd!: string;

  @ApiProperty()
  netXAF!: number;

  @ApiProperty({ enum: PayoutStatus })
  status!: PayoutStatus;

  @ApiProperty({ format: 'date-time', nullable: true })
  paidAt!: string | null;
}

export type PayoutCadence = 'WEEKLY_SUNDAY' | 'DAILY_MORNING' | 'ON_DEMAND';

export class NextScheduledPayoutDto {
  @ApiProperty({ enum: ['WEEKLY_SUNDAY', 'DAILY_MORNING', 'ON_DEMAND'] })
  cadence!: PayoutCadence;

  // null for ON_DEMAND vendors (INFORMAL) — they trigger via cashout request,
  // or for any payout type when balance is zero (nothing scheduled).
  @ApiProperty({ format: 'date-time', nullable: true })
  estimatedAt!: string | null;
}

export class VendorSelfBalanceDto {
  @ApiProperty()
  balanceXAF!: number;

  // INFORMAL vendors with isTrusted=true get same-day cashout approval;
  // otherwise admin queues a 24h hold. Surfaced so the vendor knows whether
  // their "Demander un virement" CTA will land instantly or after review.
  @ApiProperty()
  isTrusted!: boolean;

  @ApiProperty({ enum: VendorType })
  vendorType!: VendorType;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastPayoutAt!: string | null;

  @ApiProperty({ nullable: true })
  lastPayoutXAF!: number | null;

  @ApiProperty({ type: NextScheduledPayoutDto })
  nextScheduledPayout!: NextScheduledPayoutDto;

  @ApiProperty({ type: [PayoutSummaryDto] })
  recentPayouts!: PayoutSummaryDto[];

  // If an INFORMAL vendor has a PENDING_APPROVAL cashout request in flight,
  // its ID is surfaced so the frontend can disable the "Demander un
  // virement" CTA and show the in-flight state. Null otherwise.
  @ApiProperty({ nullable: true })
  pendingCashoutRequestId!: string | null;
}

export class RiderSelfBalanceDto {
  @ApiProperty()
  balanceXAF!: number;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastPayoutAt!: string | null;

  @ApiProperty({ nullable: true })
  lastPayoutXAF!: number | null;

  @ApiProperty({ type: NextScheduledPayoutDto })
  nextScheduledPayout!: NextScheduledPayoutDto;

  @ApiProperty({ type: [PayoutSummaryDto] })
  recentPayouts!: PayoutSummaryDto[];
}
