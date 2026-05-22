import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LedgerAccount, LedgerEventType, OrderStatus, PaymentStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { LedgerService } from '../finance/ledger.service';
import { RefuseOrderDto } from './dto/vendor-decision.dto';
import {
  PRE_ORDER_PENALTY_RATE,
  PRE_ORDER_PENALTY_ROUND_TO_XAF,
  VENDOR_CAN_DECIDE,
} from './orders.constants';

/**
 * All write paths a vendor can initiate against an order they own:
 *
 *   - acceptOrder            — Story 3.7 vendor decision (PENDING/CONFIRMED → ACCEPTED)
 *   - refuseOrder            — Story 3.7 vendor refusal with reason
 *   - setItemPrepared        — kitchen checklist toggle; flips status ACCEPTED ↔ IN_PREP
 *   - markOrderReady         — kitchen → READY_PICKUP when all items prepared
 *   - vendorCancelPreOrder   — #187 vendor cancels a pre-order they already accepted,
 *                              triggers refund + VendorPenalty
 *
 * Every method goes through `requireVendorOrder` first to confirm the
 * caller owns the vendor that owns the order — 404 (not 403) on mismatch
 * per the no-enumeration principle.
 */
@Injectable()
export class OrderVendorActionsService {
  constructor(
    @InjectPinoLogger(OrderVendorActionsService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly ledger: LedgerService,
  ) {}

  async acceptOrder(orderId: string, userId: string) {
    const order = await this.requireVendorOrder(orderId, userId);
    if (!VENDOR_CAN_DECIDE.has(order.status)) {
      // Cheap "you already decided" error message for the common case where
      // the vendor double-taps or revisits a stale URL. The conditional
      // updateMany below catches the rare sub-100ms race against the
      // auto-refuse cron.
      throw new ConflictException({
        code: 'order_not_pending',
        message: 'This order is no longer awaiting your decision.',
      });
    }
    const now = new Date();
    // Status-guarded update mirrors OrdersExpiryService.sweepExpired so the
    // vendor's Accept cannot silently overwrite a cron-driven REFUSED.
    // count===0 means the order changed state between requireVendorOrder()
    // and this update — almost always: the cron got there first.
    const res = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
      },
      data: { status: OrderStatus.ACCEPTED, acceptedAt: now },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'order_state_changed',
        message:
          "Cette commande vient d'être refusée automatiquement (délai dépassé). Reviens au dashboard.",
      });
    }
    this.events.emit(DomainEvents.ORDER_ACCEPTED, {
      orderId: order.id,
      vendorId: order.vendorId,
      acceptedAt: now,
    });
    return this.prisma.order.findUnique({ where: { id: order.id } });
  }

  async refuseOrder(orderId: string, userId: string, dto: RefuseOrderDto) {
    const order = await this.requireVendorOrder(orderId, userId);
    if (!VENDOR_CAN_DECIDE.has(order.status)) {
      throw new ConflictException({
        code: 'order_not_pending',
        message: 'This order is no longer awaiting your decision.',
      });
    }
    const reasonLabel = dto.note ? `${dto.reason}: ${dto.note}` : dto.reason;
    const now = new Date();
    // Same status guard as acceptOrder — if the cron beat us to REFUSED, we
    // don't want to emit a second ORDER_REFUSED (would re-send the consumer
    // WhatsApp) or overwrite the auto-refuse reason with the vendor's pick.
    const res = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
      },
      data: { status: OrderStatus.REFUSED, refusedAt: now, refusalReason: reasonLabel },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'order_state_changed',
        message: "Cette commande a déjà changé d'état. Reviens au dashboard.",
      });
    }
    this.events.emit(DomainEvents.ORDER_REFUSED, {
      orderId: order.id,
      vendorId: order.vendorId,
      reason: dto.reason,
      refusedAt: now,
    });
    // Refund wiring: same TODO as cancelOrder.
    if (order.paymentStatus === PaymentStatus.PAID) {
      this.logger.warn(
        {
          event: 'order_refused_while_paid',
          orderId: order.id,
          paymentMethod: order.paymentMethod,
        },
        'Order refused by vendor while PAID — refund needed',
      );
    }
    return this.prisma.order.findUnique({ where: { id: order.id } });
  }

  // ── kitchen / preparation path ────────────────────────────────────

  /**
   * Toggle a single OrderItem's prepared flag (the vendor's checkbox on the
   * /vendor/preparation screen).
   *
   * Side-effect on order status:
   *   - If status is ACCEPTED and we just prepared the FIRST item → flip to IN_PREP
   *   - If status is IN_PREP and we just unprepared the LAST prepared item → flip back to ACCEPTED
   * Status flips happen inside the same transaction as the OrderItem update so
   * a partial failure can't leave the order in an inconsistent state.
   *
   * Refuses outside ACCEPTED / IN_PREP — once the vendor has marked the order
   * READY_PICKUP, the kitchen-side checklist is closed.
   */
  async setItemPrepared(
    orderId: string,
    itemId: string,
    userId: string,
    prepared: boolean,
  ): Promise<{ orderId: string; itemId: string; preparedAt: Date | null; status: OrderStatus }> {
    const order = await this.requireVendorOrder(orderId, userId);
    if (order.status !== OrderStatus.ACCEPTED && order.status !== OrderStatus.IN_PREP) {
      throw new ConflictException({
        code: 'order_not_in_prep_phase',
        message: 'This order is no longer in the preparation phase.',
      });
    }

    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId } });
    if (!item || item.orderId !== orderId) {
      throw new NotFoundException('order_item_not_found');
    }

    const newPreparedAt = prepared ? new Date() : null;

    return this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: itemId },
        data: { preparedAt: newPreparedAt },
      });

      // Recompute aggregate state from the items so the status flip is based
      // on the post-update truth, not the optimistic local view.
      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: { preparedAt: true },
      });
      const anyPrepared = items.some((i) => i.preparedAt !== null);
      const nextStatus =
        anyPrepared && order.status === OrderStatus.ACCEPTED
          ? OrderStatus.IN_PREP
          : !anyPrepared && order.status === OrderStatus.IN_PREP
            ? OrderStatus.ACCEPTED
            : order.status;

      if (nextStatus !== order.status) {
        await tx.order.update({ where: { id: orderId }, data: { status: nextStatus } });
      }

      return { orderId, itemId, preparedAt: newPreparedAt, status: nextStatus };
    });
  }

  /**
   * Mark the whole order ready for pickup. Requires every OrderItem to have
   * preparedAt set (the "all checkboxes ticked" precondition of the CTA).
   * Flips status to READY_PICKUP, stamps Order.preparedAt, and emits
   * ORDER_READY so any downstream notifier (rider PWA, consumer WhatsApp)
   * can fan out.
   */
  async markOrderReady(
    orderId: string,
    userId: string,
  ): Promise<{ status: OrderStatus; preparedAt: Date }> {
    const order = await this.requireVendorOrder(orderId, userId);
    if (order.status !== OrderStatus.ACCEPTED && order.status !== OrderStatus.IN_PREP) {
      throw new ConflictException({
        code: 'order_not_in_prep_phase',
        message: 'This order is no longer in the preparation phase.',
      });
    }

    const items = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { preparedAt: true },
    });
    if (items.length === 0 || items.some((i) => i.preparedAt === null)) {
      throw new ConflictException({
        code: 'items_not_all_prepared',
        message: 'All articles must be marked prepared before marking the order ready.',
      });
    }

    const now = new Date();
    // Status-guarded update: a vendor who manages to refuse-then-mark-ready
    // (or whose order somehow went past READY_PICKUP via another path)
    // shouldn't be able to overwrite the order state. count===0 → 409.
    const res = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: { in: [OrderStatus.ACCEPTED, OrderStatus.IN_PREP] },
      },
      data: { status: OrderStatus.READY_PICKUP, preparedAt: now },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'order_state_changed',
        message: "Cette commande a changé d'état pendant la préparation. Reviens au dashboard.",
      });
    }

    this.events.emit(DomainEvents.ORDER_READY, {
      orderId,
      vendorId: order.vendorId,
      preparedAt: now,
    });

    return { status: OrderStatus.READY_PICKUP, preparedAt: now };
  }

  // ── pre-order vendor cancel (post-acceptance) ─────────────────────

  /**
   * #187 — vendor cancels a pre-order they previously accepted. This is the
   * costly path: vendor commits at acceptance time, breaking the commitment
   * later (kitchen disaster, ran out of an ingredient, etc.) means refunding
   * the consumer AND incurring a penalty.
   *
   * Pre-acceptance refusal (refuseOrder, or the auto-refuse cron) is free —
   * a vendor who hasn't said yes yet hasn't committed. Hence why this method
   * gates on `status ∈ {ACCEPTED, IN_PREP}` and not on PENDING/CONFIRMED.
   *
   * Effects in one transaction:
   *   1. Order.status → CANCELLED, cancelledAt = now
   *   2. paymentStatus → REFUND_PENDING (Story 3.8 sweeps to REFUNDED via Campay)
   *   3. VendorPenalty row created, amount = 10% of totalXAF (rounded down to 50)
   *
   * Emits ORDER_CANCELLED with `cancelledBy='vendor_preorder'` so downstream
   * notifications can humanize the message ("le vendeur a dû annuler ta
   * pré-commande, un remboursement est en cours").
   */
  async vendorCancelPreOrder(
    orderId: string,
    userId: string,
    note?: string,
  ): Promise<{ status: OrderStatus; penaltyXAF: number }> {
    const order = await this.requireVendorOrder(orderId, userId);
    if (!order.scheduledFor) {
      throw new ConflictException({
        code: 'not_a_pre_order',
        message: 'This method is only valid for pre-orders.',
      });
    }
    if (order.status !== OrderStatus.ACCEPTED && order.status !== OrderStatus.IN_PREP) {
      throw new ConflictException({
        code: 'pre_order_not_in_cancellable_state',
        message: 'A pre-order can only be vendor-cancelled after acceptance and before pickup.',
      });
    }

    const now = new Date();
    const penaltyXAF =
      Math.floor((order.totalXAF * PRE_ORDER_PENALTY_RATE) / PRE_ORDER_PENALTY_ROUND_TO_XAF) *
      PRE_ORDER_PENALTY_ROUND_TO_XAF;

    // All four writes atomic: order flip + payment flip + penalty row +
    // paired ledger entries. Status-guarded updateMany on the order flip so
    // a concurrent rider-side status change (pickup scan landing at the
    // same instant) can't be overwritten. count===0 → race lost, no penalty
    // written, throw 409. If the ledger write fails the entire transaction
    // rolls back — the VendorPenalty row and the ledger entries are kept
    // in lock-step (ADR-0005).
    const ledgerEventId = await this.prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: {
          id: order.id,
          status: { in: [OrderStatus.ACCEPTED, OrderStatus.IN_PREP] },
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: now,
          refusalReason: note ? `VENDOR_PREORDER_CANCEL: ${note}` : 'VENDOR_PREORDER_CANCEL',
          paymentStatus: PaymentStatus.REFUND_PENDING,
        },
      });
      if (res.count === 0) {
        throw new ConflictException({
          code: 'order_state_changed',
          message: "Cette commande a changé d'état pendant l'annulation. Reviens au dashboard.",
        });
      }
      const penalty = await tx.vendorPenalty.create({
        data: {
          vendorId: order.vendorId,
          orderId: order.id,
          reason: 'PRE_ORDER_VENDOR_CANCEL_AFTER_ACCEPT',
          amountXAF: penaltyXAF,
        },
      });
      // ADR-0005 ledger bridge. Sign convention (positive = debit):
      //  - VENDOR_PAYABLE +penalty   → debit (reduces what we owe them)
      //  - PLATFORM_REVENUE −penalty → credit (recognises the penalty as income)
      // Sum = 0. The penalty.id is the ledger eventId so the two systems
      // stay traceable. Future refund leg (Story 3.8) will write its own
      // event with a different eventId.
      await this.ledger.recordTransaction(
        {
          eventId: penalty.id,
          eventType: LedgerEventType.PENALTY_APPLIED,
          entries: [
            {
              account: LedgerAccount.VENDOR_PAYABLE,
              amountXAF: penaltyXAF,
              vendorId: order.vendorId,
              orderId: order.id,
              description: `Pre-order cancellation penalty (10% of ${order.totalXAF} FCFA, rounded down to 50)`,
            },
            {
              account: LedgerAccount.PLATFORM_REVENUE,
              amountXAF: -penaltyXAF,
              vendorId: order.vendorId,
              orderId: order.id,
              description: 'Pre-order cancellation penalty — platform revenue',
            },
          ],
        },
        tx,
      );
      return penalty.id;
    });

    this.events.emit(DomainEvents.ORDER_CANCELLED, {
      orderId: order.id,
      paymentStatus: PaymentStatus.REFUND_PENDING,
      cancelledBy: 'vendor_preorder',
    });

    this.logger.warn(
      {
        event: 'pre_order_vendor_cancelled_after_accept',
        orderId: order.id,
        vendorId: order.vendorId,
        userId: order.userId,
        totalXAF: order.totalXAF,
        penaltyXAF,
        scheduledFor: order.scheduledFor,
        ledgerEventId,
      },
      'Vendor cancelled pre-order after acceptance — refund pending + penalty recorded',
    );
    this.logger.warn(
      {
        event: 'pre_order_refund_required',
        orderId: order.id,
        amountXAF: order.totalXAF,
        paymentMethod: order.paymentMethod,
      },
      'Pre-order vendor-cancel — Campay refund needed (Story 3.8 pending wiring)',
    );

    return { status: OrderStatus.CANCELLED, penaltyXAF };
  }

  // ── helpers ──────────────────────────────────────────────────────

  /**
   * Resolve the calling user's Vendor row, then load the order and assert
   * it belongs to this vendor. 404 (not 403) on mismatch — same
   * no-enumeration principle as /vendors/:id.
   */
  private async requireVendorOrder(orderId: string, userId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendor) throw new ForbiddenException('vendor_not_found');

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.vendorId !== vendor.id) {
      throw new NotFoundException('order_not_found');
    }
    return order;
  }
}
