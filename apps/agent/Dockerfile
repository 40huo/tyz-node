# Build context: repository root
#
# Multi-stage cross-compile: the builder runs natively on the build host
# (BUILDPLATFORM) and emits a static binary for TARGETARCH; the runtime is
# plain alpine with CA certs. The agent embeds the GOST runtime in-process,
# so a single binary replaces the previous agent + gogost/gost pair.

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build

WORKDIR /src
ARG TARGETARCH

# Module cache layer: re-built only when go.mod/go.sum change.
COPY apps/agent/go.mod apps/agent/go.sum ./apps/agent/
RUN cd apps/agent && go mod download

COPY apps/agent ./apps/agent
RUN mkdir -p /out && \
    CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH \
    go build -C apps/agent -trimpath -ldflags "-s -w" -o /out/tyz-agent .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata

# Non-root user; /var/lib/tyz holds .env and the persisted auto-generated
# default certificate ($HOME/.gost) for stable certs across restarts.
RUN addgroup -S tyz && adduser -S tyz -G tyz \
    && mkdir -p /var/lib/tyz && chown tyz:tyz /var/lib/tyz
WORKDIR /var/lib/tyz
ENV HOME=/var/lib/tyz

COPY --from=build /out/tyz-agent /usr/local/bin/tyz-agent

USER tyz
EXPOSE 18090

# Exec form so SIGTERM reaches the agent directly
ENTRYPOINT ["tyz-agent"]
