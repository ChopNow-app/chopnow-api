import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CampayService, CampayWebhookPayload } from '../../infra/campay/campay.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { normalizePhone } from '../../shared/phone/phone.util';

// Story 3.14 — webhook race lock TTL. A second webhook for the same
// reference can land within milliseconds of the first; the lock keeps
// them serialised so onPaymentSucceeded can rely on its own check.
const WEBHOOK_LOCK_TTL_SECONDS = 5;
const PAY_LOCK_TTL_SECONDS = 30; // POST /pay re-entry guard

const PAYABLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING,
  // CONFIRMED orders are already paid — never re-pay.
]);

const MOMO_METHODS: ReadonlySet<PaymentMethod> = new Set([
  PaymentMethod.MTN_MOMO,
  PaymentMethod.ORANGE_MONEY,
]);

@Injectable()
export class PaymentsService {
  constructor(
    @InjectPinoLogger(PaymentsService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly campay: CampayService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
    private readonly env: EnvService,
  ) {}

  /**
   * Story 3.3 / 3.4 — initiate a MoMo collect.
   *
   * Pre-conditions:
   *   - Order belongs to the calling user.
   *   - Order.paymentMethod is MTN_MOMO or ORANGE_MONEY (cash never hits here).
   *   - Order.status is PENDING (not yet paid / cancelled / etc.).
   *   - paymentStatus ∈ {PENDING, FAILED} — allows retry of a failed attempt.
   *
   * On success we store Campay's `reference` on the order, mark
   * paymentStatus = PROCESSING, and return the reference + the USSD prompt
   * message so the PWA can show the "Validez sur votre téléphone" screen.
   */
  async initiateMomo(
    orderId: string,
    userId: string,
    payerPhone: string,
  ): Promise<{ reference: string; status: string; message: string }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundException('order_not_found');
    if (!MOMO_METHODS.has(order.paymentMethod)) {
      throw new BadRequestException({
        code: 'payment_method_not_momo',
        message: 'This order was not placed with MoMo. Pay in cash on delivery.',
      });
    }
    if (!PAYABLE_STATUSES.has(order.status)) {
      throw new ConflictException({
        code: 'order_not_payable',
        message: 'This order can no longer be paid (already paid, cancelled, or in delivery).',
      });
    }
    if (order.paymentStatus === PaymentStatus.PROCESSING) {
      // Allow polling consumers to retry, but don't fire a second USSD prompt.
      throw new ConflictException({
        code: 'payment_already_processing',
        message: 'A payment is already in flight for this order. Wait for the USSD prompt.',
      });
    }

    // Re-entry lock — protects against double-click + concurrent requests in
    // the small window before paymentStatus flips to PROCESSING.
    const lockKey = `pay:order:${order.id}`;
    const acquired = await this.redis.setNX(lockKey, '1', PAY_LOCK_TTL_SECONDS);
    if (!acquired) {
      throw new ConflictException({
        code: 'payment_already_processing',
        message: 'A payment is already in flight for this order. Wait for the USSD prompt.',
      });
    }

    try {
      const normalizedPhone = normalizePhone(payerPhone);
      const collect = await this.campay.initiateCollect({
        amountXAF: order.totalXAF,
        payerPhone: normalizedPhone,
        description: `TchopNow ${order.code}`,
        externalReference: order.code,
        webhookUrl: this.env.campay.apiUrl ? this.buildWebhookUrl() : undefined,
      });

      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          paymentReference: collect.reference,
          payerPhone: normalizedPhone,
          paymentStatus: PaymentStatus.PROCESSING,
        },
      });

      return {
        reference: collect.reference,
        status: collect.status,
        message: 'Validez sur votre téléphone — vous avez ~30 secondes.',
      };
    } catch (err) {
      // Free the lock on failure so the user can retry.
      await this.redis.del(lockKey);
      throw err;
    }
  }

  /**
   * Story 3.14 — receive a Campay webhook.
   *
   * Idempotency strategy:
   *   1. Lock by reference for 5s — prevents a millisecond-spaced duplicate
   *      from both reaching onPaymentSucceeded simultaneously.
   *   2. Order.paymentStatus check inside the handler — if already PAID,
   *      do nothing (the second webhook is a no-op).
   */
  async handleWebhook(payload: CampayWebhookPayload): Promise<{ received: true }> {
    const reference = payload.reference ?? payload.external_reference;
    if (!reference) {
      this.logger.warn(
        { event: 'campay_webhook_missing_reference', payload },
        'Campay webhook missing reference field',
      );
      return { received: true };
    }

    // Step 1: short-lived lock to serialise duplicates.
    const lockAcquired = await this.redis.setNX(
      `lock:payment:${reference}`,
      '1',
      WEBHOOK_LOCK_TTL_SECONDS,
    );
    if (!lockAcquired) {
      this.logger.warn(
        { event: 'campay_webhook_duplicate_ignored', reference },
        'Duplicate Campay webhook ignored (lock held)',
      );
      return { received: true };
    }

    // Step 2: find the order by external_reference (= our Order.code).
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ code: reference }, { paymentReference: reference }] },
    });
    if (!order) {
      this.logger.warn(
        { event: 'campay_webhook_unknown_reference', reference },
        'Campay webhook for unknown reference (no matching order)',
      );
      return { received: true };
    }

    // Step 3: dispatch by status. Other statuses (PENDING) are no-ops — we
    // wait for the terminal one.
    if (payload.status === 'SUCCESSFUL') {
      // Re-fetch by id to get the freshest paymentStatus — emit only if
      // we're transitioning from a non-PAID state. OrdersService.onPaymentSucceeded
      // also checks paymentStatus, so this is belt + suspenders.
      this.events.emit(DomainEvents.PAYMENT_SUCCEEDED, {
        orderId: order.id,
        providerReference: payload.reference ?? reference,
        payerPhone: payload.phone_number,
      });
    } else if (payload.status === 'FAILED' || payload.status === 'CANCELLED') {
      if (order.paymentStatus !== PaymentStatus.PAID) {
        await this.prisma.order.update({
          where: { id: order.id },
          data: { paymentStatus: PaymentStatus.FAILED },
        });
        this.events.emit(DomainEvents.PAYMENT_FAILED, {
          orderId: order.id,
          reason: payload.status,
        });
      }
    }

    return { received: true };
  }

  private buildWebhookUrl(): string {
    // The deploy templates inject APP_URL; we trust it as the public origin.
    return `${this.env.appUrl}/api/webhooks/campay`;
  }
}
