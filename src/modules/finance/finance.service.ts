import { Injectable, NotFoundException } from '@nestjs/common';
import { LedgerAccount, VendorType } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';

// "Trusted vendor" threshold per ADR-0005 §Decision. Used by the
// on-demand cashout path (7.2b) — trusted vendors get same-day approval,
// others get a 24h hold. Computed at read time; never stored.
const TRUSTED_MIN_COMPLETED_ORDERS = 10;
const TRUSTED_MIN_DAYS_SINCE_FIRST_ORDER = 7;

export interface VendorBalance {
  vendorId: string;
  name: string;
  type: VendorType;
  // Signed; positive = platform owes vendor, negative = vendor owes platform
  // (typically because of an unsettled penalty before any deliveries).
  balanceXAF: number;
  components: {
    grossXAF: number; // sum of delivered subtotal − commission since last payout
    commissionXAF: number; // already deducted, surfaced for transparency
    penaltyXAF: number; // sum of applied penalties since last payout
    adjustmentsXAF: number; // admin ADJUSTMENT entries since last payout
  };
  lastPayoutAt: Date | null;
  lastPayoutId: string | null;
  isTrusted: boolean;
}

@Injectable()
export class FinanceService {
  constructor(
    @InjectPinoLogger(FinanceService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  // Reads the vendor's current ledger position. The balance is derived from
  // VENDOR_PAYABLE entries; the components break it down for the admin UI.
  // Per ADR-0005, VENDOR_PAYABLE is a liability — its balance from the
  // platform's perspective is `-SUM(amountXAF)`. We surface the
  // vendor-friendly sign (positive = owed to vendor) at the API boundary.
  async getVendorBalance(vendorId: string): Promise<VendorBalance> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, name: true, type: true, createdAt: true },
    });
    if (!vendor) {
      throw new NotFoundException({ code: 'vendor_not_found', message: 'Unknown vendor.' });
    }

    const lastPayout = await this.prisma.vendorPayout.findFirst({
      where: { vendorId, status: { in: ['PAID', 'IN_FLIGHT'] } },
      orderBy: { periodEnd: 'desc' },
      select: { id: true, paidAt: true, sentAt: true, periodEnd: true },
    });
    // The "since last payout" cutoff. If no prior payout, all ledger
    // history counts.
    const cutoff = lastPayout?.periodEnd ?? null;

    // Two queries: one for VENDOR_PAYABLE (the balance signal), one
    // grouped on PLATFORM_REVENUE attributed to this vendor (for the
    // commission component surfacing — these are paired entries that
    // we book at delivery and at penalty time).
    const payableAgg = await this.prisma.ledgerEntry.aggregate({
      _sum: { amountXAF: true },
      where: {
        vendorId,
        account: LedgerAccount.VENDOR_PAYABLE,
        ...(cutoff ? { createdAt: { gt: cutoff } } : {}),
      },
    });
    const revenueAttribution = await this.prisma.ledgerEntry.groupBy({
      by: ['eventType'],
      _sum: { amountXAF: true },
      where: {
        vendorId,
        account: LedgerAccount.PLATFORM_REVENUE,
        ...(cutoff ? { createdAt: { gt: cutoff } } : {}),
      },
    });

    // VENDOR_PAYABLE sum: liability convention — invert to get payable.
    // `+ 0` collapses any negative zero from `-0` arithmetic.
    const payableSum = payableAgg._sum.amountXAF ?? 0;
    const balanceXAF = -payableSum + 0;

    // Component reconstruction. Delivered-order commission is the
    // PLATFORM_REVENUE attributed to this vendor on ORDER_DELIVERED
    // events. Penalty is the same account on PENALTY_APPLIED events.
    const commissionXAF =
      -(revenueAttribution.find((r) => r.eventType === 'ORDER_DELIVERED')?._sum.amountXAF ?? 0) + 0;
    const penaltyXAF =
      -(revenueAttribution.find((r) => r.eventType === 'PENALTY_APPLIED')?._sum.amountXAF ?? 0) + 0;
    const adjustmentsXAF =
      -(revenueAttribution.find((r) => r.eventType === 'ADJUSTMENT')?._sum.amountXAF ?? 0) + 0;
    // Gross = what the vendor would have received before commission was
    // deducted. balanceXAF + commissionXAF + penaltyXAF − adjustmentsXAF
    // back-solves to gross.
    const grossXAF = balanceXAF + commissionXAF + penaltyXAF - adjustmentsXAF;

    // Trust threshold — count of completed orders + age.
    const completedOrders = await this.prisma.order.count({
      where: { vendorId, status: 'DELIVERED' },
    });
    const ageMs = Date.now() - vendor.createdAt.getTime();
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    // "open disputes" = orders in REFUND_PENDING; once dispute resolution
    // (Story 6.3) is wired this widens.
    const openDisputes = await this.prisma.order.count({
      where: { vendorId, paymentStatus: 'REFUND_PENDING' },
    });
    const isTrusted =
      completedOrders >= TRUSTED_MIN_COMPLETED_ORDERS &&
      ageDays >= TRUSTED_MIN_DAYS_SINCE_FIRST_ORDER &&
      openDisputes === 0;

    return {
      vendorId: vendor.id,
      name: vendor.name,
      type: vendor.type,
      balanceXAF,
      components: { grossXAF, commissionXAF, penaltyXAF, adjustmentsXAF },
      lastPayoutAt: lastPayout?.paidAt ?? lastPayout?.sentAt ?? null,
      lastPayoutId: lastPayout?.id ?? null,
      isTrusted,
    };
  }
}
