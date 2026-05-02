# chopnow-api — Architecture

**Style:** Modular monolith with domain-event fan-out. Single deployable, single Postgres, multiple bounded contexts.

## Why a modular monolith (not microservices, not a flat app)

| Constraint | Implication |
|---|---|
| 2-person team, single Hetzner VPS | No bandwidth for k8s / service mesh |
| Cross-domain transactions (`orders` ↔ `users` ↔ `payments`) | One DB transaction beats sagas |
| Postgres + PostGIS for geo dispatch | Splitting the DB kills query perf |
| Future-proof for extraction | Domain modules can become microservices when a hotspot demands it |

## Layered structure

```
src/
├── modules/                    ← domain modules (one bounded context each)
│   ├── auth/                   ← Epic 1 — OTP, JWT, RBAC, blacklist
│   ├── users/                  ← all roles (consumer/vendor/rider/admin)
│   ├── catalogue/              ← Epic 2 — vendors, items, availability
│   ├── orders/                 ← Epic 3 — cart, lifecycle, ratings
│   ├── payments/               ← Epic 3 + 7 — Campay, refunds
│   ├── dispatch/               ← Epic 4 — rider assignment, GPS
│   ├── notifications/          ← Web Push + WhatsApp + SMS fan-out
│   ├── finance/                ← Epic 7 — payouts, settlement, KYC
│   └── admin/                  ← Epic 6 — ops, audit, anti-abuse
├── infra/                      ← infrastructure adapters (replaceable)
│   ├── prisma/
│   ├── config/                 ← Joi env validation
│   └── (redis, twilio, campay, r2, push — added per-epic)
├── shared/                     ← reusable, no infra deps
│   ├── decorators/             ← @Public, @Roles, @CurrentUser
│   ├── guards/
│   ├── filters/
│   └── events/
│       └── domain-events.ts    ← single source of truth for event names
├── health/                     ← /health + /ready (no domain logic)
├── app.module.ts               ← wires everything
└── main.ts                     ← Helmet, CORS, ValidationPipe
```

## The 3 rules that keep it healthy

### Rule 1 — Modules expose services, not Prisma

Cross-module data access goes through public services:

```ts
// ✅ OrdersService.create()
constructor(private readonly users: UsersService) {}
const buyer = await this.users.findById(userId);

// ❌ never:
constructor(private readonly prisma: PrismaService) {}
await this.prisma.user.findUnique({ where: { id: userId } }); // in OrdersService
```

`PrismaService` is only injected inside the module that owns the table.

### Rule 2 — Dependencies flow one direction

```
infra/  ───┐
shared/ ───┼──→ used by everything
           │
   modules/auth ───→ everyone needs auth context
   modules/users ───→ catalogue, orders, dispatch, finance
   modules/catalogue ───→ orders
   modules/orders ───→ dispatch, payments, finance, notifications
   modules/payments ───→ finance, notifications
   modules/dispatch ───→ notifications
```

**Reverse imports are forbidden.** `catalogue` cannot import `orders`. If you need to react to an order event, subscribe to a domain event — never import the upstream module.

### Rule 3 — Cross-module fan-out via domain events

Producers emit, consumers subscribe — **no direct calls between unrelated modules.**

```ts
// modules/orders/orders.service.ts (producer)
@Injectable()
export class OrdersService {
  constructor(private readonly events: EventEmitter2) {}

  async markPaid(orderId: string) {
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
    this.events.emit(DomainEvents.ORDER_PAID, { orderId });
  }
}

// modules/dispatch/dispatch.service.ts (consumer)
@Injectable()
export class DispatchService {
  @OnEvent(DomainEvents.ORDER_PAID)
  async handleOrderPaid({ orderId }: OrderPaidPayload) {
    await this.assignRider(orderId);
  }
}
```

This is what makes the monolith **extractable**: when `dispatch` becomes a hotspot, those `@OnEvent` listeners become message-queue consumers. Same code, different transport.

Event names live in `src/shared/events/domain-events.ts` — keep them stable across refactors.

## When to extract a module to a service

Don't extract preemptively. Extract when **one** of these is true:

- A module's CPU/memory profile differs sharply from the rest (e.g. `dispatch` doing geo-queries pegs the box)
- A module needs an independent deploy cadence (e.g. WhatsApp bot ships hourly)
- A module needs a different runtime (Python ML model, Go for raw throughput)
- A team owns a module exclusively and merges block other teams

For ChopNow MVP, none of these are true. Stay monolith.

## Tests

- **Unit** — service-level, mock Prisma at the module boundary
- **Integration** — module-level, real Prisma against ephemeral Postgres (testcontainers)
- **E2E** — full HTTP, real DB, mocked external SDKs (Campay, Twilio)

## What grows per-epic

Each Sprint 1 story lands code in:
- `modules/<domain>/` — the actual feature
- `infra/<adapter>/` — only if a new external dep is added (e.g. `infra/twilio/` for Story 1.1)
- `shared/events/domain-events.ts` — only if a new event name is needed

If a story adds 2+ new event names or touches 3+ modules, that's a signal to discuss the design before merging.
