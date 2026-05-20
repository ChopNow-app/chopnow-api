import { Injectable, NotFoundException } from '@nestjs/common';
import {
  LedgerAccount,
  PaymentStatus,
  RiderVehicleType,
  VendorStatus,
  VendorType,
} from '@prisma/client';
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

export interface VendorBalanceRow {
  vendorId: string;
  name: string;
  type: VendorType;
  status: VendorStatus;
  balanceXAF: number;
  isTrusted: boolean;
  lastPayoutAt: Date | null;
}

export interface RiderBalanceRow {
  riderId: string;
  name: string | null;
  vehicleType: RiderVehicleType;
  balanceXAF: number;
  lastPayoutAt: Date | null;
}

export interface RefundQueueRow {
  orderId: string;
  code: string;
  vendorId: string;
  vendorName: string;
  userId: string;
  totalXAF: number;
  // Days since the order became REFUND_PENDING. cancelledAt is set in the
  // same transaction that flips paymentStatus to REFUND_PENDING (see
  // vendorCancelPreOrder), so it's the accurate "refund-queued-at" timestamp.
  ageDays: number;
  cancelledAt: Date | null;
}

export interface RiderBalance {
  riderId: string;
  // Display name pulled via User.displayName; null if the rider hasn't
  // set one (admins can still recognise them by phone in the wider view).
  name: string | null;
  // Signed; positive = platform owes rider. Riders rarely go negative
  // since they don't take penalties at pilot scope, but the sign is
  // consistent with the vendor shape.
  balanceXAF: number;
  components: {
    grossXAF: number; // sum of riderShareXAF on delivered orders since last payout
    adjustmentsXAF: number; // admin ADJUSTMENT entries since last payout
  };
  lastPayoutAt: Date | null;
  lastPayoutId: string | null;
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

  // Reads the rider's current ledger position. Simpler than vendor: no
  // commission, no penalty — riders earn the delivery share directly.
  async getRiderBalance(riderId: string): Promise<RiderBalance> {
    const rider = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: { id: true, user: { select: { displayName: true } } },
    });
    if (!rider) {
      throw new NotFoundException({ code: 'rider_not_found', message: 'Unknown rider.' });
    }

    const lastPayout = await this.prisma.riderPayout.findFirst({
      where: { riderId, status: { in: ['PAID', 'IN_FLIGHT'] } },
      orderBy: { periodEnd: 'desc' },
      select: { id: true, paidAt: true, sentAt: true, periodEnd: true },
    });
    const cutoff = lastPayout?.periodEnd ?? null;

    const payableAgg = await this.prisma.ledgerEntry.aggregate({
      _sum: { amountXAF: true },
      where: {
        riderId,
        account: LedgerAccount.RIDER_PAYABLE,
        ...(cutoff ? { createdAt: { gt: cutoff } } : {}),
      },
    });
    const adjustmentsAgg = await this.prisma.ledgerEntry.aggregate({
      _sum: { amountXAF: true },
      where: {
        riderId,
        account: LedgerAccount.PLATFORM_REVENUE,
        eventType: 'ADJUSTMENT',
        ...(cutoff ? { createdAt: { gt: cutoff } } : {}),
      },
    });

    const balanceXAF = -(payableAgg._sum.amountXAF ?? 0) + 0;
    const adjustmentsXAF = -(adjustmentsAgg._sum.amountXAF ?? 0) + 0;
    const grossXAF = balanceXAF - adjustmentsXAF;

    return {
      riderId: rider.id,
      name: rider.user.displayName ?? null,
      balanceXAF,
      components: { grossXAF, adjustmentsXAF },
      lastPayoutAt: lastPayout?.paidAt ?? lastPayout?.sentAt ?? null,
      lastPayoutId: lastPayout?.id ?? null,
    };
  }

  // ── Admin dashboard list endpoints (7.1e) ─────────────────────────
  //
  // At pilot scope (<200 vendors / <50 riders), per-row balance reads
  // via Promise.all are fast enough (<500ms total). Post-pilot, replace
  // with a single CTE that aggregates per-entity in SQL.

  async listVendorBalances(opts: {
    status?: VendorStatus;
    type?: VendorType;
    minBalanceXAF?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; rows: VendorBalanceRow[] }> {
    const vendors = await this.prisma.vendor.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.type ? { type: opts.type } : {}),
      },
      select: { id: true },
      orderBy: { name: 'asc' },
    });

    // Per-vendor full balance read for the row shape we want
    // (isTrusted + lastPayoutAt). Capped concurrency by chunking would
    // be wise post-pilot; for now Prisma's connection pool absorbs the
    // burst at this scope.
    const balances = await Promise.all(vendors.map((v) => this.getVendorBalance(v.id)));

    // VendorStatus isn't included in the per-vendor balance read — pull
    // it in one batch query so we don't fan out N+1.
    const statuses = await this.prisma.vendor.findMany({
      where: { id: { in: vendors.map((v) => v.id) } },
      select: { id: true, status: true },
    });
    const statusMap = new Map(statuses.map((s) => [s.id, s.status]));

    let rows: VendorBalanceRow[] = balances.map((b) => ({
      vendorId: b.vendorId,
      name: b.name,
      type: b.type,
      status: statusMap.get(b.vendorId) ?? VendorStatus.PENDING_REVIEW,
      balanceXAF: b.balanceXAF,
      isTrusted: b.isTrusted,
      lastPayoutAt: b.lastPayoutAt,
    }));

    if (opts.minBalanceXAF !== undefined) {
      rows = rows.filter((r) => r.balanceXAF >= opts.minBalanceXAF!);
    }
    rows.sort((a, b) => b.balanceXAF - a.balanceXAF);

    const total = rows.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    return { total, rows: rows.slice(offset, offset + limit) };
  }

  async listRiderBalances(opts: {
    vehicleType?: RiderVehicleType;
    minBalanceXAF?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; rows: RiderBalanceRow[] }> {
    const riders = await this.prisma.rider.findMany({
      where: opts.vehicleType ? { vehicleType: opts.vehicleType } : {},
      select: { id: true, vehicleType: true, user: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const balances = await Promise.all(riders.map((r) => this.getRiderBalance(r.id)));
    const vehicleMap = new Map(riders.map((r) => [r.id, r.vehicleType]));

    let rows: RiderBalanceRow[] = balances.map((b) => ({
      riderId: b.riderId,
      name: b.name,
      vehicleType: vehicleMap.get(b.riderId) ?? RiderVehicleType.MOTO,
      balanceXAF: b.balanceXAF,
      lastPayoutAt: b.lastPayoutAt,
    }));

    if (opts.minBalanceXAF !== undefined) {
      rows = rows.filter((r) => r.balanceXAF >= opts.minBalanceXAF!);
    }
    rows.sort((a, b) => b.balanceXAF - a.balanceXAF);

    const total = rows.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    return { total, rows: rows.slice(offset, offset + limit) };
  }

  // Manual refund-processing worklist. Ordered oldest-first so ops
  // triages in order. Story 3.8 (Campay refund API) eventually drains
  // this; until then it's a daily admin task.
  async listRefundQueue(opts: {
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; rows: RefundQueueRow[] }> {
    const where = { paymentStatus: PaymentStatus.REFUND_PENDING };
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        select: {
          id: true,
          code: true,
          vendorId: true,
          userId: true,
          totalXAF: true,
          cancelledAt: true,
          placedAt: true,
          vendor: { select: { name: true } },
        },
        orderBy: { cancelledAt: 'asc' },
        skip: offset,
        take: limit,
      }),
    ]);

    const now = Date.now();
    const rows: RefundQueueRow[] = orders.map((o) => {
      // Fall back to placedAt if cancelledAt is null — shouldn't happen
      // for REFUND_PENDING orders post-S1 (vendorCancelPreOrder always
      // sets it), but is the safe default for legacy rows.
      const refundQueuedAt = o.cancelledAt ?? o.placedAt;
      return {
        orderId: o.id,
        code: o.code,
        vendorId: o.vendorId,
        vendorName: o.vendor.name,
        userId: o.userId,
        totalXAF: o.totalXAF,
        cancelledAt: o.cancelledAt,
        ageDays: Math.floor((now - refundQueuedAt.getTime()) / (24 * 60 * 60 * 1000)),
      };
    });

    return { total, rows };
  }
}
