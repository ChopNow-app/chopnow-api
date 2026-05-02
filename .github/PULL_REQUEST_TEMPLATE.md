<!-- Title format: [<story-id>] <Story name> — <slice if needed> -->
<!-- Examples: [1.1] Inscription Consommateur par OTP — backend route -->

## Story

Closes #<issue-number>
Story ID: **<e.g. 1.1, 3.6>**
Epic: **<E1 Auth · E2 Catalogue · E3 Commande · E4 Livraison · E5 WhatsApp · E6 Admin · E7 Finance>**

## Summary

<!-- 1-3 bullets: what changed and why. Link the source-of-truth epic file. -->
- 

## Acceptance criteria checklist

<!-- Copy the checklist from the story's `.md` file in `_bmad-output/planning-artifacts/epics/` and tick what this PR delivers.
     If a criterion is deferred, prefix with [SKIP] and add a follow-up issue link. -->

- [ ] 
- [ ] 
- [ ] 

## Test plan

<!-- How a reviewer can verify this works. Concrete commands beat vague descriptions. -->

```bash
# Example
curl -X POST http://localhost:3001/api/auth/request-otp \
  -H 'Content-Type: application/json' -d '{"phone":"670000000"}'
```

## Architecture rules respected

- [ ] No `PrismaService` injection outside the module that owns the table
- [ ] Cross-module reactions go through domain events (`shared/events/domain-events.ts`), not direct service calls
- [ ] No new `dependency` between modules that flows the wrong way (see `ARCHITECTURE.md`)

## Security checklist

- [ ] No secrets, API keys, or credentials added to code or `.env.example`
- [ ] User input passes through `class-validator` DTOs
- [ ] User-supplied URLs are fetched via `shared/http/safeFetch` (SSRF-safe)
- [ ] User-supplied text fields rendered server-side go through `shared/sanitize/stripHtml`
- [ ] New external webhooks verify HMAC via `shared/crypto/verifyWebhookSignature`
- [ ] Sensitive routes have explicit `@Roles(...)` (when RBAC lands)

## Migrations

- [ ] No DB schema change — N/A
- [ ] Schema change — `prisma/migrations/<timestamp>_<name>/` committed and idempotent
- [ ] Backward-compatible (no breaking column drops without a deprecation step)

## Deferred / follow-ups

<!-- Anything intentionally left for a follow-up PR. Open the GitHub issue and link here. -->
- 

## Screenshots / videos (UI changes only)

<!-- Drop screenshots here. For mobile UX, include a small iPhone-frame screenshot. -->
