# Bun runs TypeScript directly, no build stage needed
FROM oven/bun:1-alpine

WORKDIR /app

ENV NODE_ENV=production

# Copy dependency files first for layer caching
COPY package.json bun.lock ./

# Install production dependencies only (skips typescript/biome/supabase CLI)
RUN bun install --frozen-lockfile --production

# Copy application source
COPY src ./src

# Run as the non-root user provided by the base image
USER bun

EXPOSE 18090

# Exec form so SIGTERM reaches bun directly
CMD ["bun", "run", "src/index.ts"]
