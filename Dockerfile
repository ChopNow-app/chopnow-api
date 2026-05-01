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
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=nestjs:nodejs --from=builder /app/dist ./dist
COPY --chown=nestjs:nodejs --from=builder /app/prisma ./prisma
COPY --chown=nestjs:nodejs --from=builder /app/node_modules/.prisma ./node_modules/.prisma

USER nestjs
EXPOSE 3001

CMD ["node", "dist/main.js"]
