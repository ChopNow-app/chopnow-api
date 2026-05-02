# Contributing — chopnow-api

> First-time setup is in [`README.md`](./README.md). This file covers what to do **after** you can run the app.

## Branching

- `main` is protected — all changes go through PRs, no direct pushes
- Branch naming: `<story-id>-<short-slug>`
  - `1.1-otp-request`
  - `3.6-order-confirmation-screen`
  - `fix/4.4-rider-heartbeat-flake` (for bug fixes outside a story)
- Branch from `main`, rebase before merging (no merge commits in feature branches)

## Commit messages

Format: `<scope>: <imperative summary>`

Scope = the top-level folder in `src/`: `auth`, `users`, `orders`, `infra`, `shared`, …

Examples:

```
auth: hash OTP with argon2id before storage
orders: emit order.paid on Campay webhook success
infra: add Redis adapter for distributed throttler
fix(auth): clear stale OTP attempts after successful verify
docs: explain dispatch repository pattern in ARCHITECTURE
```

Keep summary under 70 chars. Body (optional) explains _why_, not _what_.

## Story workflow

1. **Claim a card** — drag from `Backlog` → `In Progress` on the [project board](https://github.com/orgs/ChopNow-app/projects/3)
2. **Read the story** — every GitHub issue body links its source-of-truth `.md` in `_bmad-output/planning-artifacts/epics/`. The acceptance criteria there are authoritative; the issue is just a pointer.
3. **Branch + code** — write the happy-path test first if the story has clear inputs/outputs
4. **Open a PR** — the template auto-loads. Tick acceptance criteria as you complete them.
5. **CI must pass** — lint + typecheck + test + build (Husky `pre-push` runs typecheck + test locally first)
6. **Address review** — push fixups, don't force-push during review unless asked
7. **Merge** — closes the issue, board auto-moves card to `Done`

### What "good" looks like — example

PR title: `[1.7] Révocation JWT à la Suspension`
Branch: `1.7-jwt-revocation`
Commits:

```
auth: add Redis-backed token blacklist
auth: blacklist tokens on user suspension event
auth: blacklist check in JwtStrategy.validate
test(auth): cover blacklist hit + expiry purge
```

PR body fills the template — links story 1.7, ticks each acceptance criterion, includes a `curl` test plan.

## Local checks before pushing

```bash
npm run lint               # 0 warnings
npm run typecheck          # 0 errors
npm test                   # all green
npm run build              # produces dist/
```

CI runs the same four commands — be the first one to find your own bug.

Husky also runs:

- **`pre-commit`** — `lint-staged` formats + lints just your staged files (fast)
- **`pre-push`** — full `typecheck` and `test` before allowing the push

To bypass in an emergency: `git commit --no-verify` / `git push --no-verify`. Use sparingly — CI will fail anyway if your bypass was wrong.

## Architecture rules (enforced in review)

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full doc. The 3 rules in 30 seconds:

1. **Modules expose services, not Prisma.** A service in `OrdersService` calls `UsersService.findById()`, never `prisma.user.findUnique()` directly.
2. **Dependencies flow one direction.** `catalogue` → `orders` is allowed; `orders` → `catalogue` is not. If you need to react to an upstream event, subscribe to a domain event.
3. **Cross-module fan-out via domain events.** Producers emit on `EventEmitter2`, consumers subscribe with `@OnEvent`. See `src/modules/orders/orders.service.ts` for the canonical example.

PRs that violate any rule will get review pushback even if they "work."

## Common patterns

### Reading config / env vars

Inject `EnvService` (provided globally), don't read `process.env` directly:

```ts
import { EnvService } from 'src/infra/config/env.service';

@Injectable()
export class FooService {
  constructor(private readonly env: EnvService) {}

  bar() {
    if (this.env.isProduction) {
      /* ... */
    }
    const { sid, authToken } = this.env.requireTwilio(); // throws if missing
  }
}
```

For new env vars: add to **all three** of `.env.example` + `env.validation.ts` (Joi) + `env.service.ts` (typed accessor).

### Adding a domain event

1. Add the event name to `src/shared/events/domain-events.ts` — uppercase snake_case (`ORDER_REFUNDED`)
2. **Producer**: inject `EventEmitter2`, call `events.emit(DomainEvents.X, payload)` after the DB transaction commits — never inside it
3. **Consumer**: in the listening module's service, decorate a method with `@OnEvent(DomainEvents.X)`
4. Document the payload type in the consumer's signature — keep payload shapes small and stable

See `src/modules/orders/orders.service.ts` for the canonical example.

### Adding an external integration (Twilio, Campay, R2, …)

1. Create `src/infra/<provider>/<provider>.service.ts` — wraps the SDK
2. Create `src/infra/<provider>/<provider>.module.ts` — exports the service
3. Add provider env vars to `.env.example` + `env.validation.ts` + `env.service.ts` (with a `requireX()` method)
4. Inject the service into a domain module — never call the raw SDK from `modules/`

### Database migrations

```bash
# After editing prisma/schema.prisma
npm run prisma:migrate -- --name <descriptive_name>
```

Migrations are committed to git. **Never edit a migration that's been pushed.** If schema needs a fix, write a new migration. To roll back in dev: drop the local DB volume (`docker compose down -v`) and re-run all migrations.

### Making a route public

Default: every route is JWT-protected (global `JwtAuthGuard` in `app.module.ts`). To opt out:

```ts
import { Public } from 'src/shared/decorators/public.decorator';

@Public()
@Get('webhook/campay')
handleWebhook() { /* ... */ }
```

### Sanitizing user input

| Type                                               | Tool                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| HTML in vendor descriptions, dispute messages      | `stripHtml()` from `src/shared/sanitize/html.ts`                         |
| URLs we'll fetch (vendor logos, webhook callbacks) | `safeFetch()` from `src/shared/http/safe-fetch.ts`                       |
| Inbound webhook payloads                           | `verifyWebhookSignature()` from `src/shared/crypto/webhook-signature.ts` |
| Phone, OTP, generic shapes                         | `class-validator` decorators on a DTO                                    |

## FAQ

**Q: Should I add a `*.repository.ts` file for my module?**
Not unless your service has 5+ Prisma calls or complex `$queryRaw` (typical for `dispatch/` PostGIS work). For most modules, the service IS the repository.

**Q: Should I emit an event or call the other service directly?**
Direct call if both modules are tightly coupled by design (e.g. `auth` calls `users` to create a record). Event if the consumer's existence is incidental — multiple modules might react. Rule of thumb: if you can't list every consumer, use an event.

**Q: Can I import `@nestjs/config`'s `ConfigService` directly?**
No. Use `EnvService`. The whole point of the typed wrapper is autocomplete and required-vs-optional clarity.

**Q: Where do I put cross-cutting utilities?**
`shared/` if they have no infra deps (pure functions, decorators). `infra/` if they wrap an external resource. Never `modules/`.

**Q: A test needs a real DB. How?**
Today: tests are unit-only with mocked Prisma. When dispatch/PostGIS work lands (Story 4.1), we'll add testcontainers in `test/` — that PR establishes the pattern.

**Q: I need to bump a dep that has a CVE. Process?**
Run `npm audit`, then `npm audit fix` for non-breaking fixes. For breaking changes, open a separate PR labeled `chore:deps` so it can be reviewed in isolation. Never bundle dep upgrades with feature work.
