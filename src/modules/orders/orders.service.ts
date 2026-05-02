import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { DomainEvents } from '../../shared/events/domain-events';

/**
 * Reference implementation of the domain-event pattern (Architecture Rule #3).
 * Devs landing real Stories 3.x should follow this shape.
 *
 * Producer: emit named events on EventEmitter2 — never call cross-module services directly.
 * Consumer: subscribe with @OnEvent(EventName) — handler runs in-process today,
 *           becomes a queue worker the day a module is extracted.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly events: EventEmitter2) {}

  /**
   * Example producer — Story 3.3/3.4 will replace this with the real flow.
   * After Campay confirms payment, mark order PAID and let dispatch / notifications react.
   */
  async markPaid(orderId: string): Promise<void> {
    // ...persistence logic lands here (Story 3.6)...
    this.events.emit(DomainEvents.ORDER_PAID, { orderId, paidAt: new Date() });
  }

  /**
   * Example consumer — orders module also reacts to its own events for audit logging.
   * Cross-module consumers (DispatchService, NotificationsService) live in their own modules.
   */
  @OnEvent(DomainEvents.ORDER_PAID)
  handleOrderPaid(payload: { orderId: string; paidAt: Date }): void {
    this.logger.log(`order.paid → ${payload.orderId} at ${payload.paidAt.toISOString()}`);
  }
}
