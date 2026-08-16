# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

TYZ is a GOST (GO Simple Tunnel) tunnel management platform in a Bun-workspaces monorepo:

- **Control plane** (`apps/server`): Cloudflare Worker (Hono) + D1 (SQLite). Serves the admin panel (assets + CRUD API) and the agent API (versioned config polling, batched stats upload).
- **Node agent** (`apps/agent`): a single Go binary with the GOST runtime embedded in-process (`go-gost/core v0.6.0` + `go-gost/x v0.15.2`, the gost master/nightly-20260802 pins). Polls config (WS push first, HTTP fallback), renders GOST objects from domain data, applies them directly through the GOST registries, and reports observer stats. Deployed as one container per relay machine (Docker, host network).
- **Admin web** (`apps/web`): React 18 + Vite + shadcn/ui + TanStack Query. Built output is served by the Worker via the `ASSETS` binding with SPA fallback implemented in `app.notFound`.
- **Shared** (`packages/shared`): entity types, zod schemas, API DTOs used by server and web.

**Stack**: Bun (workspaces) · Hono (server) · Cloudflare Workers + D1 + Drizzle ORM · Go (agent: embedded GOST via go-gost/x) · React + shadcn/ui · Biome

## Common Commands

```bash
bun install                     # install all workspaces
bun run lint                    # biome check (root)
bun run type-check              # tsc --noEmit in every workspace
bun run build:web               # build apps/web -> apps/web/dist

bun run dev:server              # wrangler dev (8787) — run inside apps/server after migrations
bun run dev:web                 # vite dev (5173, proxies /api to 8787)
bun run dev:agent               # go run the agent (18090); needs CONTROL_PLANE_URL + NODE_TOKEN
bun run test:agent              # go test ./... in apps/agent (golden builder, WS state machine, apply)

# Server (inside apps/server)
bunx wrangler d1 migrations apply DB --local      # apply migrations to local D1
bunx wrangler d1 execute DB --local --file scripts/seed-local.sql   # local seed data
bun run scripts/hash-password.ts <TOKEN_SALT> <password>           # generate ADMIN_PASSWORD_SHA256
bun run scripts/test-ws-push.ts [baseUrl]        # e2e push test vs wrangler dev (dev-token-1, admin/admin123)

# Agent (inside apps/agent)
go vet ./... && go test ./...
```

## Architecture / Data Flow

```
admin web ──► /admin CRUD ──► D1 (relay_nodes/tunnels/chains/relay_rules)
                                   │ on every write: recompute affected nodes' config
                                   ▼
                            node_configs (node_id, version, config_json)
                                   │ + notifyConfigChanged() → per-node NodePushDO broadcasts
                                   ▼
agent keeps WS GET /api/agent/ws (Bearer NODE_TOKEN) ── {"type":"config_changed"} push
  └─► immediate GET /api/agent/config?version=N  (config content still travels over HTTP)
        ├─ 304 when version unchanged
        └─ 200 { version, config: NodeConfigData }
              └─► builder.Build (in-process) ──► gostapply.Apply (registry diff, in-process)

WS channel policy (apps/agent/internal/cp/ws.go):
  - healthy WS: HTTP poll is a 5-min safety net only
  - ≥3 WS failures within 60s → fallback to HTTP polling (POLL_INTERVAL_MS + backoff)
  - while fallen back: WS reconnect probe every WS_PROBE_INTERVAL_MS; success returns to ws mode
  - keepalive: agent pings every WS_PING_INTERVAL_MS (default 60s, clamped < 90s —
    the edge closes WebSockets idle > 100s); the DO auto-responds via
    setWebSocketAutoResponse without waking, so heartbeats cost no duration and
    outbound pongs are not billed (inbound messages bill at 20:1)

embedded GOST observer (statsobs) ──► stats buffer ──► POST /api/agent/stats (batched) ──► D1 gost_stats
```

### Key server modules (`apps/server/src`)

- `index.ts` — Hono app, mounts `/agent` and `/admin`, SPA fallback via `env.ASSETS`, daily cron pruning `gost_stats` (>30 days). Exports `AppType` and the `NodePushDO` class.
- `routes/agent.ts` — node-facing endpoints; auth via `middleware/nodeAuth.ts` (Bearer token → sha256(TOKEN_SALT + ":node:" + token) lookup in D1, 60s in-isolate cache). `GET /ws` forwards the authenticated upgrade request to the node's `NodePushDO`.
- `do/nodePush.ts` — `NodePushDO` (one Durable Object instance per node, `idFromName(String(nodeId))`): accepts WebSockets via the hibernation API, auto-responds to `ping`→`pong` at the edge (`setWebSocketAutoResponse`, object stays hibernated), and on `POST /notify` broadcasts `{"type":"config_changed"}` to all live sockets of that node. Bound as `CONFIG_PUSH` in wrangler.jsonc (SQLite class migration `v2_node_push_do`).
- `services/notify.ts` — `notifyConfigChanged(env, nodeIds)`: fire-and-forget fan-out to the DOs; never fails the admin write.
- `routes/admin.ts` — login (HMAC-signed HttpOnly session cookie, `middleware/adminAuth.ts`), full CRUD for nodes/tunnels/chains/rules, token rotate (shown once), stats query, recompute. Every write path recomputes `node_configs` for affected nodes via `recomputeAndNotify` / `recomputeTunnelNodes` (recompute + WS push).
- `db/schema.ts` — Drizzle schema mirroring `migrations/0001_init.sql`; property names keep snake_case to match the shared entity types, `chains.idx` aliases to entity `index`, boolean/json column modes replace the old hand-written row mappers. **`nodeEntityColumns` is the allowlist for node fields in API responses — never select `token_hash`/`tls_config` into responses.** Schema changes: edit `schema.ts` → `bunx drizzle-kit generate` (see `drizzle.config.ts`) → copy SQL into `migrations/` → apply with wrangler.
- `db/repo.ts` — Drizzle data access: config aggregation, snapshot upsert (version bump upsert kept as raw SQL), thin `to*` helpers that fold nullable columns to the entity `field?: T` shape.
- `services/aggregate` lives in `db/repo.ts`: node → chains touching the node → tunnels → rules attached to those tunnels + ALL chains of those tunnels (full relay path). A rule without a tunnel is never part of any node's config.

### Agent (`apps/agent`, Go)

- `main.go` — wiring: env config, slog (+ GOST logger routed to stdout), global default certificate, control loop, optional GOST debug API (`GOST_API_ADDR`), health server, signal handling (SIGTERM → final stats flush + close services).
- `internal/agentcfg` — env/dotenv loading; variables mirror the previous agent.
- `internal/model` — Go structs mirroring `@tyz/shared` payloads (only consumed fields).
- `internal/builder` — `Build(NodeConfigData) *config.Config`: port of the TS builder (golden-tested against its output); `DefaultTLS` feeds the control-plane TLS hints into the global default certificate.
- `internal/gostapply` — `Apply(*config.Config)`: registry diff-apply (see below).
- `internal/statsobs` — in-process `observer.Observer` (registered as `stats-observer`); forwards `StatsEvent`s to the stats buffer.
- `internal/cp` — control-plane HTTP client (config fetch w/ 304, stats upload) and `WsChannel` (ping/pong keepalive, reconnect backoff 1s→60s, 3-in-60s failure demotion to poll mode, periodic probes promoting back to ws mode; `WS_ENABLED=false` forces pure HTTP polling).
- `internal/loop` — poll loop with exponential backoff + jitter (max 5 min) and interruptible sleep (`Wake()`) so WS pushes trigger an immediate fetch; poll cadence adapts to channel health (5-min safety net while WS is up, `POLL_INTERVAL_MS` otherwise); stats buffer (max 1000) flushed on an interval and at graceful shutdown. The applied version is only adopted on success so failed applies retry on the next poll. **Offline bootstrap**: the last applied config is persisted to `last-config.json` in the working directory (atomic write, `AgentConfigResponse` shape) and re-applied at startup; its version becomes the polling baseline, so an unchanged config after an outage costs one 304. Unreadable/stale caches are skipped with a warning — the loop then starts from scratch.
- `internal/drivers` — GOST driver registration, verbatim from gost's `cmd/gost/register.go`. The **full** set is required: GOST parsers default to connector types (e.g. `http` for forwarder nodes) and the `auto` handler probes http/socks handlers — a curated subset breaks on those implicit defaults.

## Critical Implementation Details

### Embedded GOST apply semantics (go-gost/x v0.15.2, source-verified)

- Dynamic config is done **in-process** via the same primitives the GOST Web API uses: `parser.ParseService/ParseChain/ParseTrafficLimiter/ParseRateLimiter/ParseConnLimiter` + `x/registry` singletons. `gostapply.Apply` diffs desired vs the last applied desired config (deep equality on config structs — no API echo to normalize): deletes top-down (services → chains → climiters → rlimiters → limiters), creates bottom-up; chains/limiters hot-swap via `Unregister+Register` (registry wrappers re-resolve on every use), **services must be closed and re-served** on change.
- **Observers**: the in-process observer implements `core/observer.Observer` (`Observe(ctx, events []Event)`) and is registered under `stats-observer` **before** the first apply (services resolve the observer by name at parse time).
- **Stats are only reported when a service references the observer AND sets `metadata: { enableStats: "true" }`** (metadata, string — a top-level boolean does NOT work). Builder sets both on every service. Stats are periodic (~5s, `observer.period`) and stop when nothing changed.
- **Schema pitfalls**: `ChainConfig` has only `name/hops/metadata` — there is NO chain-level `selector`; per-hop selectors are valid (`HopConfig.selector`). `NodeConfig.tls` is `TLSNodeConfig` (`serverName`/`secure`/`options` only — the old TS agent's `nodes[].tls{validity,commonName,organization}` was always silently dropped by GOST). Auto-generated certificate parameters now go to the **global default certificate** via `builder.DefaultTLS` + `parsing.BuildDefaultTLSConfig` (generated once, persisted under `$HOME/.gost`, reused across restarts; first generation wins even if the control-plane hints change later).
- Version note: `core v0.6.0 / x v0.15.2` correspond to gost master/nightly 20260802 — the stable tag v3.2.6 pins older modules (`core v0.3.3/x v0.8.1`). Keep the pins exact; when bumping, re-verify the config structs and the builder golden test.

### Config versioning

`node_configs.version` is epoch-seconds-based and bumped monotonically on every recompute (`max(existing, epoch)` + 1 on conflict), so agents can never get stuck on a stale 304 after a snapshot row is recreated. Agents track their version in memory and reset to 0 on restart (full refresh).

### Service generation logic (builder)

Handler/listener types depend on node position (IN/CHAIN/OUT from `chain_type`) and hop count:

- **Entry nodes** (chain_type='in'): one service per rule listening on the rule's `listen_port`; 1 hop → simple forwarding (`handler: tcp` + forwarder); 2 hops → `handler: tcp` + chain; 3+ hops → `handler: auto` + chain. All rules of a tunnel reference the same chain.
- **Exit/relay nodes**: exactly **one** `handler: relay` service per tunnel (`service-t{tunnelId}`), regardless of rule count — the relay protocol carries each connection's destination in-band, so N entry rules funnel through one exit port (which may even numerically equal an entry listen port; they live on different machines). Port = the chain row's `port` (0 = auto-allocate `start + (chain_id + node_id) % port_range` from `relay_nodes.ports`). Rule limiters apply at the entry services only.

Chains are only generated at entry nodes. **Hop dial addresses resolve per chain row from that row's own node record**: the aggregation delivers `NodeConfigData.nodes` (records for every node the chains reference, incl. the recipient); `chainAddr` = `nodes[chain.node_id].address` + `chain.port` (0 = auto-allocate from **that node's** port range with the same deterministic formula the node itself uses, so both sides agree without coordination). Payloads without `nodes` (legacy snapshots) fall back to the recipient node. **`tunnels.ingress_display_address` is a client-facing display field (admin panel) and never takes part in config generation.** Two-hop chains have a single hop = the exit's chain row (`connector: relay`, dialer from the exit row's transport). Multi-hop chains sort by `index` and may carry a per-hop `selector.strategy`; note that multi-hop (3+) shapes are golden-locked but have **not** been validated against a real 3-node deployment — hop composition (every chain row, including the IN row, becomes a hop) follows the original implementation.

Transport mapping (`internal/builder/mapper.go`): `raw→tcp, tls→tls, wss→ws, mwss→mws`, etc. Limiters (`internal/builder/limiter.go`): `limiters` (traffic), `rlimiters` (request rate), `climiters` (connections) from the rule's `limit` JSON; supports service-level and per-IP limits.

### Naming conventions

All GOST objects are named deterministically (`service-{ruleId}` at entries, `service-t{tunnelId}` at exits, `chain-{tunnelId}`, `node-{nodeId}-t{tunnelId}`, `hop-{tunnelId}-{index}`) — required for the registry diff-apply to recognize stale objects across config versions.

### Database schema quirks

- SQLite (D1): enums are TEXT + CHECK constraints; `limit`/`custom_cfg`/`tls_config`/`stats` stored as JSON TEXT.
- Field spellings are now **corrected**: `display_address`, `ingress_display_address` (the old Supabase `disaply_*` typo is intentionally not carried over).
- Node tokens are stored as salted SHA-256 hashes only; the raw token is displayed exactly once (create/rotate).
- `relay_rules.tunnel_id` NULL means "not deployed anywhere" (not part of any node's config).

## Auth

- **Agent**: `Authorization: Bearer <NODE_TOKEN>`; token created/rotated in the admin panel.
- **Admin**: single account from Worker secrets (`ADMIN_USERNAME` / `ADMIN_PASSWORD_SHA256` = sha256 of `${TOKEN_SALT}:admin:${password}`); session = HttpOnly cookie `tyz_admin` = `expiry.hmac(SESSION_SECRET, expiry)`, 7 days.

## Environment Variables

Agent (`apps/agent/.env.example`, loaded from the working directory; real env vars take precedence): `CONTROL_PLANE_URL`, `NODE_TOKEN` (required); `PORT` (18090), `HOST` (127.0.0.1), `POLL_INTERVAL_MS` (10000), `STATS_FLUSH_INTERVAL_MS` (60000), `WS_ENABLED` (true; false = pure HTTP polling), `WS_PROBE_INTERVAL_MS` (60000; WS reconnect probe interval while in poll fallback), `WS_PING_INTERVAL_MS` (60000; heartbeat, clamped < 90s), `GOST_API_ADDR` (empty; set e.g. `127.0.0.1:18080` to expose the embedded GOST Web API for debugging), `DEBUG`.

Server (`apps/server/.dev.vars.example` for local; `wrangler secret put` for production): `ADMIN_USERNAME`, `ADMIN_PASSWORD_SHA256`, `SESSION_SECRET`, `TOKEN_SALT` (**changes token hashes — never rotate after nodes exist**).

## HTTP Endpoints

Server: `GET /api/healthz`; agent-facing `GET /api/agent/config?version=N` (304/200), `GET /api/agent/ws` (WebSocket upgrade; pushes `{"type":"config_changed"}`, answers `ping`→`pong`), `POST /api/agent/stats`; admin `POST /api/admin/login|logout`, `GET /api/admin/me`, CRUD `/api/admin/nodes|tunnels|chains|rules` (+`/api/admin/nodes/:id/{recompute,rotate-token,stats}`).

Agent: `GET /healthz` (that is its entire HTTP surface; config apply and observer stats are in-process function calls).

## Code Style

Biome (root `biome.json`) covers the TS workspaces: double quotes, 120 cols, organize imports; `noExplicitAny`/`noNonNullAssertion`/a11y anchor rules are downgraded to warnings. Go code (`apps/agent`): standard `gofmt` formatting, `log/slog` structured logging, no config frameworks. Run `bun run lint`, `bun run type-check`, and `go vet ./...` + `go test ./...` (apps/agent) before committing.

## Testing

`bun run test:agent` (i.e. `go test ./...` in apps/agent):
- builder golden tests: builds `examples/real-database-example.json` → `aggregated_data` and compares against `internal/builder/testdata/golden-gost-config.json` (the TS builder's output, kept as the baseline; two documented deltas are normalized — the inert `nodes[].tls` auto-cert fields and `selector.failTimeout` seconds-vs-nanoseconds); the two-node relay scenario (`testdata/two-node-example.json`, entry + exit perspectives) pins the shared-exit-port shape. Regenerate with `go test ./internal/builder -update` after intentional changes.
- WsChannel state machine: 3 failures → poll fallback → probe reconnect → recovery → `config_changed` delivery (own local WS server, no control plane needed).
- apply tests: registry lifecycle (create / idempotent re-apply / update / delete / limiter hot-swap / two-node entry+exit swap).

Live two-agent e2e (needs `wrangler dev` + seed): `apps/agent/scripts/e2e-local.sh` — re-applies the seed (single-hop tunnel-1 + two-node relay tunnel-2 with two rules sharing the exit's :16900), builds the agent, starts two local HTTP targets and two agent processes, and asserts distinguishable responses through both entry ports.

Server-side e2e (needs `wrangler dev` running): `bun run scripts/test-ws-push.ts` (inside apps/server) — bad token rejected, hello, ping/pong, admin write broadcasts `config_changed`. Uses seed token `dev-token-1` and admin/admin123.

For a full local stack run `wrangler dev` + seed + the Go agent (`bun run dev:agent`); send traffic through a rule's listen port and watch `gost_stats` rows appear.
