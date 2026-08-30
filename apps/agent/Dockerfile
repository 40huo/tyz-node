# Build context: repository root
#
# Multi-stage cross-compile: the builder runs natively on the build host
# (BUILDPLATFORM); zig provides the musl sysroot for both targets, so the
# agent is a STATIC binary and the runtime stage can be Alpine (~10MB total
# instead of ~80MB for a glibc/debian-slim layout). The toolchain is pinned
# by apps/agent/rust-toolchain.toml (nightly); rustup auto-installs it on the
# first cargo call made inside apps/agent.

FROM --platform=$BUILDPLATFORM ghcr.io/rust-cross/cargo-zigbuild:0.17 AS build

WORKDIR /src
ARG TARGETARCH
# Agent version stamped into the binary (TYZ_VERSION, see src/lib.rs); CI
# passes the release tag or "nightly" (master pushes), local builds keep the
# "dev" default.
ARG TYZ_VERSION=dev

# Target layer: re-run only when the toolchain pin changes. The rustup call
# runs INSIDE apps/agent so the pinned toolchain from rust-toolchain.toml is
# the one that receives the target.
COPY apps/agent/rust-toolchain.toml ./apps/agent/rust-toolchain.toml
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        echo 'export TARGET=aarch64-unknown-linux-musl' > /env.sh; \
    else \
        echo 'export TARGET=x86_64-unknown-linux-musl' > /env.sh; \
    fi && \
    cd apps/agent && rustup target add "$(. /env.sh; echo "$TARGET")"

# Dependency layer: re-built only when the manifests change (realm_lb's git
# rev included — Cargo.lock pins it). The placeholder lib keeps the crate
# itself from compiling; a failure here is non-fatal (the cache just misses).
COPY apps/agent/Cargo.toml apps/agent/Cargo.lock ./apps/agent/
RUN . /env.sh && mkdir -p apps/agent/src && \
    echo "// dependency warm-up placeholder" > apps/agent/src/lib.rs && \
    cd apps/agent && cargo zigbuild --release --locked --lib --target "$TARGET" || true

COPY apps/agent ./apps/agent
# Docker COPY keeps the context's (old) source mtimes — OLDER than the
# warm-up layer's build time. Cargo fingerprints are mtime-based, so without
# this bump it considers the placeholder lib fresh and the bin links against
# an empty `tyz_agent` (E0433/E0425 on agentcfg/VERSION/run).
RUN . /env.sh && find apps/agent/src -type f -exec touch {} + && \
    cd apps/agent && \
    cargo zigbuild --release --locked --target "$TARGET" && \
    cp "target/$TARGET/release/tyz-agent" /out-tyz-agent

FROM alpine:3.22
# CA bundle for in-container debugging tools; the agent itself uses
# compile-time webpki roots. No tzdata: nothing in the agent formats local
# time (tracing logs RFC3339 UTC).
RUN apk add --no-cache ca-certificates

# /var/lib/tyz holds .env, certs/ (platform link-TLS PEMs) and the
# last-config.json offline bootstrap cache — mount a directory or volume on
# it to keep tunnels alive across restarts. Runs as root: the agent needs
# host networking anyway, and operator-created bind mounts (the documented
# ./data layout) are root-owned, which would block a non-root container from
# writing its state.
RUN mkdir -p /var/lib/tyz
WORKDIR /var/lib/tyz
ENV HOME=/var/lib/tyz

COPY --from=build /out-tyz-agent /usr/local/bin/tyz-agent

# Exec form so SIGTERM reaches the agent directly (final stats flush)
ENTRYPOINT ["tyz-agent"]
