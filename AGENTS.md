# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

TYZ is a GOST (GO Simple Tunnel) tunnel management platform in a Bun-workspaces monorepo:

- **Control plane** (`apps/server`): Cloudflare Worker (Hono) + D1 (SQLite). Serves the admin panel (assets + CRUD API) and the agent API (versioned config polling, batched stats upload).
- **Node agent** (`apps/agent`): a single Go binary with the GOST runtime embedded in-process (`go-gost/core v0.6.0` + `go-gost/x v0.15.2`, the gost master/nightly-20260802 pins). Polls config (WS push first, HTTP fallback), renders GOST objects from domain data, applies them directly through the GOST registries, and reports observer stats. Deployed as one container per relay machine (Docker, host network).
- **Admin web** (`apps/web`): **React 19.2** + Vite + **HeroUI v3** (`@heroui/react` 3.2.x + `@heroui/styles`, built on React Aria Components + **Tailwind CSS v4** via `@tailwindcss/vite`; no framer-motion dependency) + TanStack Query + `@tabler/icons-react`. Components are compound (`Modal.Backdrop/Container/Dialog`, `Table.ScrollContainer/Content/Header/Body`, `TextField > Label/Input/FieldError`) and use `onPress`/`isPending` instead of onClick/loading. Shared wrappers in `src/ui.tsx` keep pages terse: `TextForm`/`NumberForm`/`SelectForm` (label + error/hint in one line; Select supports `multiple`), `FormModal`/`SideDrawer` shells, `RowButton`/`SubmitButton`, `PageHeader`/`PageShell` (list-page scaffolding: Typography Heading/Paragraph header + content; tables are NOT wrapped in Cards so they keep the default primary Table look — rounded surface card), `emptyState` (HeroUI EmptyState), `useFormValues` (object-shaped controlled state; dialogs mount their form keyed by entity id so values re-initialize on open). Prefer HeroUI defaults over custom classes — custom classNames are layout-only (flex/grid/spacing) plus `text-muted` hierarchy hints. Left sidebar is a fixed Tailwind layout (mobile: top bar + Drawer nav). Dark mode toggles `<html class="dark" data-theme>` via `src/theme.ts` (`useTheme`, persisted as `tyz-theme`) with a pre-paint inline script in `index.html`; HeroUI semantic tokens (`bg-background`, `text-muted`, `border-border`, `accent-soft`…) drive all styling. Global radius is set to the small preset by overriding `--radius: 0.25rem` in `index.css` (every component radius AND Tailwind `rounded-*` derive from this one variable — change it there, not per-component). Destructive confirmations use the shared `confirmDanger` helper (`src/confirm.tsx`, module-level bridge to a mounted `AlertDialog`); toasts use the imperative `toast()`/`toast.success()`/`toast.danger()` API with one `<Toast.Provider placement="top">` in `main.tsx`. Noto Sans SC simplified-Chinese font subsets are bundled explicitly (headless/Linux environments otherwise show missing CJK glyphs). Built output is served by the Worker via the `ASSETS` binding with SPA fallback implemented in `app.notFound`. Layout: full-width sticky top navbar (page title; theme toggle, account chip → profile, logout on the right) + fixed left sidebar (mobile: burger + Drawer). Pages: dashboard (`/` — user/rule/node/tunnel stat cards linking to their pages), nodes (per-service health + 24h connection peaks in a Drawer), tunnels (chain management Drawer), rules (owner + quota-stop chip + manual restart; target picked from stored endpoints or entered manually), endpoints (named forwarding targets with reference count; address edits auto-sync referencing rules), users (subscriptions, per-rule usage, stop reasons), packages (traffic/window/access/rule-count via multi-Select), settings with expandable sidebar submenu (basic/notification/announcement/site are planned-feature placeholders — no backend yet; audit lives at `/settings/audit`, old `/audit` redirects), profile (`/profile`, account info from `GET /api/admin/me`).
- **Shared** (`packages/shared`): entity types, zod schemas, API DTOs used by server and web.

**Stack**: Bun (workspaces) · Hono (server) · Cloudflare Workers + D1 + Drizzle ORM · Go (agent: embedded GOST via go-gost/x) · React 19 + HeroUI v3 + Tailwind CSS v4 · Biome

## Common Commands

```bash
bun install                     # install all workspaces
bun run lint                    # biome check (root)
bun run type-check              # tsc --noEmit in every workspace
bun run build:web               # build apps/web -> apps/web/dist

bun run dev:server              # wrangler dev (8787, root wrangler.jsonc) — apply migrations first
bun run dev:web                 # vite dev (5173, proxies /api to 8787)
bun run dev:agent               # go run the agent; needs CONTROL_PLANE_URL + NODE_TOKEN
bun run test:agent              # go test ./... in apps/agent (golden builder, WS state machine, apply)

# Server (from the repo root — wrangler.jsonc lives there)
bunx wrangler d1 migrations apply DB --local      # apply migrations to local D1
bun run db:seed:local                            # local seed data
bun run apps/server/scripts/test-ws-push.ts [baseUrl]   # e2e push test vs wrangler dev (dev-token-1, admin/admin123)

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
  - every successful (re)connect fires `OnConnected` → an immediate poll: a
    config_changed broadcast during a disconnect window is lost (the DO pushes
    to live sockets only), so the gap is closed on reconnect instead of after
    the safety-net interval
  - ≥3 WS failures within 60s → fallback to HTTP polling (POLL_INTERVAL_MS + backoff)
  - while fallen back: WS reconnect probe every WS_PROBE_INTERVAL_MS; success returns to ws mode
  - keepalive: agent pings every WS_PING_INTERVAL_MS (default 60s, clamped < 90s —
    the edge closes WebSockets idle > 100s); the DO auto-responds via
    setWebSocketAutoResponse without waking, so heartbeats cost no duration and
    outbound pongs are not billed (inbound messages bill at 20:1)
  - manual rule restart: the panel's POST /rules/:id/restart broadcasts
    {"type":"restart_service","service":"service-{id}"} through the DO;
    gostapply.RestartService rebuilds that ONE service from the last applied
    config (dropping its live connections) — a pure operator action that must
    not smuggle in config changes (the rebuild source is a.last, not a fetch);
    nodes not serving the service no-op
  - shutdown: the loop calls WsChannel.Stop() (close frame + timer teardown)

embedded GOST observer (statsobs) ──► stats buffer ──► POST /api/agent/stats (batched) ──► D1 gost_stats
gostapply.HealthSnapshot (x/service.Status) ──► rides the same stats POST ──► D1 service_health (latest per node+service)
stats ingest (traffic.ts) ──► deltas vs traffic_counters ──► D1 traffic_hourly (per rule-hour ledger, billing SoT)
```

### Key server modules (`apps/server/src`)

- `index.ts` — Hono app, mounts `/agent` and `/admin`, SPA fallback via `env.ASSETS`, daily cron pruning `gost_stats` (>30 days) and `audit_log` (>180 days; the hourly traffic ledger is NEVER pruned — permanent packages need unbounded windows) + recomputing every node config (quota sweep: expired subscriptions / drained allowances hard-stop their rules; unchanged configs skip the version bump). Exports `AppType` and the `NodePushDO` class.
- `services/quota.ts` — package/subscription enforcement: the server is the billing ledger (per-user usage = SUM over the user's rules from the `traffic_hourly` ledger within the subscription window; window start floored to its hour — a conservative ≤1h overcount that never over-delivers), the agent is the enforcement point. Hard-stop (rule dropped from aggregation) on disabled user / no subscription / expired / exhausted; otherwise rules carry `quota: {name: quota-user-{id}, limit_bytes: REMAINING, starts_at, expires_at?}` shared by every rule of the owner. Switching/renewing a subscription replaces its row with a fresh `activated_at` — the window change clears historically used traffic on both the ledger and the agent counter (换购清零).
- `routes/agent.ts` — node-facing endpoints; auth via `middleware/nodeAuth.ts` (Bearer token → SHA-256 hash lookup in D1, 60s in-isolate cache; `sha256(salt:node:token)` when the optional `TOKEN_SALT` secret is set, else unsalted `sha256(node:token)` — tokens are 128-bit random). `GET /ws` forwards the authenticated upgrade request to the node's `NodePushDO`.
- `do/nodePush.ts` — `NodePushDO` (one Durable Object instance per node, `idFromName(String(nodeId))`): accepts WebSockets via the hibernation API, auto-responds to `ping`→`pong` at the edge (`setWebSocketAutoResponse`, object stays hibernated), and on `POST /notify` broadcasts `{"type":"config_changed"}` to all live sockets of that node. Bound as `CONFIG_PUSH` in wrangler.jsonc (SQLite class migration `v2_node_push_do`).
- `services/notify.ts` — `notifyConfigChanged(env, nodeIds)`: fire-and-forget fan-out to the DOs; never fails the admin write.
- `services/tls.ts` — platform link-TLS material: a self-signed ECDSA P-256 CA plus server/client leaves, generated in-process with a hand-rolled minimal DER encoder (Workers has no X.509 library; SubjectPublicKeyInfo is embedded raw from WebCrypto export). Stored as PEM in `tls_material` (kind = ca|server|client); `ensureTlsMaterial` lazy-generates on first TLS aggregation (and after a domain change drops/re-issues the server cert), `renewTlsMaterial` (daily cron) re-issues leaves inside 30d of expiry and the whole set when the CA drops below 90d, then recomputes the TLS-enabled nodes. The disguise domain (`app_settings.tls_domain`, one platform-wide SNI) is set from the settings page (`PUT /api/admin/settings/tls-domain`, `GET /api/admin/tls/status` shows expiry metadata only). **PEM material and `relay_auth_*` are secrets of the node-token trust domain: delivered only through the agent config payload, never in admin responses or audit rows.** Cert correctness is cross-verified: `tls.test.ts` self-checks signatures via WebCrypto, and the Go side (`internal/certs`) parses a committed fixture with crypto/x509 (chain, SAN, EKU, key match).
- `routes/admin.ts` — login (HMAC-signed HttpOnly session cookie, `middleware/adminAuth.ts`), full CRUD for nodes/tunnels/chains/rules/users/packages, subscribe (activate/switch/renew), token rotate (shown once), stats + health query, audit query, recompute. Every write path recomputes `node_configs` for affected nodes via `recomputeAndNotify` / `recomputeTunnelNodes` (recompute + WS push) and records an audit row. `GET /rules` enriches user-owned rows with the derived `quota_stopped`/`quota_reason` so the panel can distinguish quota hard-stops from a manual `status=paused`.
- `db/schema.ts` — Drizzle schema mirroring `migrations/0001_init.sql`; property names keep snake_case to match the shared entity types, `chains.idx` aliases to entity `index`, boolean/json column modes replace the old hand-written row mappers. **`nodeEntityColumns` is the allowlist for node fields in API responses — never select `token_hash`/`tls_config` into responses.** Schema changes: edit `schema.ts` → `bunx drizzle-kit generate` (see `drizzle.config.ts`) → copy SQL into `migrations/` → apply with wrangler.
- `db/repo.ts` — Drizzle data access: config aggregation, snapshot upsert (version bump upsert kept as raw SQL), thin `to*` helpers that fold nullable columns to the entity `field?: T` shape.
- `services/aggregate` lives in `db/repo.ts`: node → chains touching the node → tunnels → rules attached to those tunnels + ALL chains of those tunnels (full relay path). A rule without a tunnel is never part of any node's config.

### Agent (`apps/agent`, Go)

- `main.go` — wiring: env config, slog (+ GOST logger routed to stdout), global default certificate, control loop, debug-only GOST Web API (started when `DEBUG=true`, listening on `GOST_API_ADDR`, default `127.0.0.1:18080`), signal handling (SIGTERM → final stats flush + close services). No HTTP server of its own: node health is judged by control-plane reports.
- `internal/agentcfg` — env/dotenv loading; variables mirror the previous agent.
- `internal/model` — Go structs mirroring `@tyz/shared` payloads (only consumed fields).
- `internal/builder` — `Build(NodeConfigData) *config.Config`: port of the TS builder (golden-tested against its output); `DefaultTLS` feeds the control-plane TLS hints into the global default certificate.
- `internal/gostapply` — `Apply(*config.Config)`: registry diff-apply (see below); admissions are reconciled too — created FIRST and deleted LAST (services resolve admission names at parse time).
- `internal/statsobs` — in-process `observer.Observer` (registered as `stats-observer`); forwards `StatsEvent`s to the stats buffer.
- `gostapply.HealthSnapshot` — reads the runtime state of every registered service via x/service's `Status()` (running/ready/failed/closed + last accept error), plus synthetic `apply_failed` entries for services the last Apply skipped (parse/bind failures — they have no registry presence of their own). The full snapshot rides along with every stats flush (`loop.Options.Health`); the server upserts it into `service_health` and deletes rows for services that disappeared from the snapshot. The loop logs only failed↔recovered transitions.
- `internal/certs` — persists the platform link-TLS PEM material from the config payload into `certs/` in the working directory (atomic tmp+fsync+rename, 0700/0600, content-unchanged skips). Called by the Apply closure BEFORE `builder.Build` — GOST resolves the cert paths at service parse time. Mount `certs/` like `last-config.json`/`quota-store.json`.
- `internal/cp` — control-plane HTTP client (config fetch w/ 304, stats upload) and `WsChannel` (ping/pong keepalive, reconnect backoff 1s→60s, 3-in-60s failure demotion to poll mode, periodic probes promoting back to ws mode; `WS_ENABLED=false` forces pure HTTP polling).
- `internal/loop` — poll loop with exponential backoff + jitter (max 5 min) and interruptible sleep (`Wake()`) so WS pushes, WS (re)connects and channel mode changes trigger an immediate fetch; poll cadence adapts to channel health (5-min safety net while WS is up, `POLL_INTERVAL_MS` otherwise); stats buffer (max 1000) flushed on an interval (random startup phase, so a fleet started together does not hit the stats endpoint in lockstep) and at graceful shutdown; the cache file is written with fsync before rename so power loss cannot leave it truncated. The applied version is only adopted on success so failed applies retry on the next poll (partial applies included — see apply semantics). **Offline bootstrap**: the last applied config is persisted to `last-config.json` in the working directory (atomic write, `AgentConfigResponse` shape) and re-applied at startup; its version becomes the polling baseline, so an unchanged config after an outage costs one 304. Unreadable/stale caches are skipped with a warning — the loop then starts from scratch.
- `internal/drivers` — GOST driver registration, verbatim from gost's `cmd/gost/register.go`. The **full** set is required: GOST parsers default to connector types (e.g. `http` for forwarder nodes) and the `auto` handler probes http/socks handlers — a curated subset breaks on those implicit defaults.

## Critical Implementation Details

### Embedded GOST apply semantics (go-gost/x v0.15.2, source-verified)

- Dynamic config is done **in-process** via the same primitives the GOST Web API uses: `parser.ParseService/ParseChain/ParseTrafficLimiter/ParseRateLimiter/ParseConnLimiter/ParseQuotaLimiter` + `x/registry` singletons. `gostapply.Apply` diffs desired vs the last applied desired config (deep equality on config structs — no API echo to normalize): changed chains are **pre-parsed as a validation pass before any mutation** (a broken desired config is rejected wholesale and the previous config keeps serving — services cannot join this pass because ParseService binds its port, gost issue #754), then deletes top-down (services → chains → quotas → climiters → rlimiters → limiters), creates bottom-up; chains/limiters/quotas hot-swap via `Unregister+Register` (registry wrappers re-resolve on every use), **services must be closed and re-served** on change.
- **Partial-failure semantics (services)**: a service whose ParseService fails (typically a port conflict) does NOT abort the apply — every other object applies, the failed one is skipped and reported through `HealthSnapshot` as state `apply_failed`, and `Apply` returns an aggregate error so the version is NOT adopted and the next poll retries (recovering transient conflicts). `a.last` still records the desired config, so the retry rebuilds only the skipped service, not the ones that succeeded.
- **Dead-service self-heal**: a registered service whose accept loop exited (`Status().State() == closed` — set only by Serve() returning a non-temporary error, never by Close itself) is force-rebuilt on the next Apply even when its config is unchanged. Without this, a dead port would stay dead until the next config change.
- **What a config change costs at runtime** (field → impact):
  | changed field | effect | live connections |
  |---|---|---|
  | service: name/addr/listen_port/handler/listener/metadata/forwarder/limiter refs | service closed + re-parsed + re-served | **dropped** for that rule |
  | chain object contents (node addr/transport/strategy) | `Unregister+Register` hot-swap | kept (re-resolved on next use) |
  | limiters / rlimiters / climiters | hot-swap | kept |
  | quota, same window (remaining refresh) | hot-swap, counter preserved | kept |
  | quota, changed window (换购/续费) | hot-swap, counter resets | kept |
  | quota removed from config | fail-open until the rule is removed | kept (gate lifts) |
  | rule removed from config | service deleted | dropped |
  - Note the asymmetry with the quota gate: an exhausted allowance blocks new connections (Accept parks) without dropping established ones.
- **Observers**: the in-process observer implements `core/observer.Observer` (`Observe(ctx, events []Event)`) and is registered under `stats-observer` **before** the first apply (services resolve the observer by name at parse time).
- **Stats are only reported when a service references the observer AND sets `metadata: { enableStats: "true" }`** (metadata, string — a top-level boolean does NOT work). Builder sets both on every service. Stats are periodic (~5s, `observer.period`) and stop when nothing changed.
- **Schema pitfalls**: `ChainConfig` has only `name/hops/metadata` — there is NO chain-level `selector`; per-hop selectors are valid (`HopConfig.selector`). `NodeConfig.tls` is `TLSNodeConfig` (`serverName`/`secure`/`options` only — the old TS agent's `nodes[].tls{validity,commonName,organization}` was always silently dropped by GOST). Auto-generated certificate parameters now go to the **global default certificate** via `builder.DefaultTLS` + `parsing.BuildDefaultTLSConfig` (generated once, persisted under `$HOME/.gost`, reused across restarts; first generation wins even if the control-plane hints change later).
- Version note: `core v0.6.0 / x v0.15.2` correspond to gost master/nightly 20260802 — the stable tag v3.2.6 pins older modules (`core v0.3.3/x v0.8.1`). Keep the pins exact; when bumping, re-verify the config structs and the builder golden test.

### Config versioning

`node_configs.version` is epoch-seconds-based and bumped monotonically on every recompute (`max(existing, epoch)` + 1 on conflict), so agents can never get stuck on a stale 304 after a snapshot row is recreated. Agents track their version in memory and reset to 0 on restart (full refresh).

### Service generation logic (builder)

Two-node tunnels have a **forward mode** (`tunnels.forward_mode`): `relay` (default, port-multiplexed relay protocol) or `raw` (plain tcp/tcp forwarding with a dedicated port pair per rule — no relay protocol header on the wire, the censorship-evasion shape). Handler/listener types depend on node position (IN/CHAIN/OUT from `chain_type`), hop count and mode:

- **Entry nodes** (chain_type='in'): one service per rule listening on the rule's `listen_port`; raw mode → `handler: tcp` + forwarder pointing at the rule's dedicated exit port (NO chain object; a single-node raw tunnel — one `in` chain, no exit — renders the plain direct-forward shape instead, byte-identical to the 1-hop relay form); otherwise 1 hop → simple forwarding (`handler: tcp` + forwarder); 2 hops → `handler: tcp` + chain; 3+ hops → `handler: auto` + chain. All rules of a relay tunnel reference the same chain.
- **Exit/relay nodes, relay mode**: exactly **one** `handler: relay` service per tunnel (`service-t{tunnelId}`), regardless of rule count — the relay protocol carries each connection's destination in-band, so N entry rules funnel through one exit port (which may even numerically equal an entry listen port; they live on different machines). Port = the chain row's `port` (0 = auto-allocate `start + (chain_id + node_id) % port_range` from `relay_nodes.ports`). Rule limiters apply at the entry services only.
- **Exit/relay nodes, raw mode**: one `service-{ruleId}` tcp/tcp service per rule on the rule's `exit_port` (same name as the entry's service — different machines, independent registries; the panel's restart directive rebuilds both ends). `exit_port` 0 auto-allocates `start + (rule_id*31 + node_id) % port_range` — entry and exit compute the same value independently; collisions surface as `apply_failed` health and are fixed by pinning an explicit port. No limiters/quotas on exit services (counting both legs would double-dip one allowance).

Chains are only generated at entry nodes, and never for raw tunnels. **Hop dial addresses resolve per chain row from that row's own node record**: the aggregation delivers `NodeConfigData.nodes` (records for every node the chains reference, incl. the recipient); `chainAddr` = `nodes[chain.node_id].address` + `chain.port` (0 = auto-allocate from **that node's** port range with the same deterministic formula the node itself uses, so both sides agree without coordination). Payloads without `nodes` (legacy snapshots) fall back to the recipient node. **`tunnels.ingress_display_address` is a client-facing display field (admin panel) and never takes part in config generation.** Two-hop chains have a single hop = the exit's chain row (`connector: relay`, dialer from the exit row's transport). Multi-hop chains sort by `index` and may carry a per-hop `selector.strategy`; note that multi-hop (3+) shapes are golden-locked but have **not** been validated against a real 3-node deployment — hop composition (every chain row, including the IN row, becomes a hop) follows the original implementation.

**Link TLS** (`tunnels.tls_enabled`, relay mode only, 2-hop with out transport grpc|tls — validated at the admin API and normalized at aggregation): the relay link is wrapped in TLS 1.3 with **platform-issued certificates** (see `services/tls.ts`). The exit's relay listener serves the platform server cert, verifies clients against the platform CA (mutual TLS), rejects unknown SNI and locks `serverNames` to the platform domain; grpc transport adds `path: /grpc` + ALPN h2 so the flow is indistinguishable from ordinary gRPC traffic. The entry's chain dialer presents the client cert and verifies the exit (`secure` + `serverName` = domain + `caFile`); grpc dialers add `metadata.host` (the :authority/SNI disguise — the dial targets an IP). Cert PEM material rides inside the config payload (`NodeConfigData.tls_material`); the agent writes it to `certs/` in the working directory (`internal/certs`, atomic writes, content-unchanged skips) BEFORE Build/Apply — GOST resolves the file paths at service parse time. **Three link-authentication layers** guard TLS tunnels: mTLS + per-tunnel relay credentials (`tunnels.relay_auth_user/pass`, auto-generated, emitted as GOST AuthConfig whenever present) + an admission whitelist (`admission-t{tunnelId}`) admitting only the tunnel's entry-node IPs (host of each in-chain node's `address`, /32 or /128; non-IP addresses are skipped). Admission objects are reconciled by gostapply: created FIRST (services resolve them by name at parse time) and deleted LAST.

Transport mapping (`internal/builder/mapper.go`): `raw→tcp, tls→tls, wss→ws, mwss→mws`, etc. Limiters (`internal/builder/limiter.go`): `limiters` (traffic), `rlimiters` (request rate), `climiters` (connections) from the rule's `limit` JSON; supports service-level and per-IP limits.

**Traffic quotas** (`internal/builder/quota.go`): rules whose payload carries `quota` get a GOST quota object referenced from the rule's own service (entry nodes + standalone forwards; exit relay services never carry quotas — they are shared across the tunnel's rules). All rules of one owner share the quota name (`quota-user-{userId}`), so they count against one counter per node. Quotas hot-swap (Unregister+Register, no connection disruption): a same-window change refreshes the remaining limit while keeping the accumulated counter; a changed window (换购/续费) resets it. `limit` must carry a `B` suffix — `units.ParseBase2Bytes` rejects unit-less integers. Counters persist in `quota-store.json` (working directory — mount it like `last-config.json`). gost quotas fail-open outside their window and on object deletion, so "stop" semantics must come from config removal (the aggregation drops hard-stopped rules).

### Naming conventions

All GOST objects are named deterministically (`service-{ruleId}` at entries, `service-t{tunnelId}` at exits, `chain-{tunnelId}`, `node-{nodeId}-t{tunnelId}`, `hop-{tunnelId}-{index}`, `quota-user-{userId}`) — required for the registry diff-apply to recognize stale objects across config versions.

### Database schema quirks

- SQLite (D1): enums are TEXT + CHECK constraints; `limit`/`custom_cfg`/`tls_config`/`stats` stored as JSON TEXT.
- Field spellings are now **corrected**: `display_address`, `ingress_display_address` (the old Supabase `disaply_*` typo is intentionally not carried over).
- Node tokens are stored as SHA-256 hashes only (salted when the optional `TOKEN_SALT` secret is set); the raw token is displayed exactly once (create/rotate). The root `wrangler.jsonc` D1 binding intentionally omits `database_id` — wrangler's automatic resource provisioning (≥ 4.45) creates/links the database by name, keeping the public repo free of account-specific ids.
- `relay_rules.tunnel_id` NULL means "not deployed anywhere" (not part of any node's config). `relay_rules.user_id` NULL means admin-managed (never quota-gated). `relay_rules.exit_port` = dedicated raw-mode exit port (0 = deterministic auto-allocation, see builder). `relay_rules.endpoint_id` references a stored `endpoints` row (NULL = manually-entered address): `targets` keeps its own copy of the composed address so the agent config pipeline never joins endpoints — the admin API re-syncs referencing rules (and recomputes their tunnels) whenever an endpoint's host/port change, resolves the address server-side on rule writes, and refuses to delete an endpoint that is still referenced (409). `endpointAddress()` in `@tyz/shared` composes host+port (IPv6 bracketed) on both sides.
- `tunnels.forward_mode` ∈ {relay, raw} — raw is valid for the single-node shape (one `in` chain, direct forward) and the two-node shape (one `in` + one `out`); `tunnels.tls_enabled` requires the 2-hop relay shape with out transport grpc|tls; `tunnels.relay_auth_user/pass` are stored PLAINTEXT (every recompute re-emits them into agent configs as cleartext AuthConfig) and stripped from all admin responses (`toTunnel` vs `toTunnelPayload`). Mode/shape rules are enforced on tunnel + chain writes (`validateTunnelMode` / `validateProjectedShape`) and re-normalized at aggregation (`normalizeTunnelMode`) as a last line of defense — an impossible state degrades to plaintext relay, consistent on both ends. TLS shape validation rejects only states that can never complete (duplicate in/out links, out transport outside grpc|tls); a missing side is a construction intermediate (links are created one at a time) that aggregates as plaintext until complete, and only deleting a link from a COMPLETE TLS tunnel requires turning TLS off first.
- `app_settings` (key/value; v1 key `tls_domain`) and `tls_material` (kind PK + PEM + not_after) — see `services/tls.ts`. Keys/PEMs never selected into admin responses.
- Packages: `traffic_bytes`/`period_days`/`max_rules` 0 = unlimited; `node_ids`/`tunnel_ids` NULL = unrestricted. One active `user_packages` row per user (UNIQUE); subscribe/switch replaces it with a fresh `activated_at` (usage window restarts). `package_name`/`traffic_bytes` on the subscription are snapshots frozen at buy time.
- `traffic_hourly` (per rule-hour, PK `(rule_id, hour_ts)`) is the billing ledger: ingest-time UPSERT accumulation of observer-counter deltas (see `services/traffic.ts` — writes go ledger-first so a crash over-counts instead of under-counting). `real_*` keep actual bytes; `billed_*` accumulate round(real × `relay_nodes.rate`) — the line billing multiplier (0.1..100, default 1.0); quota remaining is computed from BILLED bytes. Deliberately NO foreign keys: deleting a rule/user must not erase usage. `traffic_counters` holds the last cumulative snapshot per (node, service) to turn cumulative reports into deltas. `service_metrics_hourly` rolls up per-service connection samples hourly (sum+samples for exact averages, max for peaks; 7-day retention, no FK). `audit_log` records admin writes (`actor` snapshot; `detail` never holds secrets — rotate-token logs the rotation, never the token).

## Auth

- **Agent**: `Authorization: Bearer <NODE_TOKEN>`; token created/rotated in the admin panel.
- **Admin**: single account from Worker secrets — `ADMIN_USERNAME` + `ADMIN_PASSWORD` (plaintext secret, timing-safe compare). Legacy `ADMIN_PASSWORD_SHA256` (= sha256 of `${TOKEN_SALT}:admin:${password}`) still works when `ADMIN_PASSWORD` is unset. Session = HttpOnly cookie `tyz_admin` = `expiry.hmac(key, expiry)`, 7 days; the key is `SESSION_SECRET` or, when unset, derived from the admin credential (rotating the credential invalidates sessions once).

## Environment Variables

Agent (`apps/agent/.env.example`, loaded from the working directory; real env vars take precedence): `CONTROL_PLANE_URL`, `NODE_TOKEN` (required); `POLL_INTERVAL_MS` (10000), `STATS_FLUSH_INTERVAL_MS` (60000), `WS_ENABLED` (true; false = pure HTTP polling), `WS_PROBE_INTERVAL_MS` (60000; WS reconnect probe interval while in poll fallback), `WS_PING_INTERVAL_MS` (60000; heartbeat, clamped < 90s), `DEBUG` (test-only: verbose logs + starts the embedded GOST Web API), `GOST_API_ADDR` (GOST Web API listen address, effective only with `DEBUG=true`; default `127.0.0.1:18080`, override on port conflict).

Server (root `.dev.vars` for local — next to `wrangler.jsonc`; `wrangler secret put` for production): `ADMIN_USERNAME`, `ADMIN_PASSWORD` (plaintext login; legacy `ADMIN_PASSWORD_SHA256` + `TOKEN_SALT` as an alternative); optional `SESSION_SECRET` (derived from the admin credential when unset) and `TOKEN_SALT` (**if set, changes the token-hash scheme — never change/unset it after nodes exist**).

## HTTP Endpoints

Server: `GET /api/healthz`; agent-facing `GET /api/agent/config?version=N` (304/200), `GET /api/agent/ws` (WebSocket upgrade; pushes `{"type":"config_changed"}` / `{"type":"restart_service","service":...}`, answers `ping`→`pong`), `POST /api/agent/stats` (samples + service health snapshot; samples also fold into the hourly ledger and metrics rollup); admin `POST /api/admin/login|logout`, `GET /api/admin/me`, CRUD `/api/admin/nodes|tunnels|chains|rules|users|packages|endpoints` (+`/api/admin/nodes/:id/{recompute,rotate-token,stats,health}`, `/api/admin/users/:id/subscribe` for activate/switch/renew, `GET /api/admin/users/:id` returns the rules' quota status incl. stop reasons, `GET /api/admin/audit` for the admin write trail, `POST /api/admin/rules/:id/restart` for the manual restart directive, `GET /api/admin/nodes/:id/metrics` for the hourly connection rollup, `GET /api/admin/tls/status` + `PUT /api/admin/settings/tls-domain` for the platform link-TLS domain and cert expiry metadata).

Agent: no HTTP surface of its own (a node is considered healthy as long as it keeps reporting; config apply and observer stats are in-process function calls). `DEBUG=true` starts the embedded GOST Web API at `GOST_API_ADDR` (default `127.0.0.1:18080`, `/api` prefix — read-write, test-only) for inspecting the actually-applied GOST config.

## Code Style

Biome (root `biome.json`) covers the TS workspaces: double quotes, 120 cols, organize imports; `noExplicitAny`/`noNonNullAssertion`/a11y anchor rules are downgraded to warnings. Go code (`apps/agent`): standard `gofmt` formatting, `log/slog` structured logging, no config frameworks. Run `bun run lint`, `bun run type-check`, and `go vet ./...` + `go test ./...` (apps/agent) before committing.

## Testing

`bun run test:agent` (i.e. `go test ./...` in apps/agent):
- builder golden tests: builds `examples/real-database-example.json` → `aggregated_data` and compares against `internal/builder/testdata/golden-gost-config.json` (the TS builder's output, kept as the baseline; two documented deltas are normalized — the inert `nodes[].tls` auto-cert fields and `selector.failTimeout` seconds-vs-nanoseconds); the two-node relay scenario (`testdata/two-node-example.json`, entry + exit perspectives) pins the shared-exit-port shape; `raw-two-node.json` pins the raw per-rule port pairs (explicit + auto-allocated exit ports, no chain object); `relay-tls-grpc.json` / `relay-tls-tls.json` pin the TLS link shape (dialer/listener TLS options, relay auth, admission object, grpc metadata). Regenerate with `go test ./internal/builder -update` after intentional changes — note the golden OUTPUT files are excluded from biome formatting (Go's MarshalIndent style).
- TLS material: `apps/server/src/services/tls.test.ts` (WebCrypto signature self-checks) and `internal/certs` (parses the committed fixture with crypto/x509: chain, SAN, EKU, key match; atomic-write/skip-unchanged behavior). Regenerate the fixture after changing the encoder: `cd apps/server && bun run scripts/gen-tls-fixture.ts`.
- gostapply: admission lifecycle (create-before-service, delete-after, idempotent re-apply, drop on TLS removal) alongside the existing registry lifecycle tests.
- WsChannel state machine: 3 failures → poll fallback → probe reconnect → recovery → `config_changed` delivery (own local WS server, no control plane needed).
- apply tests: registry lifecycle (create / idempotent re-apply / update / delete / limiter hot-swap / two-node entry+exit swap).

Live two-agent e2e (needs `wrangler dev` + seed): `apps/agent/scripts/e2e-local.sh` — re-applies the seed (single-hop tunnel-1; two-node relay tunnel-2 sharing the exit's :16900; raw tunnel-3 with per-rule port pairs 16556→26556 / 16557→26557; TLS relay tunnel-4 over grpc on :16901 with platform certs — the seed sets `tls_domain=relay.local.test` and drops `tls_material` so every run issues fresh certs), builds the agent, starts two local HTTP targets and two agent processes, and asserts distinguishable responses through every entry port plus that a plaintext probe on the TLS listener is refused.

Server-side e2e (needs `wrangler dev` running): `bun run scripts/test-ws-push.ts` (inside apps/server) — bad token rejected, hello, ping/pong, admin write broadcasts `config_changed`. Uses seed token `dev-token-1` and admin/admin123.

For a full local stack run `wrangler dev` + seed + the Go agent (`bun run dev:agent`); send traffic through a rule's listen port and watch `gost_stats` rows appear.
