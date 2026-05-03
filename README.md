# chopnow-api

Backend for **ChopNow** — a food delivery platform built for Douala, Cameroon. Connects three actors:

- **Consumers** order food from local vendors
- **Vendeurs** (vendors) — both restaurants and informal "Maman" cuisinières — manage menus and receive orders
- **Livreurs** (riders) — moto / vélo / car / on-foot — pick up and deliver

This repo is the **NestJS 11 + Prisma 6** backend. The PWA frontend lives in [`chopnow-app`](https://github.com/ChopNow-app/chopnow-app). Sprint 1 starts **2026-05-04** — see the [project board](https://github.com/orgs/ChopNow-app/projects/3).

---

## Day 1 — get running in 10 minutes

### Prerequisites

| Tool               | Version    | Install                                                                                  |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------- |
| **Node.js**        | 22 LTS     | `nvm install 22 && nvm use 22` (recommended) — or `brew install node@22`                 |
| **npm**            | ≥ 10       | Bundled with Node 22                                                                     |
| **Docker Desktop** | latest     | https://www.docker.com/products/docker-desktop/ — must be running before `npm run db:up` |
| **Git**            | any modern | Pre-installed on macOS, `apt install git` on Ubuntu                                      |
| **OpenSSL**        | any        | Pre-installed on macOS / Linux. Used by `scripts/generate-secrets.sh`.                   |

Supported on **macOS**, **Linux**, and **Windows + WSL2**. Native Windows is not tested.

### 5-command setup

```bash
# 1. Clone
git clone git@github.com:ChopNow-app/chopnow-api.git
cd chopnow-api

# 2. Pin Node 22
nvm use

# 3. Generate local JWT secrets (writes .env, gitignored)
./scripts/generate-secrets.sh

# 4. Install + boot Postgres/Redis + apply DB schema
npm install
npm run db:up
npm run prisma:migrate

# 5. Start the dev server (auto-reloads)
npm run start:dev
```

If you see this in the terminal, you're done:

```
[Nest] Application successfully started on port 3001
```

### Verify it works

```bash
curl http://localhost:3001/health
# → {"status":"ok","uptime":...}

curl http://localhost:3001/ready
# → {"status":"ready","db":"up"}

curl -X POST http://localhost:3001/api/auth/request-otp \
  -H 'Content-Type: application/json' \
  -d '{"phone":"670000000"}'
# → {"ok":true,"expiresInSeconds":300}
```

Open Swagger UI in a browser:
👉 **http://localhost:3001/api/docs**

You should see the `auth`, `users`, and `health` endpoints documented.

---

## Troubleshooting

| Error                                                              | What it means                         | Fix                                                                              |
| ------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon`                              | Docker Desktop not running            | Open Docker Desktop, wait for the whale icon to be steady, retry `npm run db:up` |
| `connect ECONNREFUSED 127.0.0.1:5432`                              | App started before Postgres was ready | Run `npm run db:up`, wait 5s, then `npm run start:dev`                           |
| `Joi validation: JWT_ACCESS_SECRET must be at least 32 characters` | Secrets not generated                 | Run `./scripts/generate-secrets.sh` then restart                                 |
| `Cannot find module '@prisma/client'`                              | Prisma client not generated           | Run `npx prisma generate` (or just `npm install` again)                          |
| `EADDRINUSE: address already in use :::3001`                       | Old dev server still running          | `lsof -ti:3001 \| xargs kill -9` then retry                                      |
| `Migration failed: relation "users" does not exist`                | DB not migrated                       | `npm run prisma:migrate`                                                         |
| `npm install` hangs on argon2                                      | Native build failure                  | Ensure Xcode Command Line Tools (macOS): `xcode-select --install`                |

If you hit something not listed, post in `#chopnow-dev` and we'll add it here.

---

## What env vars do I need for which Story?

`.env` is auto-created by `scripts/generate-secrets.sh` with safe defaults for DB, Redis, and JWT secrets. Other vars are needed only when you work on stories that use them:

| Story / Epic                               | Required env vars                                                                    | Where to get them                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **Day 1 boot, health checks, JWT signing** | none beyond defaults                                                                 | —                                                    |
| **Story 1.1** OTP delivery                 | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_SMS_FROM` | Twilio console — ping the lead for sandbox creds     |
| **Story 1.11** Web Push                    | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`                             | Generate locally: `npx web-push generate-vapid-keys` |
| **Stories 3.3 / 3.4** Payments             | `CAMPAY_API_URL`, `CAMPAY_USERNAME`, `CAMPAY_PASSWORD`, `CAMPAY_WEBHOOK_SECRET`      | Campay sandbox — ping the lead                       |
| **Story 2.11** Vendor photo upload         | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`             | Cloudflare R2 dashboard                              |

Services check at request time and throw `Twilio is not configured — set TWILIO_* env vars` if used without setup. So you can develop unrelated stories without filling these.

---

## What to do next

1. **Read [`ARCHITECTURE.md`](./ARCHITECTURE.md)** (5 min) — the 3 module-boundary rules. Every PR is reviewed against them.
2. **Read [`CONTRIBUTING.md`](./CONTRIBUTING.md)** (5 min) — branching, commits, story workflow, patterns for adding events/integrations.
3. **Pick a card** from the [project board](https://github.com/orgs/ChopNow-app/projects/3): drag from `Backlog` → `In Progress`. Sprint 1 cards (milestone `Sprint 1`) are tagged P0 critical.
4. **Find the story file** — every GitHub issue body links to its source-of-truth `.md` in `_bmad-output/planning-artifacts/epics/` (private planning repo).
5. **Branch, code, PR.** The PR template auto-loads with the acceptance-criteria checklist.

### Recommended first stories (low risk, good for ramp-up)

- **1.7** Révocation JWT à la Suspension — small, isolated, exercises Redis
- **1.12** Réinitialisation Mot de Passe Admin — flow you've probably built before
- **2.15** Infrastructure Landmarks — DB seed work, no external deps

---

## Stack

- **NestJS 11** · **Prisma 6** · **TypeScript 5.7** · **Node 22 LTS** · **PostgreSQL 16 + PostGIS** · **Redis 7**
- **SWC** for transpile (~50× faster than tsc) · **Jest** for tests · **testcontainers** for integration · **ESLint 9** flat config · **Husky** pre-commit
- **Helmet** + **CORS allow-list** + **Throttler** (global + per-route) + **PhoneRateLimit guard** + **ValidationPipe** + 1MB body limit
- **Argon2id** for OTP/password hashing · **JWT** (access 24h + refresh 30d, separate secrets, ≥32 chars) · **Global JwtAuthGuard + RolesGuard**
- **SSRF-safe outbound fetch** (`shared/http/safeFetch`) · **HMAC webhook verify** (`shared/crypto/`) · **DOMPurify** HTML sanitize · **Idempotency interceptor**
- **OpenAPI** auto-generated from controllers · **Pino** structured logs

### Infrastructure adapters (`src/infra/`)

- **prisma** — `PrismaService` (global)
- **redis** — `RedisService` (ioredis); used for JWT blacklist, idempotency, phone rate limit
- **twilio** — `TwilioService` + `OtpDeliveryService` (WhatsApp → SMS fallback)
- **r2** — `R2Service` (Cloudflare R2 + Sharp image pipeline + signed URLs)
- **mail** — `MailService` (Resend) for transactional emails
- **config** — `EnvService` typed wrapper + Joi validation

## Repo layout

```
chopnow-api/
├── src/
│   ├── main.ts                   # Helmet, CORS, validation, OpenAPI bootstrap
│   ├── app.module.ts             # Wires modules + global guards (JWT + Throttler)
│   ├── app.version.ts            # APP_VERSION constant
│   ├── modules/                  # Domain bounded contexts (one per Epic)
│   │   ├── auth/                 # Epic 1 — OTP, JWT, RBAC
│   │   ├── users/                # All roles (consumer / vendor / rider / admin)
│   │   ├── catalogue/            # Epic 2 — placeholder
│   │   ├── orders/               # Epic 3 — event-pattern reference impl
│   │   ├── payments/             # Epic 3 + 7 — placeholder
│   │   ├── dispatch/             # Epic 4 — placeholder
│   │   ├── notifications/        # Cross-cutting — placeholder
│   │   ├── finance/              # Epic 7 — placeholder
│   │   └── admin/                # Epic 6 — placeholder
│   ├── infra/                    # Infrastructure adapters
│   │   ├── prisma/
│   │   └── config/               # EnvService (typed env wrapper) + Joi validation
│   ├── shared/                   # Reusable, no infra deps
│   │   ├── decorators/           # @Public
│   │   ├── guards/               # JwtAuthGuard
│   │   ├── filters/              # AllExceptionsFilter
│   │   ├── events/               # Domain event names registry
│   │   ├── crypto/               # verifyWebhookSignature (HMAC, timing-safe)
│   │   ├── http/                 # safeFetch (SSRF-blocked)
│   │   └── sanitize/             # stripHtml, sanitizeBasicHtml
│   └── health/                   # /health, /ready
├── prisma/
│   ├── schema.prisma             # Sprint 1 schema; grows per epic
│   └── migrations/0_init/        # Initial migration (committed, idempotent)
├── scripts/
│   └── generate-secrets.sh       # Writes safe random JWT secrets into .env
├── docker-compose.yml            # postgres-postgis:16 + redis:7
├── Dockerfile                    # Multi-stage, non-root, Node 22 alpine
├── ARCHITECTURE.md               # The 3 module-boundary rules
├── CONTRIBUTING.md               # Workflow + conventions
└── .github/
    ├── workflows/ci.yml          # Lint + typecheck + test + build (disabled until Sprint 1)
    └── PULL_REQUEST_TEMPLATE.md  # Auto-loaded acceptance-criteria checklist
```

## Useful commands

```bash
# Daily dev
npm run start:dev          # http://localhost:3001 (auto-reloads)
npm run prisma:studio      # GUI at http://localhost:5555

# Before pushing
npm run lint               # 0 warnings
npm run typecheck          # 0 errors
npm test                   # all green
npm run build              # produces dist/

# OpenAPI spec for the frontend team
npm run openapi:export     # writes openapi.json (gitignored)

# Database
npm run prisma:migrate     # applies pending migrations
npm run db:up              # starts Postgres + Redis
npm run db:down            # stops them (data persisted in Docker volumes)
```

## API contract

OpenAPI 3 spec is auto-generated from controllers + DTOs.

- **Live UI**: http://localhost:3001/api/docs
- **JSON**: http://localhost:3001/api/docs-json
- **Export to file**: `npm run openapi:export` → writes `openapi.json` (feed this to the frontend's typed client generator)

## Architecture (TL;DR)

**Modular monolith with domain-event fan-out.** Single deployable, single Postgres, multiple bounded contexts. Three rules:

1. Modules expose services, not Prisma
2. Dependencies flow one direction
3. Cross-module fan-out via domain events

Full reasoning + extraction roadmap in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## License

Proprietary — All Rights Reserved. See `LICENSE`.
