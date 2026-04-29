# ── Stage 1: Builder ─────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (layer cache)
COPY package*.json tsconfig.json ./

RUN npm ci --ignore-scripts

# Copy source and compile
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ── Stage 2: Production image ────────────────────────────────
FROM node:20-alpine AS production

# Security: non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser  -u 1001 -S appuser -G appgroup

WORKDIR /app

# Copy only what's needed
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist         ./dist
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# Create logs dir with correct ownership
RUN mkdir -p logs && chown appuser:appgroup logs

USER appuser

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8000/api/health || exit 1

CMD ["node", "dist/server.js"]
