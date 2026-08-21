import { Card, Skeleton, Tabs } from "@heroui/react";
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconList,
  IconNetwork,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconServer,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { DashboardSummary } from "@tyz/shared";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { formatTraffic } from "../format";
import { auditActionLabel } from "../labels";
import { cn, Mono, PageHeader, PageShell, StatusChip } from "../ui";

const REFRESH_MS = 60_000;

// 图表色跟随主题语义 token。var() 只能放内联 style（SVG presentation attribute
// 对 var() 的支持跨浏览器不一致，属性里保留 hex 兜底；CSS 级联中内联 style 优先于
// 属性值）。recharts 会把 Area 的 style 同时透传到填充+描边两条 path，填充路径
// 误继承的描边由 index.css 的 .recharts-area-area 规则取消。
const UP_COLOR = "#10b981";
const UP_STROKE = "var(--success)";
const DOWN_COLOR = "#6366f1";
const DOWN_STROKE = "var(--accent)";
const SERIES_STROKES: Record<string, string> = { 上行: UP_STROKE, 下行: DOWN_STROKE };

// ---- Row 1: 状态统计卡 ----

const CARD_TONES = {
  success: "bg-success-soft text-success-soft-foreground",
  warning: "bg-warning-soft text-warning-soft-foreground",
  danger: "bg-danger-soft text-danger-soft-foreground",
} as const;

function StatusCard({
  to,
  tone,
  icon,
  label,
  value,
  hint,
}: {
  to: string;
  tone: keyof typeof CARD_TONES;
  icon: ReactNode;
  label: string;
  value?: number;
  hint?: string;
}) {
  return (
    <Link
      to={to}
      className="group block rounded-md outline-accent focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <Card className="transition-colors group-hover:border-accent">
        <Card.Content className="flex items-center gap-4">
          <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg", CARD_TONES[tone])}>
            {icon}
          </div>
          <div className="min-w-0">
            <p className="text-sm text-muted">{label}</p>
            <p className="text-2xl font-semibold leading-tight tabular-nums">{value === undefined ? "--" : value}</p>
            {hint && <p className="truncate text-xs text-muted">{hint}</p>}
          </div>
        </Card.Content>
      </Card>
    </Link>
  );
}

// ---- Row 2: 流量趋势 ----

type TrafficRange = "24h" | "7d";

interface TrafficTooltipProps {
  active?: boolean;
  label?: string;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
}

function TrafficTooltip({ active, payload, label }: TrafficTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs shadow-md">
      <p className="mb-1 text-muted">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ background: SERIES_STROKES[entry.name ?? ""] ?? entry.color }}
          />
          {entry.name}
          <Mono>{formatTraffic(entry.value ?? 0)}</Mono>
        </p>
      ))}
    </div>
  );
}

function TrafficChartCard() {
  const [range, setRange] = useState<TrafficRange>("24h");
  const hours = range === "24h" ? 24 : 168;
  const query = useQuery({
    queryKey: ["dashboard-traffic", hours],
    queryFn: () => api.dashboardTraffic(hours),
    refetchInterval: REFRESH_MS,
  });

  const data = useMemo(
    () =>
      (query.data?.rows ?? []).map((p) => ({
        ...p,
        label: range === "24h" ? p.hour_ts.slice(11, 16) : p.hour_ts.slice(5, 10),
      })),
    [query.data, range],
  );

  return (
    <Card className="h-full">
      <Card.Header className="pb-2">
        <Card.Title>计费流量趋势</Card.Title>
        <Card.Description>全平台按小时聚合（已含线路倍率），60 秒自动刷新</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Tabs
            aria-label="时间范围"
            selectedKey={range}
            onSelectionChange={(key) => setRange(key as TrafficRange)}
            className="w-fit"
          >
            <Tabs.List>
              <Tabs.Tab id="24h">24 小时</Tabs.Tab>
              <Tabs.Tab id="7d">近 7 天</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: UP_STROKE }} />
              上行
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: DOWN_STROKE }} />
              下行
            </span>
          </div>
        </div>
        {query.isLoading ? (
          <Skeleton className="h-[280px] w-full rounded-md" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="dashUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={UP_COLOR} stopOpacity={0.25} style={{ stopColor: UP_STROKE }} />
                  <stop offset="100%" stopColor={UP_COLOR} stopOpacity={0.02} style={{ stopColor: UP_STROKE }} />
                </linearGradient>
                <linearGradient id="dashDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={DOWN_COLOR} stopOpacity={0.25} style={{ stopColor: DOWN_STROKE }} />
                  <stop offset="100%" stopColor={DOWN_COLOR} stopOpacity={0.02} style={{ stopColor: DOWN_STROKE }} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(128,128,128,0.2)"
                style={{ stroke: "var(--border)" }}
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, style: { fill: "var(--muted)" } }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
              />
              <YAxis
                tick={{ fontSize: 11, style: { fill: "var(--muted)" } }}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => formatTraffic(v)}
              />
              <RTooltip content={<TrafficTooltip />} />
              <Area
                type="monotone"
                dataKey="billed_upload"
                name="上行"
                stroke={UP_COLOR}
                strokeWidth={1.8}
                fill="url(#dashUp)"
                style={{ stroke: UP_STROKE }}
              />
              <Area
                type="monotone"
                dataKey="billed_download"
                name="下行"
                stroke={DOWN_COLOR}
                strokeWidth={1.8}
                fill="url(#dashDown)"
                style={{ stroke: DOWN_STROKE }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card.Content>
    </Card>
  );
}

// ---- Row 2: 节点健康墙 ----

function NodeHealthWall({ nodes, loading }: { nodes: DashboardSummary["nodes_health"] | undefined; loading: boolean }) {
  return (
    <Card className="h-full">
      <Card.Header className="pb-2">
        <Card.Title>节点健康</Card.Title>
        <Card.Description>最新服务快照与 24h 连接峰值</Card.Description>
      </Card.Header>
      <Card.Content>
        {loading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-11 w-full rounded-md" />
            ))}
          </div>
        ) : !nodes || nodes.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">暂无节点</p>
        ) : (
          <div className="flex max-h-[326px] flex-col gap-1 overflow-y-auto">
            {nodes.map((n) => (
              <Link
                key={n.node_id}
                to="/nodes"
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 outline-accent transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <IconServer
                    size={18}
                    stroke={1.7}
                    className={cn(
                      "shrink-0",
                      n.failed > 0 ? "text-danger" : n.services === 0 ? "text-muted" : "text-success",
                    )}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm leading-tight font-medium">{n.name}</p>
                    <p className="text-xs text-muted">24h 峰值 {n.conn_peak_24h} 连接</p>
                  </div>
                </div>
                {n.failed > 0 ? (
                  <StatusChip tone="danger">{n.failed} 异常</StatusChip>
                ) : n.services === 0 ? (
                  <StatusChip tone="default">未上报</StatusChip>
                ) : (
                  <StatusChip tone="success">
                    {n.ready}/{n.services} 就绪
                  </StatusChip>
                )}
              </Link>
            ))}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

// ---- Row 3: 今日流量 / 快捷操作 ----

function TodayTrafficCard({ traffic }: { traffic: DashboardSummary["traffic"] | undefined }) {
  const todayTotal = traffic ? traffic.today.upload + traffic.today.download : undefined;
  const yesterdayTotal = traffic ? traffic.yesterday.upload + traffic.yesterday.download : undefined;
  return (
    <Card className="h-full">
      <Card.Header className="pb-2">
        <Card.Title>今日计费流量</Card.Title>
        <Card.Description>UTC 日聚合，来自小时计费账本</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-2">
        <p className="text-3xl font-semibold tabular-nums">
          {todayTotal === undefined ? "--" : formatTraffic(todayTotal)}
        </p>
        {traffic && (
          <p className="text-sm text-muted">
            上行 <Mono>{formatTraffic(traffic.today.upload)}</Mono> · 下行{" "}
            <Mono>{formatTraffic(traffic.today.download)}</Mono>
          </p>
        )}
        <p className="text-xs text-muted">
          昨日全天 {yesterdayTotal === undefined ? "--" : formatTraffic(yesterdayTotal)}
        </p>
      </Card.Content>
    </Card>
  );
}

const QUICK_ACTIONS = [
  { to: "/nodes?create=1", label: "新建节点", icon: <IconServer size={16} stroke={1.7} /> },
  { to: "/tunnels?create=1", label: "新建隧道", icon: <IconNetwork size={16} stroke={1.7} /> },
  { to: "/rules?create=1", label: "新建规则", icon: <IconArrowsExchange size={16} stroke={1.7} /> },
  { to: "/users?create=1", label: "新建用户", icon: <IconUsers size={16} stroke={1.7} /> },
];

function QuickActionsCard() {
  return (
    <Card className="h-full">
      <Card.Header className="pb-2">
        <Card.Title>快捷操作</Card.Title>
        <Card.Description>直达各模块的新建入口</Card.Description>
      </Card.Header>
      <Card.Content className="grid grid-cols-2 gap-2">
        {QUICK_ACTIONS.map((action) => (
          <Link
            key={action.to}
            to={action.to}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm outline-accent transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {action.icon}
            {action.label}
            <IconPlus size={13} stroke={2} className="ml-auto text-muted" />
          </Link>
        ))}
      </Card.Content>
    </Card>
  );
}

// ---- Row 4: 最近操作 ----

function RecentActivityCard() {
  const auditQuery = useQuery({
    queryKey: ["dashboard-audit"],
    queryFn: () => api.listAudit(8),
    refetchInterval: REFRESH_MS,
  });
  const rows = auditQuery.data?.rows ?? [];

  return (
    <Card>
      <Card.Header className="pb-2">
        <Card.Title>最近操作</Card.Title>
        <Card.Description>
          <Link to="/settings/audit" className="text-accent hover:underline">
            查看全部
          </Link>
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {auditQuery.isLoading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">暂无操作记录</p>
        ) : (
          <div className="flex flex-col">
            {rows.map((r) => {
              const info = auditActionLabel(r.action);
              return (
                <div key={r.id} className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
                  <Mono className="w-[7.5rem] shrink-0 text-muted">{r.ts.slice(5, 16).replace("T", " ")}</Mono>
                  <StatusChip tone={info.tone} title={r.action} className="shrink-0">
                    {info.label}
                  </StatusChip>
                  <span className="min-w-0 flex-1 truncate text-sm">{r.detail || "-"}</span>
                  {r.target_type && (
                    <Mono className="hidden shrink-0 text-muted sm:inline">
                      {r.target_type} #{r.target_id}
                    </Mono>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

// ---- Page ----

export default function DashboardPage() {
  const summaryQuery = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: api.dashboardSummary,
    refetchInterval: REFRESH_MS,
  });
  const summary = summaryQuery.data;
  const abnormalNodes = summary?.nodes_health.filter((n) => n.failed > 0).length;

  return (
    <PageShell>
      <PageHeader
        title="控制台"
        description="平台运行总览"
        action={
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <IconList size={14} stroke={1.7} />
            60 秒自动刷新
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatusCard
          to="/rules?status=running"
          tone="success"
          icon={<IconPlayerPlay size={22} stroke={1.7} />}
          label="规则运行中"
          value={summary?.counts.rules.running}
          hint={summary ? `共 ${summary.counts.rules.total} 条规则` : undefined}
        />
        <StatusCard
          to="/rules?status=paused"
          tone="warning"
          icon={<IconPlayerPause size={22} stroke={1.7} />}
          label="规则已暂停"
          value={summary?.counts.rules.paused}
          hint={summary ? `创建中 ${summary.counts.rules.created} · 错误 ${summary.counts.rules.error}` : undefined}
        />
        <StatusCard
          to="/rules?status=quota_stopped"
          tone="danger"
          icon={<IconAlertTriangle size={22} stroke={1.7} />}
          label="配额停用"
          value={summary?.counts.rules.quota_stopped}
          hint={summary ? `订阅用户 ${summary.counts.users.subscribed} / ${summary.counts.users.total}` : undefined}
        />
        <StatusCard
          to="/nodes"
          tone="danger"
          icon={<IconServer size={22} stroke={1.7} />}
          label="节点异常"
          value={abnormalNodes}
          hint={summary ? `共 ${summary.counts.nodes} 个节点 · ${summary.counts.tunnels} 条隧道` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TrafficChartCard />
        </div>
        <NodeHealthWall nodes={summary?.nodes_health} loading={summaryQuery.isLoading} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TodayTrafficCard traffic={summary?.traffic} />
        <QuickActionsCard />
      </div>

      <RecentActivityCard />
    </PageShell>
  );
}
