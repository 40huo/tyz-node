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

# Same image as the builder: the compiled executable inherits the linkage of
# the bun that built it (musl here), so the runtime matches it exactly. A bare
# alpine would also work in theory, but emulation-built (QEMU/arm64) musl
# binaries have had quirks — see oven-sh/bun#19536 — so keep build == runtime.
FROM oven/bun:1-alpine

WORKDIR /app
COPY --from=build --chown=bun:bun /app/apps/agent/dist/server ./server

USER bun
EXPOSE 18090

# Exec form so SIGTERM reaches the agent directly
CMD ["./server"]
