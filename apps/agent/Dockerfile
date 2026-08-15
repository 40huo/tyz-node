# Build context: repository root (monorepo with bun workspaces)
FROM oven/bun:1-alpine

WORKDIR /app

ENV NODE_ENV=production

# Copy workspace manifests first for layer caching
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/

# Install production dependencies only (skips typescript/biome dev tooling)
RUN bun install --frozen-lockfile --production

# Copy application source
COPY packages/shared packages/shared
COPY apps/agent/src apps/agent/src

# Run as the non-root user provided by the base image
USER bun

EXPOSE 18090

# Exec form so SIGTERM reaches bun directly
CMD ["bun", "run", "apps/agent/src/index.ts"]
