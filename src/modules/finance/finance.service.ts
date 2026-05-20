import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashoutRequestStatus,
  LedgerAccount,
  LedgerEventType,
  OrderStatus,
  PaymentStatus,
  RiderVehicleType,
  VendorStatus,
  VendorType,
} from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { LedgerService } from './ledger.service';

// Same threshold the cron uses — keeps admin approval consistent with
// the weekly batch. Negative-balance + dispute refusal applied identically.
const MIN_CASHOUT_XAF = 500;

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
    private readonly ledger: LedgerService,
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

  // ── On-demand cashout requests (7.2b — INFORMAL vendors) ──────────
  //
  // INFORMAL vendors don't go through the weekly cron — they request
  // cashout when they need it (daily cashflow expectation per ADR-0005).
  // v1 is admin-gated: vendor request → admin approves → VendorPayout
  // created via the same code path as the cron.

  async requestVendorCashout(vendorId: string): Promise<{
    requestId: string;
    requestedXAF: number;
    isTrusted: boolean;
  }> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, type: true, status: true, name: true },
    });
    if (!vendor) {
      throw new NotFoundException({ code: 'vendor_not_found' });
    }
    if (vendor.type !== VendorType.INFORMAL) {
      throw new BadRequestException({
        code: 'cashout_request_only_for_informal',
        message:
          'On-demand cashout is reserved for INFORMAL vendors. Formal vendors are paid via the Sunday cron.',
      });
    }
    if (vendor.status !== VendorStatus.ACTIVE) {
      throw new ConflictException({
        code: 'vendor_not_active',
        message: 'Cashout is only available for ACTIVE vendors.',
      });
    }

    // Rate-limit: refuse if there's already a PENDING_APPROVAL request.
    // Vendor must wait for admin to act on the prior one before queuing
    // another. Keeps the admin queue from filling with duplicates.
    const existingPending = await this.prisma.vendorCashoutRequest.findFirst({
      where: { vendorId, status: CashoutRequestStatus.PENDING_APPROVAL },
      select: { id: true },
    });
    if (existingPending) {
      throw new ConflictException({
        code: 'cashout_request_already_pending',
        message: 'Une demande de virement est déjà en cours. Patiente la décision.',
      });
    }

    const balance = await this.getVendorBalance(vendorId);
    if (balance.balanceXAF <= 0) {
      throw new ConflictException({
        code: 'cashout_request_no_balance',
        message: 'Aucun solde disponible pour le moment. Réessaie après ta prochaine livraison.',
      });
    }

    const request = await this.prisma.vendorCashoutRequest.create({
      data: {
        vendorId,
        requestedXAF: balance.balanceXAF,
      },
    });
    this.logger.info(
      {
        event: 'cashout_requested',
        vendorId,
        requestId: request.id,
        requestedXAF: balance.balanceXAF,
        isTrusted: balance.isTrusted,
      },
      'vendor requested on-demand cashout',
    );
    return {
      requestId: request.id,
      requestedXAF: balance.balanceXAF,
      isTrusted: balance.isTrusted,
    };
  }

  async listCashoutRequests(opts: {
    status?: CashoutRequestStatus;
    limit?: number;
    offset?: number;
  }): Promise<{
    total: number;
    rows: Array<{
      requestId: string;
      vendorId: string;
      vendorName: string;
      vendorType: VendorType;
      requestedXAF: number;
      status: CashoutRequestStatus;
      createdAt: Date;
      ageHours: number;
      isTrusted: boolean;
    }>;
  }> {
    const where = opts.status ? { status: opts.status } : {};
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const [total, requests] = await Promise.all([
      this.prisma.vendorCashoutRequest.count({ where }),
      this.prisma.vendorCashoutRequest.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          vendorId: true,
          requestedXAF: true,
          status: true,
          createdAt: true,
          vendor: { select: { name: true, type: true } },
        },
      }),
    ]);

    // Trust per request (cheap at pilot scope — Promise.all over a page).
    const trustMap = new Map<string, boolean>();
    await Promise.all(
      requests.map(async (r) => {
        const b = await this.getVendorBalance(r.vendorId);
        trustMap.set(r.id, b.isTrusted);
      }),
    );

    const now = Date.now();
    const rows = requests.map((r) => ({
      requestId: r.id,
      vendorId: r.vendorId,
      vendorName: r.vendor.name,
      vendorType: r.vendor.type,
      requestedXAF: r.requestedXAF,
      status: r.status,
      createdAt: r.createdAt,
      ageHours: Math.floor((now - r.createdAt.getTime()) / (60 * 60 * 1000)),
      isTrusted: trustMap.get(r.id) ?? false,
    }));

    return { total, rows };
  }

  async approveCashoutRequest(
    requestId: string,
    adminUserId: string,
  ): Promise<{
    payoutId: string;
    netXAF: number;
  }> {
    const request = await this.prisma.vendorCashoutRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        vendorId: true,
        status: true,
        vendor: { select: { id: true, momoPhone: true, createdAt: true } },
      },
    });
    if (!request) {
      throw new NotFoundException({ code: 'cashout_request_not_found' });
    }
    if (request.status !== CashoutRequestStatus.PENDING_APPROVAL) {
      throw new ConflictException({
        code: 'cashout_request_not_pending',
        message: 'This request has already been resolved.',
      });
    }

    // Re-read the live balance — never trust the requestedXAF snapshot,
    // the vendor may have had more (or fewer) orders since they tapped.
    const balance = await this.getVendorBalance(request.vendorId);
    if (balance.balanceXAF < MIN_CASHOUT_XAF) {
      throw new ConflictException({
        code: 'cashout_below_minimum',
        message: `Le solde actuel (${balance.balanceXAF} FCFA) est en dessous du minimum (${MIN_CASHOUT_XAF}).`,
      });
    }

    // Negative-balance / dispute refusal (#205) — same rule as the cron.
    const openDisputes = await this.prisma.order.count({
      where: { vendorId: request.vendorId, paymentStatus: PaymentStatus.REFUND_PENDING },
    });
    if (openDisputes > 0) {
      throw new ConflictException({
        code: 'cashout_open_disputes',
        message: 'Cannot approve while a refund is pending for this vendor.',
      });
    }

    // Derive periodStart consistently with how the weekly cron does
    // (last paid VendorPayout periodEnd, or vendor.createdAt).
    const lastPaidPayout = await this.prisma.vendorPayout.findFirst({
      where: { vendorId: request.vendorId, status: { in: ['PAID', 'IN_FLIGHT'] } },
      orderBy: { periodEnd: 'desc' },
      select: { periodEnd: true },
    });
    const periodStart = lastPaidPayout?.periodEnd ?? request.vendor.createdAt;
    const periodEnd = new Date();

    // Atomic: VendorPayout + paired ledger entries + Order.payoutId tag
    // + VendorCashoutRequest status flip to APPROVED. Same eventId scheme
    // as the cron so a single SQL query covers both code paths.
    const payoutId = await this.prisma.$transaction(async (tx) => {
      const payout = await tx.vendorPayout.create({
        data: {
          vendorId: request.vendorId,
          periodStart,
          periodEnd,
          grossXAF: balance.components.grossXAF,
          commissionXAF: balance.components.commissionXAF,
          penaltyXAF: balance.components.penaltyXAF,
          adjustmentsXAF: balance.components.adjustmentsXAF,
          netXAF: balance.balanceXAF,
          momoPhone: request.vendor.momoPhone,
          scheduledFor: periodEnd,
        },
      });
      await this.ledger.recordTransaction(
        {
          eventId: `vendor_payout:${payout.id}`,
          eventType: LedgerEventType.VENDOR_PAYOUT,
          entries: [
            {
              account: LedgerAccount.VENDOR_PAYABLE,
              amountXAF: balance.balanceXAF,
              vendorId: request.vendorId,
              payoutId: payout.id,
              description: 'Vendor on-demand cashout (admin approved)',
            },
            {
              account: LedgerAccount.CAMPAY_FLOAT,
              amountXAF: -balance.balanceXAF,
              vendorId: request.vendorId,
              payoutId: payout.id,
              description: 'Funds leaving platform Campay float',
            },
          ],
        },
        tx,
      );
      await tx.order.updateMany({
        where: {
          vendorId: request.vendorId,
          status: OrderStatus.DELIVERED,
          deliveredAt: { gt: periodStart, lte: periodEnd },
          payoutId: null,
        },
        data: { payoutId: payout.id },
      });
      await tx.vendorCashoutRequest.update({
        where: { id: requestId },
        data: {
          status: CashoutRequestStatus.APPROVED,
          approvedAt: periodEnd,
          approvedByUserId: adminUserId,
          payoutId: payout.id,
        },
      });
      return payout.id;
    });

    this.logger.info(
      {
        event: 'cashout_approved',
        vendorId: request.vendorId,
        requestId,
        payoutId,
        adminUserId,
        netXAF: balance.balanceXAF,
      },
      'admin approved cashout request',
    );

    return { payoutId, netXAF: balance.balanceXAF };
  }

  async rejectCashoutRequest(
    requestId: string,
    adminUserId: string,
    reason: string,
  ): Promise<void> {
    const request = await this.prisma.vendorCashoutRequest.findUnique({
      where: { id: requestId },
      select: { id: true, status: true, vendorId: true },
    });
    if (!request) {
      throw new NotFoundException({ code: 'cashout_request_not_found' });
    }
    if (request.status !== CashoutRequestStatus.PENDING_APPROVAL) {
      throw new ConflictException({
        code: 'cashout_request_not_pending',
        message: 'This request has already been resolved.',
      });
    }
    await this.prisma.vendorCashoutRequest.update({
      where: { id: requestId },
      data: {
        status: CashoutRequestStatus.REJECTED,
        rejectedAt: new Date(),
        rejectionReason: reason,
        approvedByUserId: adminUserId,
      },
    });
    this.logger.info(
      {
        event: 'cashout_rejected',
        vendorId: request.vendorId,
        requestId,
        adminUserId,
        reason,
      },
      'admin rejected cashout request',
    );
  }

  // ── Outbound transfer webhook (S3 / #216) ────────────────────────
  //
  // Campay POSTs to /webhooks/campay/transfer after an outbound /withdraw/.
  // The transfer was initiated by PayoutTransferWorker which set
  // VendorPayout.campayRef / RiderPayout.campayRef. We resolve by that
  // reference and flip IN_FLIGHT → PAID (or FAILED) atomically with a
  // status guard so duplicate webhooks are no-ops.
  async handleTransferWebhook(payload: {
    status?: string;
    reference?: string;
    external_reference?: string;
    failure_reason?: string;
  }): Promise<{ received: true }> {
    const reference = payload.reference ?? payload.external_reference;
    if (!reference) {
      this.logger.warn(
        { event: 'campay_transfer_webhook_missing_reference', payload },
        'Campay transfer webhook missing reference field',
      );
      return { received: true };
    }
    const status = (payload.status ?? '').toUpperCase();
    const succeeded = status === 'SUCCESSFUL' || status === 'SUCCESS' || status === 'PAID';
    const failed = status === 'FAILED' || status === 'CANCELLED';
    if (!succeeded && !failed) {
      // PENDING or anything else — just ack and wait for the next callback.
      this.logger.info(
        { event: 'campay_transfer_webhook_ignored', reference, status },
        'Campay transfer webhook in non-terminal state, ignored',
      );
      return { received: true };
    }

    // Try VendorPayout first; if no match, RiderPayout. The eventId
    // prefix in external_reference would be cleaner but Campay's
    // outbound reference is its own; we just look up by campayRef.
    const now = new Date();
    const vendor = await this.prisma.vendorPayout.findUnique({
      where: { campayRef: reference },
      select: { id: true, status: true },
    });
    if (vendor) {
      if (vendor.status !== 'IN_FLIGHT') {
        this.logger.warn(
          {
            event: 'campay_transfer_webhook_status_mismatch',
            payoutKind: 'vendor',
            payoutId: vendor.id,
            currentStatus: vendor.status,
          },
          'Campay transfer webhook arrived but payout is not IN_FLIGHT — likely duplicate or stale',
        );
        return { received: true };
      }
      const res = await this.prisma.vendorPayout.updateMany({
        where: { id: vendor.id, status: 'IN_FLIGHT' },
        data: succeeded
          ? { status: 'PAID', paidAt: now }
          : {
              status: 'FAILED',
              failureReason: payload.failure_reason ?? 'campay_reported_failure',
            },
      });
      if (res.count === 1) {
        this.logger.info(
          {
            event: succeeded ? 'payout_transfer_succeeded' : 'payout_transfer_failed',
            kind: 'vendor',
            payoutId: vendor.id,
            reference,
          },
          succeeded
            ? 'vendor payout PAID — Campay confirmed'
            : 'vendor payout FAILED — Campay rejected',
        );
      }
      return { received: true };
    }

    const rider = await this.prisma.riderPayout.findUnique({
      where: { campayRef: reference },
      select: { id: true, status: true },
    });
    if (rider) {
      if (rider.status !== 'IN_FLIGHT') {
        this.logger.warn(
          {
            event: 'campay_transfer_webhook_status_mismatch',
            payoutKind: 'rider',
            payoutId: rider.id,
            currentStatus: rider.status,
          },
          'Campay transfer webhook arrived but payout is not IN_FLIGHT — likely duplicate or stale',
        );
        return { received: true };
      }
      const res = await this.prisma.riderPayout.updateMany({
        where: { id: rider.id, status: 'IN_FLIGHT' },
        data: succeeded
          ? { status: 'PAID', paidAt: now }
          : {
              status: 'FAILED',
              failureReason: payload.failure_reason ?? 'campay_reported_failure',
            },
      });
      if (res.count === 1) {
        this.logger.info(
          {
            event: succeeded ? 'payout_transfer_succeeded' : 'payout_transfer_failed',
            kind: 'rider',
            payoutId: rider.id,
            reference,
          },
          succeeded
            ? 'rider payout PAID — Campay confirmed'
            : 'rider payout FAILED — Campay rejected',
        );
      }
      return { received: true };
    }

    this.logger.warn(
      { event: 'campay_transfer_webhook_unknown_reference', reference },
      'Campay transfer webhook reference matched no payout',
    );
    return { received: true };
  }
}
