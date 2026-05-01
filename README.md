# chopnow-api

ChopNow backend — NestJS + Prisma + PostgreSQL/PostGIS + Redis.

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

## Repo layout (planned)

```
chopnow-api/
├── src/
│   ├── auth/         # OTP, JWT, sessions
│   ├── catalogue/    # vendors, items, availability
│   ├── orders/       # cart, payment, lifecycle
│   ├── dispatch/     # livreur assignment, GPS
│   ├── finance/      # escrow, cashout, KYC
│   └── admin/        # ops, KYC review, dashboards
├── prisma/
│   └── schema.prisma
└── test/
```

## Development

```bash
npm install
docker compose up -d   # postgres + redis
npx prisma migrate dev
npm run start:dev
```

## Epics

E1 Auth · E2 Catalogue · E3 Commande · E4 Livraison · E5 WhatsApp · E6 Admin · E7 Finance

## License

Proprietary — All Rights Reserved. See `LICENSE`.
