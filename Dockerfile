# ==============================================================================
# Assingly — Production Multi-Stage Dockerfile
# Optimized for Node.js + native better-sqlite3 + persistent data volume
# ==============================================================================

FROM node:20-bookworm-slim AS base
WORKDIR /app

# Install build essentials required for native better-sqlite3 compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for building client)
RUN npm ci

# Copy application source code
COPY tsconfig.json vite.config.ts index.html ./
COPY server ./server
COPY src ./src

# Build production client bundle into ./dist and run typecheck
RUN npm run build

# Prune dev dependencies for production runtime
RUN npm prune --production

# ==============================================================================
# Production Runner Image
# ==============================================================================
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/app/data/assingly.db
ENV UPLOAD_DIR=/app/data/private-uploads

# Create non-root directory for persistent database and private uploads
RUN mkdir -p /app/data/private-uploads && chown -R node:node /app

# Copy production node_modules and code
COPY --from=base --chown=node:node /app/node_modules ./node_modules
COPY --from=base --chown=node:node /app/package.json ./package.json
COPY --from=base --chown=node:node /app/dist ./dist
COPY --from=base --chown=node:node /app/server ./server

# Switch to non-root user for security
USER node

# Expose web service port
EXPOSE 3001

# Declare persistent storage volume mount
VOLUME ["/app/data"]

# Healthcheck against API health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3001) + '/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the unified web application (serves both React SPA and Express API)
CMD ["npx", "tsx", "server/index.ts"]
