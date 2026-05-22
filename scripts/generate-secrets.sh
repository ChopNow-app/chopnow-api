#!/usr/bin/env bash
# Generate a local .env with cryptographically random JWT secrets.
# Run on first clone — never commits the resulting .env (gitignored).

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  echo ".env already exists — skipping. Delete it first if you want to regenerate."
  exit 0
fi

if [[ ! -f .env.example ]]; then
  echo ".env.example not found at $(pwd)/.env.example" >&2
  exit 1
fi

ACCESS_SECRET=$(openssl rand -base64 64 | tr -d '\n')
REFRESH_SECRET=$(openssl rand -base64 64 | tr -d '\n')
WEBHOOK_SECRET=$(openssl rand -base64 32 | tr -d '\n')
ENVELOPE_KEY=$(openssl rand -hex 32 | tr -d '\n')

# macOS sed and GNU sed differ — use a tmp file approach for portability.
sed \
  -e "s|JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=${ACCESS_SECRET}|" \
  -e "s|JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=${REFRESH_SECRET}|" \
  -e "s|CAMPAY_WEBHOOK_SECRET=.*|CAMPAY_WEBHOOK_SECRET=${WEBHOOK_SECRET}|" \
  -e "s|APP_SECRET_ENVELOPE_KEY=.*|APP_SECRET_ENVELOPE_KEY=${ENVELOPE_KEY}|" \
  .env.example > .env

echo "✅ .env created with random JWT_*_SECRET, CAMPAY_WEBHOOK_SECRET, APP_SECRET_ENVELOPE_KEY."
echo "   Fill in TWILIO_*, CAMPAY_USERNAME/PASSWORD, VAPID_*, R2_* manually before running affected stories."
