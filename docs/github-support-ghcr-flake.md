# Draft — GitHub Support ticket: intermittent GHCR push auth flake

> **Status**: draft, never filed. Stored here for posterity + because the
> retry workaround (PR #265) closes the user-visible symptom. File this if
> the flake recurs at a rate the retry can't absorb (3+ "all 3 attempts
> failed" events in 30 days), OR if escalating to GitHub will move faster
> than rebuilding the auth path on our side.

---

**Subject:** Intermittent `unauthorized: unauthenticated` on `docker push` to GHCR — mid-push, after partial layer success

**Issue type:** GitHub Actions / Container Registry (GHCR)

---

## Summary

`docker push` to `ghcr.io/chopnow-app/chopnow-api` from our GitHub Actions
workflow fails intermittently with `unauthorized: unauthenticated: User
cannot be authenticated with the token provided`. The error consistently
lands **mid-push, after several layers have already been successfully
pushed**, never at login time or on the first layer. The same workflow,
with no changes, succeeds when re-run.

8 occurrences over 9 days. We use the canonical `github.actor` +
`secrets.GITHUB_TOKEN` pattern from the GitHub docs. We're confident the
issue is server-side and would appreciate a look at the GHCR-side auth
logs for these runs.

---

## Repro / evidence

Failing runs (all on the same workflow file, same actor):

| Date (UTC)                            | Run ID                                                              |
| ------------------------------------- | ------------------------------------------------------------------- |
| 2026-05-23 09:26:51                   | https://github.com/ChopNow-app/chopnow-api/actions/runs/26329231056 |
| 2026-05-23 09:06:28 (rerun succeeded) | https://github.com/ChopNow-app/chopnow-api/actions/runs/26328851245 |
| 2026-05-23 08:10:21 (rerun succeeded) | https://github.com/ChopNow-app/chopnow-api/actions/runs/26327761603 |
| 2026-05-21 17:37:04                   | https://github.com/ChopNow-app/chopnow-api/actions/runs/26242644271 |
| 2026-05-21 12:07:36                   | https://github.com/ChopNow-app/chopnow-api/actions/runs/26224935276 |
| 2026-05-21 11:49:32                   | https://github.com/ChopNow-app/chopnow-api/actions/runs/26224087222 |
| 2026-05-21 11:08:29                   | https://github.com/ChopNow-app/chopnow-api/actions/runs/26222251070 |
| 2026-05-20 19:12:09                   | https://github.com/ChopNow-app/chopnow-api/actions/runs/26184217470 |
| 2026-05-14 04:32:00                   | https://github.com/ChopNow-app/chopnow-api/actions/runs/25841798202 |

Failure pattern is identical in every log:

```
46cb65a5e414: Pushed
unauthorized: unauthenticated: User cannot be authenticated with the token provided.
##[error]Process completed with exit code 1.
```

`Pushed` for ~12 of ~14 layers, then the unauthorized error on the next
blob. Total push duration before failure: ~7–10 seconds.

---

## Workflow config (relevant excerpt)

```yaml
# .github/workflows/cd-staging.yml
on:
  push:
    branches: [staging]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    permissions:
      contents: read
      packages: write # ← granted

    steps:
      - uses: actions/checkout@v4

      - name: Login to ghcr.io
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build + push amd64 staging image
        run: |
          IMAGE_REPO=ghcr.io/${{ github.repository_owner }}/chopnow-api
          IMAGE_REPO_LC=$(echo "$IMAGE_REPO" | tr '[:upper:]' '[:lower:]')
          docker build -t "$IMAGE_REPO_LC:staging-${{ github.sha }}" -t "$IMAGE_REPO_LC:staging" .
          docker push "$IMAGE_REPO_LC:staging-${{ github.sha }}"
          docker push "$IMAGE_REPO_LC:staging"
```

This is the canonical pattern from the "Working with the Container
registry" docs. We have NOT modified the underlying push.

---

## What we ruled out on our side

| Hypothesis                               | Verdict                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Token permission missing                 | ❌ `packages: write` set; would fail at login                               |
| Wrong username (`github.actor` mismatch) | ❌ Successes use the same actor                                             |
| Token expired mid-push                   | ❌ Push completes in ~10s; `GITHUB_TOKEN` TTL is job duration (~1h)         |
| Local docker config drift                | ❌ Runner is ephemeral, fresh each job                                      |
| Per-user rate limit                      | ❌ Same actor's pushes succeed and fail intermittently — not identity-bound |

---

## Workaround we've shipped

We've wrapped `docker push` in a 3-attempt retry with `docker login`
between attempts (PR #265). It works ~80% of the time when a flake hits.
But the workaround masks an upstream issue we'd like understood.

---

## Pattern that may help your investigation

Failures **cluster on high-traffic CD days**:

- 2026-05-21: 4 failures across 6 hours (3 within 60 min)
- 2026-05-23: 2 unique failures within 2 hours (plus 2 reruns that also failed)
- Quiet days (20+ successful pushes): zero failures

Successes also happen back-to-back on busy days, so it's not a strict
"N pushes/minute → fail" pattern. Looks more like a stateful condition
where concurrent per-blob auth challenges from the same `org/repo`
namespace race with each other on the GHCR side, with the race window
opening up under certain (unknown to us) load conditions.

---

## What we're asking

1. Could you check GHCR's server-side logs for the run IDs above?
   Specifically: the per-blob auth challenge timing for the failing push
   and the request immediately preceding it.
2. Is there a known issue around concurrent blob auth challenges for
   `GITHUB_TOKEN`-authenticated pushes from a single org?
3. Should we switch to a PAT (`write:packages` scope) instead of
   `GITHUB_TOKEN`? The docs prefer `GITHUB_TOKEN` for security, but if
   PAT bypasses this class of issue it would be worth the trade-off.

Thanks!
