# --- Build stage ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# --- Runtime stage ---
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Run as non-root user
RUN addgroup -S nodejs && adduser -S nestjs -G nodejs

COPY --chown=nestjs:nodejs package*.json ./
# --ignore-scripts skips the `prepare` hook (which would try to run husky —
# a devDependency we don't ship). Cleaner than HUSKY=0 because it also cuts
# any other transitive postinstall noise from the production layer.
#
# After install, strip the bundled npm CLI: at runtime we only run
# `node dist/main.js`, so the npm package (~50 MB + its own picomatch/etc.
# transitives that show up in Trivy scans) is dead weight + extra attack
# surface. Production images are intentionally non-self-modifying.
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=nestjs:nodejs --from=builder /app/dist ./dist
COPY --chown=nestjs:nodejs --from=builder /app/prisma ./prisma
COPY --chown=nestjs:nodejs --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Prisma CLI — needed to run `prisma migrate deploy` at deploy time. It's a
# devDependency (kept out of runtime install via --omit=dev) but the CLI
# binary + its engine helpers live entirely under node_modules/prisma, so
# we can bolt it on without dragging the full dev tree. ~15 MB.
COPY --chown=nestjs:nodejs --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --chown=nestjs:nodejs --from=builder /app/node_modules/@prisma ./node_modules/@prisma

USER nestjs
EXPOSE 3001

# The Nest SWC builder, with `sourceRoot: "src"` in nest-cli.json, mirrors the
# source layout under dist. So src/main.ts → dist/src/main.js (not dist/main.js).
# The first staging deploy hit this because nobody had ever run `start:prod` —
# `start:dev` uses the in-memory SWC pipeline and doesn't touch dist/.
CMD ["node", "dist/src/main.js"]
