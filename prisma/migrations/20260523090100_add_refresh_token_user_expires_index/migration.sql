-- DB hardening — composite (userId, expiresAt) index on refresh_tokens.
--
-- AuthService.refresh runs:
--   prisma.refreshToken.findMany({
--     where: { userId, expiresAt: { gt: new Date() } },
--     orderBy: { createdAt: 'desc' },
--   })
--
-- Today this uses the existing @@index([userId]) and applies the
-- expiresAt filter on the candidate rows. At pilot scale that's fine
-- (a single user has 1-5 active rows max). At scale, a composite index
-- on (userId, expiresAt) lets Postgres skip expired rows during the
-- index scan rather than fetching + filtering them.
--
-- Same rationale as the GIST migration on CONCURRENTLY — refresh_tokens
-- is small at pilot scale (~ users * 1-5 rows) so the brief table lock
-- is fine.

CREATE INDEX "refresh_tokens_userId_expiresAt_idx"
  ON "refresh_tokens"("userId", "expiresAt");
