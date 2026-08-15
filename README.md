# TYZ

GOST 隧道管理平台：Cloudflare 上的控制面（Worker + D1 + 管理 Web）+ 运行在节点机上的 agent（Go 单二进制，GOST 运行时内嵌在进程内）。

```
┌────────────────────────── Cloudflare ──────────────────────────┐
│  Worker (Hono)                                                  │
│   ├─ /api/admin/* 管理面板 API + 静态托管 (React SPA)              │
│   ├─ /api/agent/* 节点 API（Bearer NODE_TOKEN 认证）               │
│   │            /api/agent/ws WebSocket 推送（Durable Object）        │
│   └─ D1: relay_nodes / tunnels / chains / relay_rules /         │
│          node_configs / gost_stats                              │
└───────────────▲─────────────────────────────▲──────────────────┘
        WS 推送 + 版本化拉取 GET /api/agent/config │ POST /api/agent/stats（批量统计）
                │ (config_changed → 304 / 200)  │
┌───────────────┴───────────────────────────────┴────────────────┐
│  节点机（单容器，host 网络）                                       │
│  tyz-agent（Go，内嵌 GOST 运行时）                                │
│   ├─ 配置按对象 diff 热更新（进程内 registry，无需本地 HTTP）        │
│   └─ observer 统计 ──► 缓冲 ──► 批量上报                          │
└─────────────────────────────────────────────────────────────────┘
```

## 仓库结构

| 路径 | 说明 |
|---|---|
| `apps/server` | Cloudflare Worker 控制面：节点/隧道/链路/规则 CRUD、配置聚合下发、统计接收、管理面板托管 |
| `apps/agent` | 节点 agent（Go，内嵌 GOST 运行时）：WebSocket 推送优先（断连自动降级 HTTP 轮询并探测恢复）→ 生成 GOST 配置 → 进程内热更新；缓冲上报 GOST 统计 |
| `apps/web` | 管理面板（React 18 + Vite + shadcn/ui + Tailwind），构建产物由 Worker Assets 托管 |
| `packages/shared` | 三端共享的实体类型、zod schema、API DTO |
| `examples` | 配置数据样例（`real-database-example.json`） |

## 本地开发

前置：Bun ≥ 1.2、Go ≥ 1.26。

```bash
bun install

# 1. 控制面（端口 8787）
cd apps/server
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars：ADMIN_PASSWORD_SHA256 用下面命令生成（TOKEN_SALT 需与 .dev.vars 中一致）
bun run scripts/hash-password.ts <TOKEN_SALT> <密码>
bunx wrangler d1 migrations apply DB --local
bunx wrangler d1 execute DB --local --file scripts/seed-local.sql   # 可选：本地样例数据
bun run dev        # wrangler dev

# 2. 管理面板（端口 5173，/admin 等代理到 8787）
cd ../.. && bun run dev:web

# 3. 节点 agent（端口 18090，GOST 已内嵌，无需单独安装）
CONTROL_PLANE_URL=http://localhost:8787 NODE_TOKEN=dev-token-1 bun run dev:agent

# 4. agent 测试（golden 配置生成 / WS 状态机 / 应用生命周期）
bun run test:agent
```

样例数据中节点 1 的 token 为 `dev-token-1`（对应 `.dev.vars` 中 `TOKEN_SALT=dev-token-salt`）。生产节点请在管理面板创建节点，Token 仅在创建/轮换时显示一次。

完整数据面验证（可选）：向规则监听端口发流量（如 `curl http://localhost:8080`），流量经内嵌 GOST 转发到目标，统计会回流到 D1（管理面板节点统计或 `GET /api/admin/nodes/1/stats` 可见）。

## 部署

### 控制面（Cloudflare）

```bash
cd apps/server
bunx wrangler d1 create tyz          # 把返回的 database_id 填入 wrangler.jsonc
bunx wrangler d1 migrations apply DB --remote
bunx wrangler secret put ADMIN_USERNAME
bunx wrangler secret put ADMIN_PASSWORD_SHA256   # bun run scripts/hash-password.ts <TOKEN_SALT> <密码>
bunx wrangler secret put SESSION_SECRET          # 随机串
bunx wrangler secret put TOKEN_SALT              # 随机串，决定节点 token 哈希，部署后勿改
bun run --filter @tyz/web build     # Worker Assets 托管 ../web/dist
bunx wrangler deploy
```

CI：`deploy-server.yml`（手动触发或 v* tag，需 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets）；`check.yml`（lint + 类型检查 + agent Go vet/test + 前端构建）。

### 节点机

```bash
docker compose up -d   # 单容器 tyz-app（镜像 ghcr.io/laoshan-tech/tyz-node，host 网络，GOST 内嵌）
```

节点机 `.env`（参考 `apps/agent/.env.example`）：`CONTROL_PLANE_URL`、`NODE_TOKEN` 必填。TLS 传输的自动证书持久化在容器卷 `tyz-data` 中，重启后证书保持不变。

## 说明

- 配置下发优先走 WebSocket 长连接（`GET /api/agent/ws`）：管理端写操作实时推送 `config_changed`，agent 立即拉取（304/200 去重）；WS 在 60 秒内断连 3 次自动降级为 HTTP 轮询（默认 10s，`POLL_INTERVAL_MS` 可调），降级期间每 60 秒探测重连（`WS_PROBE_INTERVAL_MS` 可调），成功后自动切回推送模式；`WS_ENABLED=false` 可强制纯轮询。统计默认 60s 批量上报（`STATS_FLUSH_INTERVAL_MS`）。
- agent 进程内按对象 diff 热更新 GOST（services/chains/limiters 走 go-gost registry），未变化的服务不会被重启。
- 历史统计保留 30 天，由 Worker Cron 每日清理。
