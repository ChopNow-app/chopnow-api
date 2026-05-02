# Contributing — chopnow-api

## Setup (first time)

```bash
nvm use                          # Node 22
./scripts/generate-secrets.sh    # writes JWT_*_SECRET into .env
npm install
npm run db:up                    # postgres-postgis + redis via Docker
npm run prisma:migrate           # apply migrations
npm run start:dev                # http://localhost:3001
```

## Branching

- `main` — protected, all changes via PR, no direct push
- Feature branch naming: `<story-id>-<short-slug>` — e.g. `1.1-otp-request`, `3.6-order-confirmation`
- Branch from `main`, rebase before merging

## Commit messages

Convention: `<scope>: <short imperative summary>`

```
auth: hash OTP with argon2id before storage
orders: emit order.paid on Campay webhook success
infra: add Redis adapter for distributed throttler
fix(auth): clear stale OTP attempts after successful verify
```

Scope = the top-level folder in `src/` (`auth`, `users`, `orders`, `infra`, `shared`, …).

## Architecture (read before contributing)

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the 3 module-boundary rules:

1. Modules expose services, not Prisma
2. Dependencies flow one direction
3. Cross-module fan-out via domain events (`shared/events/domain-events.ts`)

PRs that violate any of the 3 will get review pushback even if they work.

## Story workflow

1. Pick a card from the [project board](https://github.com/orgs/ChopNow-app/projects/3) — drag from `Backlog` → `In Progress`
2. Read the matching story file in `_bmad-output/planning-artifacts/epics/epic-X-*.md` (the GitHub issue body links it)
3. Branch, code, write a test for at least the happy path
4. Open a PR following the template — fill the acceptance-criteria checklist
5. CI must pass (lint + typecheck + test + build)
6. After merge, close the issue (board auto-moves card to `Done`)

## Local checks before pushing

```bash
npm run lint       # 0 warnings
npm run typecheck  # 0 errors
npm test           # all green
npm run build      # produces dist/
```

CI runs the same four commands — be the first one to find your own bug.

## Adding a new domain event

When your story needs cross-module fan-out:

1. Add the event name to `src/shared/events/domain-events.ts` — uppercase snake_case (`ORDER_REFUNDED`)
2. Producer: inject `EventEmitter2`, call `events.emit(DomainEvents.X, payload)` after the DB transaction commits
3. Consumer: in the listening module's service, decorate a method with `@OnEvent(DomainEvents.X)`
4. Document the payload type in the consumer's signature — there is no central event type registry yet, keep payload shapes small and stable

See `src/modules/orders/orders.service.ts` for the canonical example.

## Adding a new external integration (Twilio, Campay, R2, …)

Pattern:
1. Create `src/infra/<provider>/<provider>.service.ts` — wraps the SDK
2. Create `src/infra/<provider>/<provider>.module.ts` — exports the service
3. Add provider env vars to `.env.example` AND `src/infra/config/env.validation.ts` (Joi)
4. Inject the service into a domain module — never call the raw SDK from `modules/`

## Database migrations

```bash
# After editing prisma/schema.prisma
npm run prisma:migrate -- --name <descriptive_name>

# Migrations are committed to git. Never edit a migration that's been pushed.
# To roll back in dev: drop the local DB and re-run all migrations.
```

## Required `.env` values for development

The Joi schema in `src/infra/config/env.validation.ts` is authoritative — the app refuses to start with weak/missing secrets. The `scripts/generate-secrets.sh` helper writes safe random `JWT_*_SECRET` values for you.

External SDK keys (Twilio, Campay, R2) are optional in dev — services that need them check at request time and fail with a clear error message.
