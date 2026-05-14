# ChopNow — Production deployment checklist

The code is MVP-complete. The remaining gap to "real users can pay real money" is operational. This guide walks the three parallel async tracks. Each can start today; none blocks the others.

---

## Track A — Frontend on Vercel

**Goal:** `https://tchopnow.app` (or temporary `*.vercel.app` until DNS lands) serves the PWA.

### A.1 Connect the repo

1. https://vercel.com → New Project → Import `ChopNow-app/chopnow-app`.
2. Framework preset: **Next.js** (auto-detected).
3. Root directory: leave default (`.`).
4. Build command: default (`next build`).
5. Output directory: default (`.next`).
6. Node version: 22.x (set in Vercel project settings → General).

### A.2 Environment variables

Set these per-environment (Preview = staging, Production = prod). Vercel's UI: Project → Settings → Environment Variables.

| Variable                       | Preview                                     | Production                       |
| ------------------------------ | ------------------------------------------- | -------------------------------- |
| `NEXT_PUBLIC_API_URL`          | `https://api-staging.tchopnow.app`          | `https://api.tchopnow.app`       |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | (paste staging VAPID public key)            | (paste prod VAPID public key)    |
| `NEXT_PUBLIC_MAPBOX_TOKEN`     | (optional, fine to leave empty for staging) | (production Mapbox public token) |
| `NEXT_PUBLIC_POSTHOG_KEY`      | (optional)                                  | (optional)                       |
| `NEXT_PUBLIC_POSTHOG_HOST`     | (optional)                                  | (optional)                       |

> ⚠️ Vercel injects `NEXT_PUBLIC_*` at build time. Bumping any of these requires a redeploy (Project → Deployments → Redeploy).

### A.3 Branch deploys

- Production: deploys from `develop` branch (or rename to `main` per Vercel default — your call).
- Preview: every PR gets its own URL automatically.
- Skip the `feat/*` branch deploys if you want to save build minutes: Settings → Git → "Ignored Build Step" with `git diff --quiet HEAD^ HEAD ./` style guard.

### A.4 First deploy verification

- [ ] Vercel build succeeds (CI already runs the same `npm run build`).
- [ ] Open the preview URL → `/login` renders.
- [ ] DevTools network: API calls hit `NEXT_PUBLIC_API_URL` not `localhost:3001`.
- [ ] CSP no longer logs errors (CSP config in `next.config.ts` only relaxes for dev).

---

## Track B — Domain + DNS

**Goal:** `tchopnow.app` resolves to Vercel (frontend) + `api.tchopnow.app` resolves to Hetzner (backend).

### B.1 Register

Shortlist (Cameroon-friendly registrars, all support `.app`):

- **Namecheap** — straightforward, free WHOIS privacy. ~$15/yr.
- **Cloudflare Registrar** — at-cost pricing, includes DNS. ~$12/yr. _Preferred_ — cleanest experience.
- **Porkbun** — also at-cost. Good for `.app`.

`.app` TLD requires HTTPS (Google-mandated). All our cert work is automated via Vercel + Caddy / nginx-letsencrypt on Hetzner — no manual cert work.

### B.2 DNS records (post-registration)

Point at Cloudflare (use it as DNS even if you didn't buy the domain there — better DDoS protection + analytics).

| Type    | Name          | Value                                  | Notes                                   |
| ------- | ------------- | -------------------------------------- | --------------------------------------- |
| `A`     | `@`           | (Vercel A record from their dashboard) | Apex → Vercel                           |
| `CNAME` | `www`         | `cname.vercel-dns.com`                 | www subdomain → Vercel                  |
| `A`     | `api`         | (Hetzner CAX11 public IP)              | Backend                                 |
| `A`     | `api-staging` | (DigitalOcean droplet IP)              | Backend staging                         |
| `MX`    | `@`           | (your email provider's MX)             | Future: support@tchopnow.app via Resend |
| `TXT`   | `@`           | `v=spf1 include:resend.com -all`       | Email auth (when Resend is live)        |

### B.3 Verification

- [ ] `dig tchopnow.app` returns Vercel IP.
- [ ] `https://tchopnow.app/login` loads with valid cert.
- [ ] `https://api.tchopnow.app/health` returns `{"status":"ok"}`.

---

## Track C — Campay Go-Live

**Goal:** real MTN MoMo + Orange Money payments instead of sandbox.

### C.1 Submit to Campay

1. Log into Campay dashboard.
2. Switch from sandbox to **production** mode (their docs: https://docs.campay.net/docs/go-live).
3. Submit the Go-Live form with:
   - **Business name:** ChopNow (Tchop Now Cameroun SARL or whatever the legal entity is)
   - **Business document:** RCCM / NIU (Cameroon registration certificate)
   - **MoMo settlement account:** MTN + Orange Money payout numbers (where Campay sends our money)
   - **Webhook URL:** `https://api.tchopnow.app/api/payments/campay/webhook`
   - **IP allowlist** (if Campay asks): the Hetzner CAX11 outbound IP
4. Expected review time: **3-5 business days** per Campay's published SLA. Start this **today** because it's the longest pole.

### C.2 Once approved

Update `chopnow-api` production env vars:

| Variable                | Replace with                                       |
| ----------------------- | -------------------------------------------------- |
| `CAMPAY_API_URL`        | `https://campay.net/api` _(not `demo.campay.net`)_ |
| `CAMPAY_USERNAME`       | (production username from Campay)                  |
| `CAMPAY_PASSWORD`       | (production password from Campay)                  |
| `CAMPAY_WEBHOOK_SECRET` | (production webhook secret)                        |

### C.3 Verification (one-time live transaction)

- [ ] Place a real 1500 FCFA test order from a phone you own, pay via MTN MoMo.
- [ ] Confirm Campay dashboard shows the transaction.
- [ ] Confirm `paymentStatus` flips to `PAID` in our DB (webhook arrived).
- [ ] Confirm dispatch fires.

> 💡 Cancel the rider claim and refund yourself via Campay admin to avoid leaking 1500 FCFA on every iteration.

---

## Track D — Twilio Production (in parallel)

**Goal:** OTP + voice proxy work in production with a verified Meta WhatsApp number.

### D.1 WhatsApp templates (Meta-approved)

Twilio's `whatsapp:+14155238886` sandbox works for OTP today but needs a custom approved sender for prod:

1. Twilio Console → Messaging → Senders → WhatsApp Senders → Create new.
2. Submit `+237XXXXXXXXX` (your ChopNow Cameroon number) for Meta approval.
3. Submit the 4 templates we use:
   - `chopnow_otp_v1` — "Votre code ChopNow : {{1}}. Expire dans 5 min."
   - `chopnow_vendor_pending_v1` — "✅ Demande reçue ! Validation sous 24h."
   - `chopnow_rider_pending_v1` — "✅ Dossier reçu. Validation sous 4h."
   - `chopnow_order_accepted_v1` — "Ta commande {{1}} a été acceptée. Code de livraison : {{2}}"
4. Meta approval: **2-5 days**. Start now.

### D.2 Voice geo-permission for Cameroon

Twilio Console → Voice → Settings → Geographic Permissions → enable **Cameroon (Country code 237)**. Saves immediately; no review needed.

### D.3 Production env vars (chopnow-api)

| Variable                     | Replace with                                                               |
| ---------------------------- | -------------------------------------------------------------------------- |
| `TWILIO_WHATSAPP_FROM`       | `whatsapp:+237XXXXXXXXX` (the approved sender)                             |
| `TWILIO_SMS_FROM`            | (your approved SMS sender — same number works)                             |
| `TWILIO_STATUS_CALLBACK_URL` | `https://api.tchopnow.app/api/twilio/status`                               |
| `OTP_DEV_BYPASS`             | **leave unset** in prod (would log OTPs to stdout — never do that in prod) |

---

## Track E — Hetzner CAX11 (backend prod)

**Goal:** `api.tchopnow.app` serves the chopnow-api on a Hetzner ARM box.

This one is the most hands-on. CLAUDE.md says target is end-of-June. The provisioning playbook:

1. **Order CAX11** (~€4/mo) — Falkenstein or Helsinki datacenter, Ubuntu 22.04 LTS.
2. **Initial server hardening:**
   - SSH key auth only, disable password.
   - UFW firewall: 22 (SSH), 80 (HTTP), 443 (HTTPS).
   - fail2ban for SSH.
   - Unattended-upgrades for security patches.
3. **Install:**
   - Docker + Docker Compose.
   - Caddy (auto-cert via Let's Encrypt — simpler than nginx for `.app` HTTPS).
4. **Bring up:**
   - Clone `chopnow-api` to `/opt/chopnow-api`.
   - Bring up Postgres (PostGIS) + Redis via the existing `docker-compose.yml` (only those services; the app runs natively for hot rebuild).
   - `npx prisma migrate deploy`.
   - `npx ts-node prisma/seed-admin.ts` with real SUPER_ADMIN creds.
   - `pm2 start dist/src/main.js --name chopnow-api`.
5. **Caddy** in front, forwarding `api.tchopnow.app` → `localhost:3001`. Caddy auto-issues the cert.
6. **DigitalOcean staging** stays as-is for PR-preview backend testing.

### Backups

- Postgres: `pg_dump` daily → upload to Cloudflare R2 via cron. Restore tested before launch.

---

## Suggested order (mid-May → mid-July)

| Week       | Track A (Vercel)          | Track B (Domain)          | Track C (Campay)                                      | Track D (Twilio)                   | Track E (Hetzner)                   |
| ---------- | ------------------------- | ------------------------- | ----------------------------------------------------- | ---------------------------------- | ----------------------------------- |
| **Now**    | Deploy staging            | Register `tchopnow.app`   | **Submit Go-Live**                                    | **Submit Meta templates**          | —                                   |
| **+1w**    | First prod preview        | DNS to Cloudflare         | (waiting)                                             | (waiting)                          | Order CAX11                         |
| **+2w**    | Production live on Vercel | api/api-staging A-records | Approved + creds in env                               | Approved + sender in env           | Server hardened, Postgres up        |
| **+3w**    | Smoke test on real domain | —                         | First real MoMo transaction                           | First real OTP via approved sender | Deploy chopnow-api, run migrations  |
| **+4w**    | —                         | —                         | —                                                     | —                                  | Caddy + cert, api.tchopnow.app live |
| **Launch** | —                         | —                         | All four tracks green; first 10 real Douala customers |                                    |                                     |

---

## Final go/no-go checklist

Before flipping the public switch:

- [ ] `https://tchopnow.app/login` works on a Tecno/Itel mid-range over real Douala 3G.
- [ ] `https://api.tchopnow.app/health` returns `{"status":"ok"}`.
- [ ] Real MoMo transaction (1500 FCFA test) succeeds end-to-end: payment → vendor accept → dispatch → rider claim → delivered → rating.
- [ ] At least 3 real vendors are seeded (manually approved by admin).
- [ ] At least 5 real riders are seeded (KYC validated).
- [ ] Postgres backup ran in the last 24h.
- [ ] Twilio voice proxy works for masked livreur ↔ client calls.
- [ ] On-call rotation defined (you + one trusted operator) with phone numbers.
- [ ] Incident response runbook in `_bmad-output/runbooks/incident.md` (next task — TBD).
