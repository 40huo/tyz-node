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

# 1. 控制面（端口 8787；wrangler.jsonc 与 .dev.vars 都在仓库根）
cp .dev.vars.example .dev.vars        # 默认 admin/admin123 即可登录本地面板
bunx wrangler d1 migrations apply DB --local
bun run db:seed:local                 # 可选：本地样例数据
bun run dev:server                    # wrangler dev

# 2. 管理面板（端口 5173，/admin 等代理到 8787）
bun run dev:web

# 3. 节点 agent（端口 18090，GOST 已内嵌，无需单独安装）
CONTROL_PLANE_URL=http://localhost:8787 NODE_TOKEN=dev-token-1 bun run dev:agent

# 4. agent 测试（golden 配置生成 / WS 状态机 / 应用生命周期）
bun run test:agent

# 5. 双节点 e2e（可选）：单节点直转 + 双节点中继（多规则共享出口端口）
apps/agent/scripts/e2e-local.sh
```

样例数据中节点 1/2 的 token 为 `dev-token-1`/`dev-token-2`（对应 `.dev.vars` 中 `TOKEN_SALT=dev-token-salt`）；拓扑含单节点直转（tunnel-1）与双节点中继（tunnel-2：两条入口规则共享出口 :16900 的 relay 监听）。生产节点请在管理面板创建节点，Token 仅在创建/轮换时显示一次。

完整数据面验证（可选）：向规则监听端口发流量（如 `curl http://localhost:8080`），流量经内嵌 GOST 转发到目标，统计会回流到 D1（管理面板节点统计或 `GET /api/admin/nodes/1/stats` 可见）。

## 部署

> 完整生产部署指南（Fork 部署、Workers Builds、面板初始化、节点机部署、运维与排障）见 **[docs/deployment.md](docs/deployment.md)**。以下为最小 runbook。

### 控制面（Cloudflare）

推荐：**Fork 本仓库**后在 Cloudflare Dashboard 用 Workers Builds 连接你的 fork（自动创建 D1，无需填任何资源 ID；构建设置见[部署指南 §3.2](docs/deployment.md)），再配 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 两个 secret 即可。CLI 手动部署：

```bash
bunx wrangler secret put ADMIN_USERNAME
bunx wrangler secret put ADMIN_PASSWORD
bun run build:web                           # Worker Assets 托管 apps/web/dist
bunx wrangler deploy                        # 首次部署自动创建 D1（自动资源供给，无需 database_id）
bun run db:migrate
```

CI：`deploy-server.yml`（手动触发或 v* tag，需 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets）；`check.yml`（lint + 类型检查 + agent Go vet/test + 前端构建）。

### 节点机

```bash
docker compose up -d   # 单容器 tyz-app（镜像 ghcr.io/laoshan-tech/tyz-node，host 网络，GOST 内嵌）
```

节点机 `.env`（参考 `apps/agent/.env.example`）：`CONTROL_PLANE_URL`、`NODE_TOKEN` 必填。TLS 传输的自动证书持久化在容器卷 `tyz-data` 中，重启后证书保持不变。

## 说明

- 配置下发优先走 WebSocket 长连接（`GET /api/agent/ws`）：管理端写操作实时推送 `config_changed`，agent 立即拉取（304/200 去重）；WS 在 60 秒内断连 3 次自动降级为 HTTP 轮询（默认 10s，`POLL_INTERVAL_MS` 可调），降级期间每 60 秒探测重连（`WS_PROBE_INTERVAL_MS` 可调），成功后自动切回推送模式；`WS_ENABLED=false` 可强制纯轮询。统计默认 60s 批量上报（`STATS_FLUSH_INTERVAL_MS`）。
- agent 进程内按对象 diff 热更新 GOST（services/chains/limiters 走 go-gost registry），未变化的服务不会被重启；最近一次应用的配置持久化在 `last-config.json`（容器内 `/var/lib/tyz`，随卷保存），控制面不可达时重启 agent 也能先按缓存恢复隧道，恢复后无变化仅一次 304 对齐。
- 历史统计保留 30 天，由 Worker Cron 每日清理。
