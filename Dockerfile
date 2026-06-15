# ================================================================
# DCF CF Chat Server — Dockerfile
# Multi-stage build for minimal production image
# ================================================================

# ── Stage 1: Dependencies ──────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production deps only
RUN npm ci --omit=dev && npm cache clean --force


# ── Stage 2: Production Image ──────────────────────────────────
FROM node:20-alpine AS runner

# Security: non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S dcfchat -u 1001

WORKDIR /app

# Copy deps from stage 1
COPY --from=deps --chown=dcfchat:nodejs /app/node_modules ./node_modules

# Copy source
COPY --chown=dcfchat:nodejs server.js ./
COPY --chown=dcfchat:nodejs .env.example ./.env.example

# Set non-root user
USER dcfchat

# Port (Railway/Render inject PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

# Start
ENV NODE_ENV=production
CMD ["node", "server.js"]
