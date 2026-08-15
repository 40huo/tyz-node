# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

TYZ is a GOST (GO Simple Tunnel) tunnel management platform in a Bun-workspaces monorepo:

- **Control plane** (`apps/server`): Cloudflare Worker (Hono) + D1 (SQLite). Serves the admin panel (assets + CRUD API) and the agent API (versioned config polling, batched stats upload).
- **Node agent** (`apps/agent`): Bun + Hono, deployed on relay machines next to GOST (Docker, host network). Polls config, generates GOST config, applies it via GOST's Web API, and reports observer stats.
- **Admin web** (`apps/web`): React 18 + Vite + antd + TanStack Query. Built output is served by the Worker via the `ASSETS` binding with SPA fallback implemented in `app.notFound`.
- **Shared** (`packages/shared`): entity types, zod schemas, API DTOs used by all three apps.

**Stack**: Bun (workspaces) · Hono (server + agent) · Cloudflare Workers + D1 + Drizzle ORM · GOST v3.2.6 · React + shadcn/ui · Biome

## Common Commands

```bash
bun install                     # install all workspaces
bun run lint                    # biome check (root)
bun run type-check              # tsc --noEmit in every workspace
bun run build:web               # build apps/web -> apps/web/dist

bun run dev:server              # wrangler dev (8787) — run inside apps/server after migrations
bun run dev:web                 # vite dev (5173, proxies /api to 8787)
bun run dev:agent               # agent dev server (18090); needs CONTROL_PLANE_URL + NODE_TOKEN

# Server (inside apps/server)
bunx wrangler d1 migrations apply DB --local      # apply migrations to local D1
bunx wrangler d1 execute DB --local --file scripts/seed-local.sql   # local seed data
bun run scripts/hash-password.ts <TOKEN_SALT> <password>           # generate ADMIN_PASSWORD_SHA256

# Agent (inside apps/agent)
bun run test                    # integration test: generates config and drives a real GOST binary
                                # (GOST_BINARY env var, defaults to /home/guyuels/workspace/laoshan/gost-binary/gost)
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
              └─► POST own /gost/config/update ──► generateGostConfig ──► GOST Web API sync

WS channel policy (apps/agent/src/services/wsChannel.ts):
  - healthy WS: HTTP poll is a 5-min safety net only
  - ≥3 WS failures within 60s → fallback to HTTP polling (POLL_INTERVAL_MS + backoff)
  - while fallen back: WS reconnect probe every WS_PROBE_INTERVAL_MS; success returns to ws mode
  - keepalive: agent pings every WS_PING_INTERVAL_MS (default 60s, clamped < 90s —
    the edge closes WebSockets idle > 100s); the DO auto-responds via
    setWebSocketAutoResponse without waking, so heartbeats cost no duration and
    outbound pongs are not billed (inbound messages bill at 20:1)

GOST observer ──► POST agent /gost/observer ({"events":[...]})
  └─► stats events buffered ──► POST /api/agent/stats (batched) ──► D1 gost_stats
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

### Agent (`apps/agent/src`)

- `services/controlPlane.ts` — poll loop with exponential backoff + jitter (max 5 min), initial poll on start; interruptible sleep (`wake()`) so WS pushes trigger an immediate fetch; poll cadence adapts to channel health (5-min safety net while WS is up, `POLL_INTERVAL_MS` otherwise); stats buffer (max 1000 samples) flushed on an interval and at graceful shutdown.
- `services/wsChannel.ts` — `WsConfigChannel`: WebSocket push channel with ping/pong keepalive, reconnect backoff (1s→60s), 3-in-60s failure demotion to poll mode, and periodic reconnect probes with automatic promotion back to ws mode. Set `WS_ENABLED=false` to force pure HTTP polling.
- `routers/gost.ts` — `POST /gost/config/update` (build + apply), `POST /gost/observer` (parses the GOST event envelope, queues `type:"stats"` events only).
- `services/gost/builder.ts` — `generateGostConfig(data: NodeConfigData): GostConfig`; see generation rules below.

## Critical Implementation Details

### GOST Web API semantics (v3.2.6, verified empirically)

- **`POST /api/config` writes the in-memory config to disk; `POST /api/config/reload` re-reads the startup file.** Neither applies a pushed body. Dynamic configuration is **per-object CRUD**: `GET/POST /api/config/{kind}`, `PUT/DELETE /api/config/{kind}/{name}` for kinds `services`, `chains`, `limiters`, `rlimiters`, `climiters`. Changes take effect immediately.
- `GostClient.updateConfig` (`apps/agent/src/services/gost/client.ts`) therefore **diffs** desired vs running objects: deletes removed, PUTs changed (restarts the object), POSTs new, skips unchanged.
- **Observers**: top-level `observers` in `config/gost.json` define an HTTP plugin that POSTs `{"events":[...]}` envelopes to the agent. Events have `kind` (service/handler), `type` ("status" lifecycle or "stats"), and for stats a nested `stats` object (`totalConns/currentConns/inputBytes/outputBytes/totalErrs`).
- **Stats are only reported when a service references the observer AND sets `metadata: { enableStats: "true" }`** (metadata, string — a top-level boolean does NOT work). Builder sets both on every service. Stats are periodic (~5s, `observer.period`) and stop when nothing changed.
- **Schema pitfalls (verified against the swagger spec at api.gost.run)**: `ChainConfig` has only `name/hops/metadata` — there is NO chain-level `selector` (it would be silently dropped and cause perpetual diff mismatches in the object sync); per-hop selectors are valid (`HopConfig.selector`). Auto-generated cert parameters (`validity/commonName/organization`) belong on `NodeConfig.tls` for TLS transports (tls/mtls/wss/mwss) — there is no global `tls` section. `POST /api/config/{kind}` objects are echoed back **normalized** (unknown fields dropped), which the diff sync relies on.

### Config versioning

`node_configs.version` is epoch-seconds-based and bumped monotonically on every recompute (`max(existing, epoch)` + 1 on conflict), so agents can never get stuck on a stale 304 after a snapshot row is recreated. Agents track their version in memory and reset to 0 on restart (full refresh).

### Service generation logic (builder)

Handler/listener types depend on node position (IN/CHAIN/OUT from `chain_type`) and hop count:

- **Entry nodes** (chain_type='in'): 1 hop → simple forwarding (`handler: tcp` + forwarder); 2 hops → `handler: tcp` + chain; 3+ hops → `handler: auto` + chain. Listen port = rule's `listen_port`.
- **Exit nodes** (chain_type='out'): always `handler: relay` with transport-based listener; port from chain's `port` (0 = auto-allocate `start + (chain_id + node_id) % port_range` from `relay_nodes.ports`).

Chains are only generated at entry nodes. Multi-hop chains sort by `index` and may carry a per-hop `selector.strategy`.

Transport mapping (`mapper.ts`): `raw→tcp, tls→tls, wss→ws, mwss→mws`, etc. Limiters (`limiter.ts`): `limiters` (traffic), `rlimiters` (request rate), `climiters` (connections) from the rule's `limit` JSON; supports service-level and per-IP limits.

### Naming conventions

All GOST objects are named deterministically (`service-{ruleId}`, `chain-{tunnelId}`, `node-{nodeId}-t{tunnelId}`, `hop-{tunnelId}-{index}`) — required for the object-diff sync to recognize stale objects across config versions.

### Database schema quirks

- SQLite (D1): enums are TEXT + CHECK constraints; `limit`/`custom_cfg`/`tls_config`/`stats` stored as JSON TEXT.
- Field spellings are now **corrected**: `display_address`, `ingress_display_address` (the old Supabase `disaply_*` typo is intentionally not carried over).
- Node tokens are stored as salted SHA-256 hashes only; the raw token is displayed exactly once (create/rotate).
- `relay_rules.tunnel_id` NULL means "not deployed anywhere" (not part of any node's config).

## Auth

- **Agent**: `Authorization: Bearer <NODE_TOKEN>`; token created/rotated in the admin panel.
- **Admin**: single account from Worker secrets (`ADMIN_USERNAME` / `ADMIN_PASSWORD_SHA256` = sha256 of `${TOKEN_SALT}:admin:${password}`); session = HttpOnly cookie `tyz_admin` = `expiry.hmac(SESSION_SECRET, expiry)`, 7 days.

## Environment Variables

Agent (`apps/agent/.env.example`): `CONTROL_PLANE_URL`, `NODE_TOKEN` (required); `PORT` (18090), `HOST` (127.0.0.1), `GOST_API_URL` (http://localhost:18080), `GOST_API_AUTH`, `POLL_INTERVAL_MS` (10000), `STATS_FLUSH_INTERVAL_MS` (60000), `WS_ENABLED` (true; false = pure HTTP polling), `WS_PROBE_INTERVAL_MS` (60000; WS reconnect probe interval while in poll fallback), `WS_PING_INTERVAL_MS` (60000; heartbeat, clamped < 90s), `DEBUG`.

Server (`apps/server/.dev.vars.example` for local; `wrangler secret put` for production): `ADMIN_USERNAME`, `ADMIN_PASSWORD_SHA256`, `SESSION_SECRET`, `TOKEN_SALT` (**changes token hashes — never rotate after nodes exist**).

## HTTP Endpoints

Server: `GET /api/healthz`; agent-facing `GET /api/agent/config?version=N` (304/200), `GET /api/agent/ws` (WebSocket upgrade; pushes `{"type":"config_changed"}`, answers `ping`→`pong`), `POST /api/agent/stats`; admin `POST /api/admin/login|logout`, `GET /api/admin/me`, CRUD `/api/admin/nodes|tunnels|chains|rules` (+`/api/admin/nodes/:id/{recompute,rotate-token,stats}`).

Agent: `GET /health`, `POST /gost/config/update`, `POST /gost/observer`.

## Code Style

Biome (root `biome.json`): double quotes, 120 cols, organize imports. `noExplicitAny`/`noNonNullAssertion`/a11y anchor rules are downgraded to warnings — this codebase legitimately uses `any` for GOST's untyped config surface and guarded non-null assertions. Run `bun run lint` and `bun run type-check` before committing.

## Testing

`bun run test` (in apps/agent) reads `examples/real-database-example.json`, generates the config and drives a real GOST binary via `GOST_BINARY` (defaults to `/home/guyuels/workspace/laoshan/gost-binary/gost`).

WebSocket push tests (in apps/agent, `wrangler dev` must be running for the first):
- `bun run scripts/test-ws-push.ts` — end-to-end against the control plane: bad token rejected, hello, ping/pong, admin write broadcasts `config_changed`. Uses seed token `dev-token-1` and admin/admin123.
- `bun run scripts/test-ws-channel.ts` — standalone `WsConfigChannel` state machine: 3 failures → poll fallback → probe reconnect → recovery to ws mode (runs its own local WS server, no control plane needed).

For a full local stack run `wrangler dev` + seed + agent + GOST and verify the polling/stats loop (see README 本地开发).
