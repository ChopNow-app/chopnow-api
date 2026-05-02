# chopnow-api

ChopNow backend — NestJS 10 + Prisma 5 + PostgreSQL/PostGIS 16 + Redis 7.

## Scope

| Domain | Stack |
|---|---|
| Auth & OTP | Twilio WhatsApp (primary) + Twilio SMS (fallback) |
| Payments | Campay SDK — MTN MoMo + Orange Money |
| Voice proxy | Twilio Voice (TwiML Dial bridge) — livreur ↔ client masked calls |
| Dispatch | PostGIS geo-queries, Redis pub/sub for livreur GPS heartbeats (15s) |
| Push | Web Push API + VAPID (no Firebase) |
| Media | Cloudflare R2 + Sharp |
| Hosting | Hetzner VPS |

## Status

Sprint 1 starts **2026-05-04**. See [project board](https://github.com/orgs/ChopNow-app/projects/3) for delivery tracking.

## Quick start

```bash
nvm use                  # Node 22
cp .env.example .env     # placeholders work for local dev
npm install
npm run db:up            # postgres-postgis:16 + redis:7 via Docker
npm run prisma:migrate   # applies the Sprint 1 schema (User, OtpLog, PushSubscription)
npm run start:dev        # http://localhost:3001
```

Health checks:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/ready
```

OTP smoke test (Sprint 1 Story 1.1 — delivery wired in story):

```bash
curl -X POST http://localhost:3001/api/auth/request-otp \
  -H 'Content-Type: application/json' \
  -d '{"phone":"670000000"}'
```

## Architecture

**Modular monolith with domain-event fan-out.** See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full layered diagram, the 3 module-boundary rules, and when to extract a module to a service.

```
chopnow-api/
├── src/
│   ├── main.ts                   # Helmet, CORS, validation pipes
│   ├── app.module.ts             # wires ConfigModule + EventEmitter + Pino + modules
│   ├── modules/                  # domain bounded contexts (one per Epic)
│   │   ├── auth/                 # Epic 1 — OTP, JWT, RBAC, blacklist
│   │   ├── users/                # all roles (consumer/vendor/rider/admin)
│   │   ├── catalogue/            # Epic 2
│   │   ├── orders/               # Epic 3
│   │   ├── payments/             # Epic 3 + 7 — Campay
│   │   ├── dispatch/             # Epic 4 — PostGIS geo-queries
│   │   ├── notifications/        # Push + WhatsApp + SMS fan-out
│   │   ├── finance/              # Epic 7 — payouts, KYC
│   │   └── admin/                # Epic 6 — ops, audit
│   ├── infra/                    # infrastructure adapters
│   │   ├── prisma/
│   │   └── config/               # Joi env validation
│   ├── shared/                   # reusable, no infra deps
│   │   ├── decorators/           # @Public, @Roles
│   │   ├── guards/               # JwtAuthGuard
│   │   ├── filters/
│   │   └── events/               # domain event names (single source of truth)
│   └── health/                   # /health + /ready
├── prisma/
│   └── schema.prisma             # 3 tables for Sprint 1; grows per epic
├── docker-compose.yml            # postgres-postgis:16 + redis:7
├── Dockerfile                    # multi-stage, non-root, Node 22 alpine
├── ARCHITECTURE.md               # the 3 rules
└── .github/workflows/ci.yml      # disabled until Sprint 1
```

## Stack

- **NestJS 10**, **Prisma 5**, **TypeScript 5.7**, **Node 22 LTS**
- **Helmet** — HTTP security headers (XSS, clickjacking, HSTS)
- **Throttler** — rate limiting (default 100 req/min per IP)
- **Argon2** — OTP and password hashing
- **Joi** — env validation, fail-fast on missing secrets
- **Pino** — structured JSON logs (pretty in dev)
- **PostGIS** — geo queries for dispatch (Epic 4)

## Epics

E1 Auth · E2 Catalogue · E3 Commande · E4 Livraison · E5 WhatsApp · E6 Admin · E7 Finance

## License

Proprietary — All Rights Reserved. See `LICENSE`.
