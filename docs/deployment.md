# TYZ 生产部署指南

本指南覆盖将 TYZ 平台部署到生产的完整流程：

- **控制面**（`apps/server`，Cloudflare Worker + D1 + Durable Object）：通过 **Workers Builds** 接入 Git 仓库——一次性配置后，**日常发布 = `git push`**；
- **管理面板**（`apps/web`）：随控制面一起部署（构建产物由 Worker Assets 托管，无需单独部署）;
- **节点机 agent**（`apps/agent`，Go 单二进制、内嵌 GOST 运行时）：每台中继机器一个容器（host 网络）。

仓库对公共部署友好：`wrangler.jsonc` **不携带任何账户相关的资源 ID**（D1 由 wrangler 自动资源供给创建并按名称保持绑定），secrets 只需**管理员用户名 + 密码**两个。

首次部署路线图：

```
第 1 步  部署控制面                         两选一：Fork 后接入（推荐）/ 直连原仓库 + 2 个 secrets
第 2 步  管理面板初始化                     节点 / 隧道 / 规则 / 用户 / 套餐
第 3 步  节点机部署 agent                   docker compose up -d（每台节点机）
```

---

## 1. 部署拓扑

```
┌────────────────────────── Cloudflare ──────────────────────────┐
│  Worker: tyz-server (Hono)                                     │
│   ├─ /api/admin/* 管理面板 API + 静态托管 (React SPA)             │
│   ├─ /api/agent/* 节点 API（Bearer NODE_TOKEN 认证）              │
│   │            /api/agent/ws WebSocket 推送（NodePushDO）          │
│   ├─ D1: relay_nodes / tunnels / chains / relay_rules /         │
│   │          node_configs / gost_stats / traffic_hourly ...      │
│   └─ Cron: 每日 03:00 UTC（数据清理 / 配额扫描 / TLS 续期）          │
└───────────────▲─────────────────────────────▲──────────────────┘
        WS 推送 + 版本化拉取 GET /api/agent/config │ POST /api/agent/stats（批量统计）
                │ (config_changed → 304 / 200)  │
┌───────────────┴───────────────────────────────┴────────────────┐
│  节点机 ×N（单容器，host 网络）                                     │
│  tyz-agent（Go，内嵌 GOST 运行时）                                │
│   ├─ 配置按对象 diff 热更新（进程内 registry）                      │
│   └─ observer 统计 ──► 缓冲 ──► 批量上报                          │
└─────────────────────────────────────────────────────────────────┘
```

部署单元与职责：

| 单元 | 位置 | 职责 |
|---|---|---|
| Worker `tyz-server` | Cloudflare 边缘 | 面板 API + SPA 托管、agent 配置下发（WS 推送优先）、统计接收、配额/续期巡检 |
| D1 数据库 `tyz` | Cloudflare | 全部业务数据（含计费台账 `traffic_hourly`，永不清理） |
| `NodePushDO`（Durable Object） | 随 Worker | 每节点一个实例，WebSocket 休眠推送 |
| agent 容器 | 每台节点机 | 内嵌 GOST 数据面：监听入口端口、转发/中继流量、执行限速与配额 |

---

## 2. 前置条件

### 2.1 账号与本地工具

| 项 | 要求 |
|---|---|
| Cloudflare 账号 | 免费计划即可运行（D1 / DO / Workers Builds 均可用）；生产环境建议 Workers Paid，避免免费计划的每日请求/构建额度限制 |
| 本机 | `git`、Bun ≥ 1.2（仓库 devDependency 里的 wrangler 4 通过 `bunx` 使用） |
| 节点机 | Linux x86_64 或 arm64，Docker Engine + compose 插件 |
| 仓库 | 已推送到 GitHub（Workers Builds 从仓库拉取构建；`bun.lock` 已入库，CI 安装走 frozen 模式） |

### 2.2 网络与端口规划

| 方向 | 端口 | 用途 |
|---|---|---|
| 节点机 → 控制面域名 | 443（出站，HTTPS/WSS） | agent 拉配置、WS 长连接、上报统计 |
| 节点机 ↔ 节点机 | 隧道链路端口（见下） | relay 链路 / raw 模式出口端口 |
| 客户端 → 入口节点 | 各规则 `listen_port` | 用户接入 |
| 管理员 → 控制面域名 | 443 | 管理面板 |

端口自动分配：节点的 `ports` 字段是一个区间（如 `16800-16999`）。创建链路/规则时端口填 `0` 会按确定性公式从该区间分配，**两端独立计算也能得到同一个值**：

- relay 出口端口：`start + (chain_id + node_id) % 范围宽度`
- raw 模式出口端口：`start + (rule_id × 31 + node_id) % 范围宽度`

规划建议：每台节点的区间互不重叠即可完全避免自动分配冲突；区间重叠时自动分配可能撞端口（面板健康页会显示 `apply_failed`），处置方式是给该链路/规则显式指定端口。

---

## 3. 控制面部署

### 3.1 部署通道选择

| 通道 | 适合 | 见 |
|---|---|---|
| **Fork 后接入 Workers Builds**（推荐） | 个人部署者：保留完整 monorepo 副本，可改代码、可 Sync fork 跟进上游更新 | 3.2 |
| **直连原仓库接入 Workers Builds** | 不改代码的自部署 / 维护者自用生产 | 3.3 |

> **为什么不提供 Deploy to Cloudflare 按钮**：实测按钮流程会把仓库克隆成一个**独立的新仓库（不是 GitHub fork）**，后续无法用 Sync fork 跟进上游；且按钮 URL 指向子目录（monorepo 的 Worker 在 `apps/server`）时，克隆出的仓库**只包含该子目录**——`packages/shared` 等 workspace 依赖与前端源码全部丢失，`bun install` 直接报 `Workspace dependency "@tyz/shared" not found`。对 monorepo 不可用，故本项目以 Fork 路径为主。

### 3.2 Fork 后部署（推荐给个人部署者）

适合想长期运行自己的副本、改代码或跟随上游更新的部署者：**Fork → 按需改配置 → Dashboard 连自己的 fork**。

**① Fork 仓库**：GitHub 仓库页右上角 **Fork**（保留默认分支 `master`）。

**② 按需修改自己副本里的配置**（全部可选，不改也能直接部署）：

| 想改什么 | 改哪里 | 说明 |
|---|---|---|
| Worker 名 | `apps/server/wrangler.jsonc` 的 `name`（默认 `tyz-server`） | Dashboard 里创建的 Worker 名必须与它一致（见 3.3 的告警） |
| D1 数据库名 | `apps/server/wrangler.jsonc` 的 `database_name`（默认 `tyz`） | 首次部署自动创建同名数据库；不需要填任何资源 ID |
| 面板标题等 | `apps/web/` 源码 | 改完随下次部署自动生效 |

**③ 接入 Workers Builds**：**Workers & Pages → Create → Worker → 连接 Git 仓库**，选择**你 fork 的仓库**与 `master` 分支，构建设置按 3.3 的表格配置。

**④ 填 secrets**（见 3.4）：`ADMIN_USERNAME` + `ADMIN_PASSWORD` 两个即可。

**⑤ 触发部署**：连接保存后即触发首次构建部署。默认 Deploy command 不含迁移，首次部署完成后本地执行一次：

```bash
git clone https://github.com/<你的账户>/tyz-node && cd tyz-node/apps/server
bunx wrangler login     # OAuth 授权
bunx wrangler d1 migrations apply DB --remote
```

**⑥ 跟进上游更新**：GitHub fork 页面点 **Sync fork**（或 `git pull upstream master && git push`）→ push 自动触发重新部署；若上游发布包含新的 `migrations/*.sql`，按 3.7 在本地补跑一次迁移。

部署完成后进入第 4 节初始化面板。

> 建议：在 fork 的 **Settings → Actions** 中禁用 `deploy-server.yml`（fork 里没有 `CLOUDFLARE_*` secrets，跑了也会失败，还可能与 Workers Builds 形成双部署通道）。

### 3.3 手动接入 Workers Builds（直连原仓库）

Workers Builds 的行为：push 到生产分支 → 跑**构建命令**（可选）→ 跑**部署命令**（默认 `npx wrangler deploy`）。**构建/部署命令只能在 Dashboard 配置，`wrangler.jsonc` 里的 `[build]` 块对 CI 不生效**。

在 Cloudflare Dashboard：**Workers & Pages → Create → Worker**，选择**连接 Git 仓库**（而非 Hello World 模板），选择本仓库与生产分支 `master`。

> ⚠️ **Worker 名字必须与 `wrangler.jsonc` 的 `name` 一致：`tyz-server`**。不一致是接入失败的常见原因（构建报错找不到/名字冲突）。

然后在 Worker 的 **Settings → Build** 按下表配置：

| 设置项 | 值 | 说明 |
|---|---|---|
| Root directory | `apps/server` | monorepo 关键设置：wrangler.jsonc 所在目录，也是构建/部署命令的工作目录 |
| Build command | `cd ../.. && bun install && bun run --filter @tyz/web build` | 回到仓库根安装 workspace 依赖，再构建面板到 `apps/web/dist`（Worker Assets 托管该目录） |
| Deploy command | 默认（`npx wrangler deploy`） | 手动接入推荐默认：首次部署自动创建 D1（见 3.7）。要连迁移一起自动化可改 `npm run deploy`（需 token 有 D1 权限，见 3.7） |
| Build 变量 | `SKIP_DEPENDENCY_INSTALL=1` | **必须**：禁用自动依赖安装——默认安装会在 `apps/server` 子目录跑 npm，遇到 `workspace:*` 协议会直接报错。依赖安装已折叠进上面的 Build command |
| 非生产分支构建 | 保持关闭 | 本 Worker 含 Durable Object，**不生成预览 URL**，预览版上传（`wrangler versions upload`）没有意义，徒增版本噪音 |

其他事实（无需操作，知道即可）：

- 构建镜像**预装 Bun 1.2.15**（可用构建变量 `BUN_VERSION` 覆盖版本），`bun install` / `bun run` 直接可用；`CI=true` 环境下 bun 默认 frozen-lockfile，与已入库的 `bun.lock` 匹配。
- 首次部署会自动生效 `wrangler.jsonc` 里的其余声明：Durable Object 绑定（`NodePushDO`，SQLite 类，迁移标签 `v2_node_push_do`）、每日 Cron（`0 3 * * *`，03:00 UTC）、Assets 绑定与 observability；并**自动创建 D1 数据库**（自动资源供给，见 3.7）。
- **不建议配置 build watch paths**：默认每次 push 都构建（本机构建很快）；若配置了监听路径而漏掉根目录 `bun.lock` / `package.json`，依赖变更提交将不触发部署。

### 3.4 配置 secrets（必填仅 2 个）

Worker → **Settings → Variables and Secrets → Add**，类型选 **Secret**（或本地 `bunx wrangler secret put <NAME>`，效果相同）：

| Secret | 必填 | 值 |
|---|---|---|
| `ADMIN_USERNAME` | ✅ | 管理员用户名，如 `admin` |
| `ADMIN_PASSWORD` | ✅ | 管理员登录密码（明文存于 Worker secret，仅服务端可见，登录时恒时比对） |

可选 secrets（一般不需要）：

| Secret | 作用 | 未设置时的行为 |
|---|---|---|
| `SESSION_SECRET` | 会话 cookie 的 HMAC 密钥 | 由管理员凭据派生——改密码会使所有已登录会话失效一次 |
| `TOKEN_SALT` | 节点 token 哈希加盐 | 用无盐哈希（节点 token 本身是 128 位随机数，无盐已足够安全）。**一旦设置不可再更改/移除**，否则全部节点 token 立即失效 |
| `ADMIN_PASSWORD_SHA256` | 旧式登录（预哈希密码），需与 `TOKEN_SALT` 配对 | 仅当 `ADMIN_PASSWORD` 未设置时生效，供存量部署平滑保留；新部署直接用 `ADMIN_PASSWORD` |

### 3.5 绑定域名（推荐）

- 默认可用 `https://tyz-server.<你的子域>.workers.dev`。注意 workers.dev 在部分地区/线路可达性不稳，而**节点机必须稳定访问控制面**（WS 长连接 + 配置拉取），隧道类业务建议绑定自定义域名。
- 绑定方式：Worker → **Settings → Domains & Routes → Add → Custom domain**，域名需是本账号 Cloudflare Zone 内的 DNS 记录（自动签发边缘证书，无需自己管 TLS）。
- 绑定自定义域名后，可选在 `wrangler.jsonc` 加 `"workers_dev": false` 关闭 workers.dev 入口，收敛暴露面。

下文用 `https://tyz.example.com` 代指控制面地址。

### 3.6 触发并验证首次部署

```bash
git push origin master
```

在 Worker → **Deployments / Builds** 页面观察构建日志。首次部署时 wrangler 会自动创建 D1 数据库 `tyz`（见 3.7）。

**默认 Deploy command 只部署不迁移**，首次部署完成后需本地执行一次（若 Deploy command 用了 `npm run deploy` 则已包含，跳过）：

```bash
bunx wrangler login     # 首次需 OAuth 授权
cd apps/server && bunx wrangler d1 migrations apply DB --remote
```

验证：

```bash
curl https://tyz.example.com/api/healthz        # → {"ok":true}
```

浏览器打开 `https://tyz.example.com/`，用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录管理面板。

### 3.7 D1 自动供给与迁移策略

**自动供给（无需关心 database_id）**：`wrangler.jsonc` 的 D1 绑定故意不写 `database_id`（依赖 wrangler ≥ 4.45 的自动资源供给）。首次 `wrangler deploy` 会在账户上创建 `database_name` 声明的数据库（默认 `tyz`，已存在同名则直接按名称关联），此后每次部署都按名称维持绑定——**仓库里永远不出现账户相关的 ID**，公共仓库与多人部署互不干扰。本地 `wrangler dev` 也会自动创建本地库。

**迁移策略（二选一）**：

- **默认（Deploy command 为默认的 `npx wrangler deploy`，不含迁移）**：发布包含新的 `migrations/*.sql` 时，在本地执行一次：

  ```bash
  bunx wrangler d1 migrations apply DB --remote
  ```

- **全自动**：把 Deploy command 改为 `npm run deploy`（即 `apps/server/package.json` 里的 `wrangler deploy && npm run db:migrate`）。顺序是**先部署后迁移**：首次部署时数据库由部署动作创建，迁移必须在它之后才能执行；日常发布保持迁移增量向后兼容（加表/加列），部署与迁移之间几秒的窗口不影响在线版本。前提：到 **My Profile → API Tokens** 给 Workers Builds 所用的 token 追加 **D1:Edit**（自动创建的 token 默认不含 D1 编辑权限，不加会报 403）。

### 3.8 与仓库自带 GitHub Actions 的关系

- `deploy-server.yml`（手动触发 / `v*` tag）与 Workers Builds 日常 push 不冲突；但为避免双部署通道造成误操作（比如打 tag 时两边同时部署），**接入 Workers Builds 后建议在仓库 Settings → Actions 中禁用该 workflow**（`.github/workflows/disabled` 或直接删除）。
- `check.yml`（lint + 类型检查 + agent Go 测试 + 前端构建）与部署无关，保留。

### 3.9 日常发布

此后控制面的全部发布就是：

```bash
git push origin master
```

发布前本地（或依赖 `check.yml`）确认：`bun run lint && bun run type-check && go vet ./... && go test ./...`（agent 目录）。

---

## 4. 管理面板初始化

按依赖顺序配置业务数据。所有写操作都会实时重算受影响节点的配置并经 WS 推送到在线 agent，**无需重启任何节点**。

### 4.1 节点（Nodes）

创建节点，关键字段：

| 字段 | 说明 |
|---|---|
| 名称 | 标识用 |
| address | 节点机**公网 IP 或可解析主机名，不含端口**（链路拨号地址 = address + 链路行端口；admission 白名单也取它的 host） |
| ports | 端口区间，如 `16800-16999`（自动分配用，见 2.2） |
| transport | 默认传输 |

创建成功后**节点 Token 仅显示一次**，立即复制保存——它就是该节点机 `.env` 里的 `NODE_TOKEN`。泄露/遗忘都走「轮换 Token」（旧 token 立即失效，需同步更新节点机 `.env` 并重启容器）。

### 4.2 端点（Endpoints，可选）

预存命名转发目标（host + port）。规则引用端点时，端点地址变更会自动同步所有引用它的规则并重算配置；仍被引用的端点无法删除（409）。也可以不用端点，建规则时手填目标地址。

### 4.3 隧道与链路（Tunnels / Chains）

支持的形态与约束（写入时由 API 校验，聚合时再归一化兜底）：

| 形态 | chain 组成 | 说明 |
|---|---|---|
| 单节点直转 | 1 条 `in` 链 | 流量直接转发到目标地址 |
| 双节点中继 | 1 条 `in` + 1 条 `out` 链 | 默认 `relay` 模式：N 条入口规则共享出口的一个 relay 监听端口 |
| 双节点裸转 | 1 条 `in` + 1 条 `out` 链 | `forward_mode=raw`：每规则独立端口对，线路上无 relay 协议头（抗审查形态） |

- 链路行（chain）字段：节点、端口（`0` = 自动分配，见 2.2 公式）、传输（tcp/ws/grpc/tls/mwss…）、`index`（多跳排序）。
- **链路 TLS**（`tls_enabled`）仅支持双节点 relay 形态且出口传输为 `grpc` 或 `tls`：mTLS（平台签发证书）+ 每隧道 relay 凭据（自动生成）+ admission 白名单（自动收集入口节点 IP）三层认证；grpc 传输自动加 `/grpc` path 与 h2 ALPN 伪装。**前提：先在设置页配置 `tls_domain`（见 4.6），否则 TLS 隧道聚合直接报错。**
- `ingress_display_address` 是给用户看的展示地址，不参与任何配置生成。

### 4.4 规则（Rules）

| 字段 | 说明 |
|---|---|
| 隧道 | 必选；不挂隧道的规则不会出现在任何节点配置里 |
| 监听端口（listen_port） | 入口节点对外监听端口 |
| 出口端口（exit_port） | 仅 raw 模式；`0` = 自动分配（见 2.2 公式） |
| 目标 | 选择已存端点或手填 host:port |
| limit | 限速/限连 JSON（流量、请求速率、连接数，支持服务级与按 IP）——只在入口侧生效，避免双腿重复计数 |
| 所属用户 | 空 = 管理员规则（永不配额限制）；指定用户则受套餐配额硬停控制 |

### 4.5 套餐与用户（Packages / Users）

- 套餐：流量额度 / 周期天数 / 规则数上限 / 可用节点与隧道范围（空 = 不限）。
- 用户开通/切换/续订套餐 = 激活一条 `user_packages` 订阅记录。**切换或续订会重置用量窗口：历史已用流量在台账与 agent 计数器上同时清零（换购清零语义）**。
- 配额执行：服务端按计费台账（`traffic_hourly`，含线路倍率 `rate`）计算剩余量随配置下发；agent 端 GOST 配额对象执行硬停（配额只挡新连接，不断已有连接）。用户停用/无订阅/到期/耗尽时，其规则在聚合阶段被整体剔除（面板显示配额停用原因）。

### 4.6 链路 TLS 域名（tls_domain）

要让隧道启用链路 TLS（`tls_enabled`），必须先在**设置页 → TLS 域名**配置一个平台级 `tls_domain`，否则 TLS 隧道在聚合阶段直接报错。语义与运维要点：

- 它是**伪装用的 SNI/证书域名**（平台自签 CA 给链路签发证书，SAN/CN 用它；grpc 传输时也作为 `:authority` 伪装），**不需要真实 DNS 解析、不需要指向任何节点**——选一个你名下看起来正常的域名即可；
- 一个平台只有一个 `tls_domain`，修改它会自动作废并重签 server 证书，受影响节点重算配置并推送；
- 证书生命周期全自动：首次聚合懒生成，每日 Cron 在到期前 30 天自动续期（CA 不足 90 天时整套重发）；
- 设置页 / `GET /api/admin/tls/status` 只展示到期元数据，**私钥与证书材料仅经 agent 配置通道下发**，不出现在面板与审计中。

### 4.7 验证数据面

节点部署完成（第 5 节）后：

1. 面板 → 节点页：查看各节点服务健康（running / failed / apply_failed）与 WS 在线状态；
2. 从客户端向某规则的 `listen_port` 发流量（如 `curl http://<入口节点IP>:<listen_port>/`），应得到目标端点响应；
3. 稍候（统计默认 60s 批量上报）在面板节点统计 / 用户用量中看到流量回落。

---

## 5. 节点机部署（agent）

### 5.1 要求

- Linux x86_64 / arm64；
- 出站可达控制面域名 443；
- 节点间链路端口互通、客户端可达 `listen_port`；
- GOST 运行时已内嵌在 agent 二进制中，**无需安装任何其他东西**。

### 5.2 方式 A：Docker Compose（推荐）

在节点机上创建部署目录并写入 `.env`（完整变量表见附录 A；真实环境变量优先于 `.env`）：

```bash
mkdir -p /opt/tyz && cd /opt/tyz
cat > .env <<'EOF'
CONTROL_PLANE_URL=https://tyz.example.com
NODE_TOKEN=<面板创建该节点时显示的 token>
EOF
chmod 600 .env
```

写入 `docker-compose.yml`：

```yaml
services:
  app:
    image: ghcr.io/laoshan-tech/tyz-node:latest   # 或固定版本 tag，见下
    container_name: tyz-app
    restart: unless-stopped
    network_mode: host                            # 必须：GOST 直接监听宿主端口
    volumes:
      - ./.env:/var/lib/tyz/.env:ro
      # 持久化：离线自举缓存 last-config.json、配额计数器 quota-store.json、
      # 链路 TLS 证书 certs/、自动生成的默认证书 $HOME/.gost
      - tyz-data:/var/lib/tyz

volumes:
  tyz-data:
```

启动：

```bash
docker compose up -d
```

镜像来源二选一：

- **GHCR（CI 自动构建，amd64 + arm64）**：`ghcr.io/laoshan-tech/tyz-node`。生产建议固定版本 tag（发布页的 `vX.Y.Z`）而非 `latest`，升级节奏可控；
- **本地构建**：在仓库根执行 `docker build -f apps/agent/Dockerfile -t tyz-node:local .`（注意**构建上下文是仓库根**），导入节点机使用。

### 5.3 方式 B：裸机二进制 + systemd（备选）

构建与安装（在任何有 Go ≥ 1.26 的机器上交叉编译，或直接在节点机本地构建）：

```bash
cd apps/agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o tyz-agent .
# arm64 机器改 GOARCH=arm64

scp tyz-agent root@<节点机>:/usr/local/bin/
```

节点机上：

```bash
# 专用系统用户与工作目录（持久化文件都落在这里）
useradd --system --home /var/lib/tyz --create-home --shell /usr/sbin/nologin tyz
install -m 600 /dev/null /etc/tyz-agent.env
cat > /etc/tyz-agent.env <<'EOF'
CONTROL_PLANE_URL=https://tyz.example.com
NODE_TOKEN=<该节点 token>
EOF
chown tyz /etc/tyz-agent.env
```

`/etc/systemd/system/tyz-agent.service`：

```ini
[Unit]
Description=TYZ node agent (embedded GOST)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tyz
Group=tyz
WorkingDirectory=/var/lib/tyz
EnvironmentFile=/etc/tyz-agent.env
ExecStart=/usr/local/bin/tyz-agent
Restart=always
RestartSec=5
# SIGTERM 触发优雅停机：先 flush 最终统计（内部上限 10s）
TimeoutStopSec=15
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now tyz-agent
```

### 5.4 持久化数据（务必保留）

工作目录（容器内 `/var/lib/tyz`）下的运行时状态，丢失后果各不相同：

| 文件/目录 | 作用 | 丢失后果 |
|---|---|---|
| `last-config.json` | 最近一次应用的配置（离线自举） | 控制面不可达时重启无法恢复隧道；恢复后也从零全量拉取 |
| `quota-store.json` | GOST 配额计数器（10s 落盘） | 配额计数归零，可能超发已用额度 |
| `certs/` | 平台签发的链路 TLS 证书/私钥 | 重启后由下次配置下发自动重写，无实际损失（链路会短暂重建） |
| `$HOME/.gost` | 自动生成的默认 TLS 证书 | 重新生成，自签场景对端需重新信任 |

### 5.5 验证

```bash
# 健康检查（HOST 默认 127.0.0.1，host 网络下从节点机本机探测）
curl http://127.0.0.1:18090/healthz    # → {"status":"ok",...}

# 日志（agent 与内嵌 GOST 都打 stdout）
docker logs -f tyz-app                 # 方式 A
journalctl -u tyz-agent -f             # 方式 B
```

正常启动日志：加载 env → 连接控制面 WS → 拉取配置 → 逐个 apply 服务。之后按 4.6 验证数据面与统计回流。

### 5.6 常用操作

```bash
docker compose pull && docker compose up -d   # 升级（方式 A）
docker logs --since 10m tyz-app               # 近 10 分钟日志
docker restart tyz-app                        # 重启（会重建全部 GOST 服务，断开存量连接）
```

> 面板上的「重启规则」按钮是更精细的操作：只重建该规则对应的 GOST 服务（raw 模式下入口/出口两端的同名服务都会重建；不服务该对象的节点自动忽略），不影响其他规则，且**不带任何配置变更**。日常排障优先用它。

---

## 6. 升级

### 6.1 控制面

`git push origin master`（含新迁移时先本地 `d1 migrations apply DB --remote`，见 3.7）。部署原子生效，无需停机。

### 6.2 agent

更新镜像 tag / 替换二进制后重启。重启语义：

- 启动时先重放 `last-config.json` 恢复全部隧道（控制面不可达也能恢复），再对齐版本（无变化则一次 304）；
- GOST 服务全部重建，**该节点存量连接会被断开**（通常会话层自动重连）；
- 配置热更新（不重启进程的常规变更）不受影响：chains/limiters/quotas 热切换不断连接，只有 service 本身变更才会断该规则的连接。

建议顺序：先升控制面、观察稳定后再逐台升 agent（agent 拉取的配置 payload 由控制面生成）。

---

## 7. 日常运维

### 7.1 日志

- agent 仅输出到 stdout（`docker logs` / `journalctl`）；健康快照只在 failed ↔ recovered 状态翻转时打日志，平时安静。
- 控制面：Worker → **Observability → Logs**（`observability.enabled` 已开）。

### 7.2 数据备份

D1 是唯一持久层，其中 **`traffic_hourly` 是计费台账且永不清理**——定期备份是硬要求：

```bash
cd apps/server
bunx wrangler d1 export tyz --remote --output=backup-$(date +%F).sql
```

建议至少每周一次（配额计算与用户用量全部依赖此表）。

### 7.3 定时巡检（每日 03:00 UTC Cron，自动）

- 清理：`gost_stats` > 30 天、`audit_log` > 180 天、`service_metrics_hourly` > 7 天（`traffic_hourly` 永不清理）；
- 配额扫描：订阅过期/额度耗尽/用户停用的规则被硬停（从聚合配置剔除），配置有实际变化的节点会收到推送；
- TLS 续期：30 天内到期的叶子证书自动重签，CA 低于 90 天时整套重发，受影响节点自动重算并推送。

### 7.4 高频手动操作

| 操作 | 位置 | 效果 |
|---|---|---|
| 重启规则 | 规则页 → 重启 | 只重建该规则的 GOST 服务（两端），断该规则连接，不改配置 |
| 重算配置 | 节点页 → 重算 | 强制重聚合该节点配置并推送（排障用） |
| 轮换节点 token | 节点页 → 轮换 | **旧 token 立即失效**；新 token 仅显示一次，需同步更新节点机 `.env` 并重启容器 |
| 用户换购/续订 | 用户页 → 订阅 | 用量窗口重置（清零） |

### 7.5 监控建议

- 对 `https://<域名>/api/healthz` 与各节点机 `127.0.0.1:18090/healthz`（需本机探针）做拨测；
- 面板节点页可看每服务健康与 24h 连接峰值，用户页可看配额停用原因；
- agent 掉线时控制面不会告警（推送只达在线 socket，重连后补拉），节点健康页是人工观察点。

---

## 8. 安全清单

- [ ] secrets（`ADMIN_USERNAME` / `ADMIN_PASSWORD`，及可选的 `SESSION_SECRET` / `TOKEN_SALT`）只存 Worker secret，不进仓库/CI 变量
- [ ] 若启用了可选 `SESSION_SECRET` / `TOKEN_SALT`，妥善备份；`TOKEN_SALT` 启用后不可再更改或移除（会使全部节点 token 失效）
- [ ] 管理员密码为强密码（单账户体系，无 2FA，必要时在前面加 Cloudflare Access）
- [ ] 节点 token 泄露立即走「轮换」（旧 token 立即失效）
- [ ] 节点机防火墙只放行：客户端接入端口、链路端口、出站 443；`18090` 健康口保持 `127.0.0.1`
- [ ] `GOST_API_ADDR` 仅排障临时开启（调试 API 可读写运行时配置），用完即关
- [ ] 自定义域名绑定后考虑 `workers_dev: false` 收敛入口
- [ ] D1 定期 `export` 备份（计费数据）

敏感数据流向（已由代码保证，供审计对照）：

- 节点 token 只存盐化 SHA-256，原文仅在创建/轮换时显示一次；
- 链路 TLS 的 PEM 与 relay 凭据**只**经 agent 配置通道下发，从不出现在面板响应与审计日志中；
- `audit_log` 不记录任何 secret（token 轮换只记录动作不记录值）。

---

## 9. 故障排查

### Workers Builds（控制面）

| 症状 | 原因 | 处置 |
|---|---|---|
| 构建报 Worker 名不匹配 / 找不到 wrangler 配置 | Dashboard 的 Worker 名 ≠ `tyz-server`，或 Root directory 不对 | 名字改为 `tyz-server`；Root directory 设为 `apps/server`（Settings → Build） |
| 构建时 npm 安装报 `workspace:*` 相关错误 | 没设 `SKIP_DEPENDENCY_INSTALL=1`，自动安装跑在了子目录 | 加该构建变量；确认 Build command 里自己 `bun install` |
| 部署命令里跑迁移报 403/权限错误 | Workers Builds 的 token 无 D1:Edit | 见 3.7：本地跑迁移，或给 token 补 D1:Edit |
| push 了但没触发构建 | 配置了 build watch paths 且路径不含改动文件 | 删掉 watch paths 配置（见 3.3） |

### agent / 节点机

| 症状 | 原因 | 处置 |
|---|---|---|
| 容器启动即退出，日志有 `fatal:` | `CONTROL_PLANE_URL`/`NODE_TOKEN` 缺失，或某个 `*_MS` 变量非正整数 | 修正 `.env` 后 `docker compose up -d` |
| 面板显示节点不在线 | token 错误 / 出站 443 不通 / 控制面域名不可达 | 节点机 `curl https://tyz.example.com/api/healthz`；核对 token；确认域名解析 |
| 服务健康显示 `apply_failed` | 端口冲突（自动分配撞号或与宿主服务冲突） | 给该链路/规则显式指定端口；或调整节点 `ports` 区间消除重叠 |
| 改了配置但节点没生效 | WS 断连窗口内推送丢失 | agent 重连时立即补拉；5 分钟安全网轮询兜底。仍不行用节点页「重算」 |
| TLS 隧道创建后面板报聚合错误 | 未设置 `tls_domain` | 设置页配置平台 TLS 域名（见 4.6） |
| 对 TLS 端口发明文被立即断开 | 预期行为（TLS 监听拒绝非 TLS 流量） | 正常，无需处理 |
| 重启 agent 后隧道全断又立即恢复 | 正常：进程内 GOST 随重启重建 | — |

### 控制面 / 面板

| 症状 | 原因 | 处置 |
|---|---|---|
| 无法登录面板 | `ADMIN_PASSWORD` 未设置或输错（旧式部署则是哈希与 `TOKEN_SALT` 不配对） | 核对 secrets；新部署直接设 `ADMIN_PASSWORD` 明文 |
| 能登录但面板数据报错（表不存在） | 首次部署后迁移未执行 | 按 3.6 执行 `d1 migrations apply DB --remote` |
| 登录态频繁丢失 | 更改了 `SESSION_SECRET`（使所有会话失效，一次性） | 重新登录即可 |
| 统计/用量不更新 | agent 掉线或统计缓冲未到 flush 间隔 | 看节点在线状态；默认 60s 批量上报，稍等 |

---

## 附录

### A. agent 环境变量全表

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONTROL_PLANE_URL` | **必填** | 控制面地址，如 `https://tyz.example.com`（末尾 `/` 自动去除） |
| `NODE_TOKEN` | **必填** | 节点 token（面板创建节点时显示） |
| `HOST` | `127.0.0.1` | 健康服务监听地址（远程探测才改 `0.0.0.0`，注意暴露面） |
| `PORT` | `18090` | 健康服务端口（agent 全部 HTTP 面就是 `/healthz`） |
| `POLL_INTERVAL_MS` | `10000` | HTTP 轮询间隔（WS 健康时仅作 5 分钟安全网，不会按此频率打） |
| `STATS_FLUSH_INTERVAL_MS` | `60000` | 统计批量上报间隔（缓冲上限 1000，退出时 flush） |
| `WS_ENABLED` | `true` | `false` = 强制纯 HTTP 轮询 |
| `WS_PROBE_INTERVAL_MS` | `60000` | 降级轮询期间的 WS 重连探测间隔 |
| `WS_PING_INTERVAL_MS` | `60000` | WS 心跳（内部钳制 < 90s，适配边缘空闲超时） |
| `GOST_API_ADDR` | 空 | 调试用：暴露内嵌 GOST Web API（如 `127.0.0.1:18080`，路径前缀 `/api`），平时保持关闭 |
| `DEBUG` | 空 | `true` = 调试日志 |

`.env` 从**工作目录**加载，真实环境变量优先。

### B. 命名约定（GOST 对象）

`service-{ruleId}`（入口/裸转出口）、`service-t{tunnelId}`（relay 共享出口）、`chain-{tunnelId}`、`node-{nodeId}-t{tunnelId}`、`hop-{tunnelId}-{index}`、`quota-user-{userId}`、`admission-t{tunnelId}`。跨版本 diff-apply 依赖这些确定性名字，不要在生成逻辑外改动。

### C. HTTP 端点清单

控制面：

- `GET /api/healthz` —— 存活探针
- `GET /api/agent/config?version=N`（304/200）、`GET /api/agent/ws`（Bearer token；推送 `config_changed` / `restart_service`，应答 ping→pong）、`POST /api/agent/stats`
- `POST /api/admin/login|logout`、`GET /api/admin/me`、CRUD `/api/admin/nodes|tunnels|chains|rules|users|packages|endpoints`，及 `nodes/:id/{recompute,rotate-token,stats,health,metrics}`、`users/:id/subscribe`、`rules/:id/restart`、`GET /api/admin/audit`、`GET /api/admin/tls/status`、`PUT /api/admin/settings/tls-domain`

agent：`GET /healthz`（仅此一个）。

### D. 参考链接

- Workers Builds 配置：<https://developers.cloudflare.com/workers/ci-cd/builds/configuration/>
- 构建镜像（预装工具）：<https://developers.cloudflare.com/workers/ci-cd/builds/build-image/>
- monorepo 接入：<https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/>
- Wrangler D1（迁移/导出）：<https://developers.cloudflare.com/d1/>
- 本地开发与测试：见仓库 `README.md`、`AGENTS.md`
