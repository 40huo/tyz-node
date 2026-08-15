# Build context: repository root (monorepo with bun workspaces)
#
# Multi-stage: the builder installs deps and compiles the agent into a single
# self-contained executable (bun runtime embedded); the runtime image carries
# no node_modules at all (~100MB total instead of ~500MB with every workspace's
# production dependencies).

FROM oven/bun:1-alpine AS build

WORKDIR /app

# Copy ALL workspace manifests: bun resolves the `apps/*`/`packages/*` globs at
# install time, so a missing package.json makes the frozen lockfile mismatch.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN bun install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/agent apps/agent

RUN cd apps/agent && bun build --compile --bytecode --minify --sourcemap src/index.ts --outfile=dist/server

FROM alpine:3.22

# musl-linked binary built on the alpine builder above; no other runtime needed.
RUN adduser -D -u 10001 agent
WORKDIR /app
COPY --from=build --chown=agent:agent /app/apps/agent/dist/server ./server

USER agent
EXPOSE 18090

# Exec form so SIGTERM reaches the agent directly
CMD ["./server"]
