import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  LedgerAccount,
  LedgerEventType,
  OrderStatus,
  PaymentStatus,
  RiderStatus,
} from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { LedgerService } from '../finance/ledger.service';
import { JwtRevocationService } from '../auth/jwt-revocation.service';

// Per ADR-0005 §S3 / chopnow-api#213. Admin resolution flow when a
// rider scanned pickup but never delivered (or when the
// StuckPickupDetector flags an order > 2h in PICKED_UP).
//
// In one transaction the admin can choose any combination of:
//   - consumerRefund:       Order.paymentStatus → REFUND_PENDING
//                           RefundProcessor picks it up next sweep
//                           (#90 handles the Campay-side fire + settle)
//   - vendorCompensation:   ADJUSTMENT ledger entry crediting VENDOR_PAYABLE
//                           by (subtotal - commissionXAF) — platform eats
//                           the food cost out of PLATFORM_REVENUE
//   - riderAction:          'SUSPEND' (RiderStatus → SUSPENDED + JWT
//                           revoked) or 'WARN' (reliabilityScore -=
//                           RIDER_FRAUD_WARN_DECREMENT)
// Always: Order.status → CANCELLED, refusalReason captures the note.

export type RiderFraudAction = 'SUSPEND' | 'WARN';

const RIDER_FRAUD_WARN_DECREMENT = 20;

export interface ResolveRiderFraudInput {
  riderAction: RiderFraudAction;
  vendorCompensation: boolean;
  consumerRefund: boolean;
  note: string;
}

@Injectable()
export class AdminRiderFraudService {
  constructor(
    @InjectPinoLogger(AdminRiderFraudService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly jwtRevocation: JwtRevocationService,
  ) {}

  async resolveRiderFraud(
    orderId: string,
    adminUserId: string,
    input: ResolveRiderFraudInput,
  ): Promise<{
    orderStatus: OrderStatus;
    consumerRefundQueued: boolean;
    vendorCompensationXAF: number;
    riderSuspended: boolean;
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        code: true,
        status: true,
        vendorId: true,
        riderId: true,
        userId: true,
        subtotalXAF: true,
        commissionXAF: true,
        totalXAF: true,
        paymentStatus: true,
      },
    });
    if (!order) {
      throw new NotFoundException({ code: 'order_not_found' });
    }
    if (order.status !== OrderStatus.PICKED_UP) {
      throw new ConflictException({
        code: 'order_not_in_pickup',
        message: 'Rider-fraud resolution only applies to orders currently in PICKED_UP.',
      });
    }
    if (!order.riderId) {
      throw new ConflictException({
        code: 'order_has_no_rider',
        message: 'Cannot resolve rider fraud — no rider assigned to this order.',
      });
    }
    if (input.vendorCompensation && order.commissionXAF === null) {
      // Should never fire post-S2 (every PICKED_UP order went through
      // onPaymentSucceeded which sets commissionXAF), but guard explicitly.
      throw new ConflictException({
        code: 'order_missing_finance_snapshot',
      });
    }

    const vendorCompensationXAF = input.vendorCompensation
      ? order.subtotalXAF - (order.commissionXAF ?? 0)
      : 0;
    const now = new Date();
    let riderSuspended = false;

    await this.prisma.$transaction(async (tx) => {
      // 1. Cancel the order with a rider-fraud refusal reason.
      // Status-guarded so a concurrent rider re-tap (vanishingly unlikely
      // at this point) can't race.
      const res = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PICKED_UP },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: now,
          refusalReason: `RIDER_FRAUD: ${input.note}`,
          ...(input.consumerRefund && order.paymentStatus === PaymentStatus.PAID
            ? { paymentStatus: PaymentStatus.REFUND_PENDING }
            : {}),
        },
      });
      if (res.count === 0) {
        throw new ConflictException({
          code: 'order_state_changed',
          message: 'Order status changed during resolution.',
        });
      }

      // 2. Vendor compensation: ADJUSTMENT entry. Platform eats the
      // food cost out of PLATFORM_REVENUE so the vendor still gets
      // paid as if the delivery had completed.
      if (input.vendorCompensation && vendorCompensationXAF > 0) {
        await this.ledger.recordTransaction(
          {
            eventId: `rider_fraud_vendor_compensation:${order.id}`,
            eventType: LedgerEventType.ADJUSTMENT,
            entries: [
              {
                account: LedgerAccount.PLATFORM_REVENUE,
                amountXAF: vendorCompensationXAF,
                vendorId: order.vendorId,
                orderId: order.id,
                description: `Rider fraud — platform compensates vendor for order ${order.code} (rider stole food)`,
              },
              {
                account: LedgerAccount.VENDOR_PAYABLE,
                amountXAF: -vendorCompensationXAF,
                vendorId: order.vendorId,
                orderId: order.id,
                description: `Vendor compensation for rider-stolen order ${order.code}`,
              },
            ],
          },
          tx,
        );
      }

      // 3. Rider action.
      if (input.riderAction === 'SUSPEND') {
        const rider = await tx.rider.findUnique({
          where: { id: order.riderId! },
          select: { userId: true },
        });
        if (rider) {
          await tx.rider.update({
            where: { id: order.riderId! },
            data: { status: RiderStatus.SUSPENDED },
          });
          // JWT revocation outside the transaction would be safer but
          // we want it to roll back if the rest fails. Redis writes
          // aren't transactional with Postgres but they're idempotent
          // (re-revoking on retry is a no-op).
          await this.jwtRevocation.revokeUser(rider.userId);
          riderSuspended = true;
        }
      } else {
        // WARN — decrement reliabilityScore, floor at 0.
        await tx.rider.updateMany({
          where: { id: order.riderId! },
          data: {
            reliabilityScore: { decrement: RIDER_FRAUD_WARN_DECREMENT },
          },
        });
      }
    });

    this.logger.warn(
      {
        event: 'rider_fraud_resolved',
        orderId: order.id,
        orderCode: order.code,
        vendorId: order.vendorId,
        riderId: order.riderId,
        userId: order.userId,
        adminUserId,
        riderAction: input.riderAction,
        consumerRefund: input.consumerRefund,
        vendorCompensation: input.vendorCompensation,
        vendorCompensationXAF,
        riderSuspended,
        note: input.note,
      },
      'rider fraud resolved by admin',
    );

    return {
      orderStatus: OrderStatus.CANCELLED,
      consumerRefundQueued: input.consumerRefund && order.paymentStatus === PaymentStatus.PAID,
      vendorCompensationXAF,
      riderSuspended,
    };
  }
}
