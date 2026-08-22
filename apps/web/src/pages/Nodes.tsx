import { Button, Switch, Table, Tooltip, toast } from "@heroui/react";
import {
  IconChartBar,
  IconCheck,
  IconCopy,
  IconKey,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateNodeInput, DashboardSummary, NodeWithMeta } from "@tyz/shared";
import { type FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import { formatTraffic } from "../format";
import { serviceStateLabel } from "../labels";
import {
  DataText,
  emptyState,
  type FormErrors,
  FormFooter,
  FormModal,
  FormShell,
  fail,
  hasErrors,
  IconAction,
  ListToolbar,
  NumberForm,
  PageHeader,
  Pager,
  PageShell,
  SearchInput,
  SideDrawer,
  StatusChip,
  TableError,
  TableLoading,
  TextForm,
  useCrudMutation,
  useFormValues,
} from "../ui";

// ---- Node form ----

interface NodeFormValues {
  name: string;
  address: string;
  display_address: string;
  ports: string;
  level: number;
  traffic_limit: number;
  rate: number;
  is_public: boolean;
  description: string;
}

function nodeFormValues(node: NodeWithMeta | null): NodeFormValues {
  return node
    ? {
        name: node.name,
        address: node.address,
        display_address: node.display_address ?? "",
        ports: node.ports,
        level: node.level,
        traffic_limit: node.traffic_limit,
        rate: node.rate,
        is_public: node.is_public,
        description: node.description ?? "",
      }
    : {
        name: "",
        address: "",
        display_address: "",
        ports: "10000-20000",
        level: 0,
        traffic_limit: 0,
        rate: 1,
        is_public: false,
        description: "",
      };
}

function NodeDialog({
  node,
  opened,
  onClose,
  onCreated,
}: {
  node: NodeWithMeta | null;
  opened: boolean;
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const { save, isPending } = useCrudMutation({
    invalidateKeys: [["nodes"]],
    create: (input: CreateNodeInput) => api.createNode(input),
    update: (id, input: CreateNodeInput) => api.updateNode(id, input),
    onCreated: (result) => onCreated(result.token),
    onClose,
  });

  return (
    <FormModal title={node === null ? "新建节点" : `编辑节点 #${node.id}`} isOpen={opened} onClose={onClose}>
      {opened && (
        <NodeForm
          key={node?.id ?? "create"}
          node={node}
          submitting={isPending}
          onCancel={onClose}
          onSubmit={(input) => save(node?.id ?? null, input)}
        />
      )}
    </FormModal>
  );
}

function NodeForm({
  node,
  onSubmit,
  submitting,
  onCancel,
}: {
  node: NodeWithMeta | null;
  onSubmit: (input: CreateNodeInput) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => nodeFormValues(node));
  const [errors, setErrors] = useState<FormErrors<NodeFormValues>>({});

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<NodeFormValues> = {};
    if (!values.name.trim()) errs.name = "请输入名称";
    if (!values.address.trim()) errs.address = "请输入内网地址";
    if (!/^\d+-\d+$/.test(values.ports.trim())) errs.ports = "格式如 10000-20000";
    setErrors(errs);
    if (hasErrors(errs)) return;

    onSubmit({
      name: values.name,
      address: values.address,
      display_address: values.display_address || undefined,
      ports: values.ports,
      level: values.level,
      traffic_limit: values.traffic_limit,
      rate: values.rate,
      is_public: values.is_public,
      description: values.description || undefined,
    });
  };

  return (
    <FormShell onSubmit={onSubmitForm}>
      <TextForm label="名称" isRequired value={values.name} onChange={(v) => set("name", v)} error={errors.name} />
      <TextForm
        label="内网地址"
        isRequired
        hint="节点间通信地址，如 10.0.0.1"
        value={values.address}
        onChange={(v) => set("address", v)}
        error={errors.address}
      />
      <TextForm
        label="对外地址"
        hint="可选，客户端连接地址"
        value={values.display_address}
        onChange={(v) => set("display_address", v)}
      />
      <TextForm
        label="端口段"
        placeholder="10000-20000"
        value={values.ports}
        onChange={(v) => set("ports", v)}
        error={errors.ports}
      />
      <div className="grid grid-cols-2 gap-3">
        <NumberForm label="级别" minValue={0} value={values.level} onChange={(v) => set("level", v ?? 0)} />
        <NumberForm
          label="流量上限"
          minValue={0}
          value={values.traffic_limit}
          onChange={(v) => set("traffic_limit", v ?? 0)}
        />
        <NumberForm
          label="计费倍率"
          minValue={0}
          maxValue={100}
          step={0.1}
          hint="真实流量 × 倍率；0 = 仅记录不计费"
          value={values.rate}
          onChange={(v) => set("rate", v ?? 1)}
        />
      </div>
      <Switch isSelected={values.is_public} onChange={(v) => set("is_public", v)}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          公开节点
        </Switch.Content>
      </Switch>
      <TextForm
        label="描述"
        multiline
        inputProps={{ rows: 2 }}
        value={values.description}
        onChange={(v) => set("description", v)}
      />
      <FormFooter onCancel={onCancel} isPending={submitting} />
    </FormShell>
  );
}

// ---- Token dialog ----

function TokenDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  // 记录“已复制的是哪个令牌”，令牌更换时自然回到未复制态
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  return (
    <FormModal title="节点令牌" isOpen={token !== null} onClose={onClose}>
      {token !== null && (
        <>
          <p className="text-sm text-muted">新令牌已生效，可随时在节点详情中查看：</p>
          <div className="mt-2 flex items-start gap-2">
            <DataText className="flex-1 break-all text-sm leading-5">{token}</DataText>
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              aria-label="复制令牌"
              onPress={() => {
                navigator.clipboard.writeText(token).then(() => setCopiedToken(token));
              }}
            >
              {copiedToken === token ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </Button>
          </div>
        </>
      )}
    </FormModal>
  );
}

// ---- Token reveal row (drawer) ----

/** 节点令牌常驻脱敏展示：默认只露尾 4 位，点“显示”拉取完整令牌，可复制可隐藏。 */
function TokenField({ nodeId, tokenHint }: { nodeId: number; tokenHint: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    setPending(true);
    try {
      const res = await api.nodeToken(nodeId);
      setToken(res.token);
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {token === null ? (
        <>
          <DataText className="flex-1">•••• {tokenHint || "????"}</DataText>
          <Button variant="tertiary" size="sm" isPending={pending} onPress={reveal}>
            显示
          </Button>
        </>
      ) : (
        <>
          <DataText className="flex-1 break-all text-sm leading-5">{token}</DataText>
          <Button
            isIconOnly
            variant="tertiary"
            size="sm"
            aria-label="复制令牌"
            onPress={() => {
              navigator.clipboard.writeText(token).then(() => setCopied(true));
            }}
          >
            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
          </Button>
          <Button
            variant="tertiary"
            size="sm"
            onPress={() => {
              setToken(null);
              setCopied(false);
            }}
          >
            隐藏
          </Button>
        </>
      )}
    </div>
  );
}

// ---- Stats drawer ----

function StatsDrawer({ node, onClose }: { node: NodeWithMeta; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const statsQuery = useQuery({
    queryKey: ["node-stats", node.id],
    queryFn: () => api.nodeStats(node.id),
    refetchInterval: 10_000,
  });
  const healthQuery = useQuery({
    queryKey: ["node-health", node.id],
    queryFn: () => api.nodeHealth(node.id),
    refetchInterval: 10_000,
  });
  const metricsQuery = useQuery({ queryKey: ["node-metrics", node.id], queryFn: () => api.nodeMetrics(node.id, 24) });

  const health = healthQuery.data?.rows ?? [];
  const unhealthy = health.filter((h) => h.state !== "ready");
  const connStats = new Map<string, { avg: number; max: number }>();
  for (const m of metricsQuery.data?.rows ?? []) {
    const cur = connStats.get(m.service) ?? { avg: 0, max: 0 };
    connStats.set(m.service, {
      avg: cur.avg + m.conn_sum / Math.max(1, m.samples),
      max: Math.max(cur.max, m.conn_max),
    });
  }

  const stats = statsQuery.data?.rows ?? [];
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(stats.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = stats.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <SideDrawer title={`节点统计 #${node.id} · ${node.name}`} isOpen onClose={onClose}>
      <div className="flex flex-col gap-6">
        <section>
          <h3 className="mb-2 text-sm font-medium">节点令牌</h3>
          <TokenField nodeId={node.id} tokenHint={node.token_hint} />
        </section>
        <section>
          <h3 className="mb-2 text-sm font-medium">
            服务健康
            {health.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted">
                {health.length - unhealthy.length}/{health.length} 就绪
                {unhealthy.length > 0 ? `，${unhealthy.length} 异常` : ""} · 10s 自动刷新
              </span>
            )}
          </h3>
          {healthQuery.isLoading ? (
            <TableLoading />
          ) : health.length === 0 ? (
            <p className="py-4 text-sm text-muted">暂无健康数据（agent 未上报或节点空闲）</p>
          ) : (
            <div className="flex flex-col gap-1">
              {health.map((h) => {
                const conn = connStats.get(h.service);
                return (
                  <div
                    key={h.service}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <DataText className="truncate">{h.service}</DataText>
                      {conn && (
                        <span className="shrink-0 text-xs text-muted">
                          24h 峰值 {conn.max} · 均值 {conn.avg.toFixed(1)}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {h.error && (
                        <Tooltip delay={0}>
                          <Tooltip.Trigger>
                            <span className="max-w-[280px] truncate text-xs text-danger">{h.error}</span>
                          </Tooltip.Trigger>
                          <Tooltip.Content className="max-w-sm">
                            <p>{h.error}</p>
                          </Tooltip.Content>
                        </Tooltip>
                      )}
                      <StatusChip tone={serviceStateLabel(h.state).tone} title={h.state}>
                        {serviceStateLabel(h.state).label}
                      </StatusChip>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium">流量统计</h3>
          <Table.ScrollContainer>
            <Table className="min-w-[640px]">
              <Table.Content aria-label="流量统计">
                <Table.Header>
                  <Table.Column id="service" isRowHeader>
                    服务
                  </Table.Column>
                  <Table.Column id="conns">连接 (总/当前)</Table.Column>
                  <Table.Column id="bytes">流量 (入/出)</Table.Column>
                  <Table.Column id="errs">错误</Table.Column>
                  <Table.Column id="time" defaultWidth={160}>
                    时间
                  </Table.Column>
                </Table.Header>
                <Table.Body items={pageRows} renderEmptyState={emptyState("暂无统计数据")}>
                  {(row) => (
                    <Table.Row id={row.id}>
                      <Table.Cell>
                        <DataText>{row.service}</DataText>
                      </Table.Cell>
                      <Table.Cell>
                        {row.stats.totalConns} / {row.stats.currentConns}
                      </Table.Cell>
                      <Table.Cell>
                        <DataText>
                          {row.stats.inputBytes} / {row.stats.outputBytes} B
                        </DataText>
                      </Table.Cell>
                      <Table.Cell>{row.stats.totalErrs}</Table.Cell>
                      <Table.Cell>
                        <DataText className="text-muted">{row.reported_at.replace("T", " ").slice(0, 19)}</DataText>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Content>
            </Table>
          </Table.ScrollContainer>
          <Pager page={safePage} pageCount={pageCount} onChange={setPage} />
        </section>
      </div>
    </SideDrawer>
  );
}

// ---- Health column ----

type NodeHealthSummary = DashboardSummary["nodes_health"][number];

/** 列表行健康 chip：口径与控制台健康墙一致（failed+apply_failed 计为异常，0 服务 = 未上报）。 */
function NodeHealthChip({ health }: { health: NodeHealthSummary | undefined }) {
  if (health === undefined) return <span className="text-muted">-</span>;
  if (health.services === 0) {
    return (
      <StatusChip tone="default" title="agent 未上报健康快照">
        未上报
      </StatusChip>
    );
  }
  if (health.failed > 0) {
    return (
      <StatusChip tone="danger" title={`${health.failed} 个服务失败/下发失败，点行尾「统计」查看详情`}>
        {health.failed} 异常
      </StatusChip>
    );
  }
  return (
    <StatusChip tone="success" title={`最近上报 ${health.last_report?.replace("T", " ").slice(0, 19) ?? "-"}`}>
      {health.ready}/{health.services} 就绪
    </StatusChip>
  );
}

// ---- Page ----

export default function NodesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<NodeWithMeta | null>(null);
  const [searchParams] = useSearchParams();
  const [creating, setCreating] = useState(searchParams.get("create") === "1");
  const [token, setToken] = useState<string | null>(null);
  const [statsNode, setStatsNode] = useState<NodeWithMeta | null>(null);
  const [search, setSearch] = useState("");

  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
  // 复用控制台汇总的 nodes_health 聚合（一次请求拿全部节点），列表页据此给出异常标识
  const healthQuery = useQuery({
    queryKey: ["nodes-health"],
    queryFn: api.dashboardSummary,
    refetchInterval: 30_000,
  });
  const healthByNode = new Map(healthQuery.data?.nodes_health.map((h) => [h.node_id, h]));

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["nodes"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteNode, onSuccess: invalidate, onError: fail });
  const recomputeMutation = useMutation({
    mutationFn: api.recomputeNode,
    onSuccess: () => {
      invalidate();
      toast("已重新计算配置");
    },
    onError: fail,
  });
  const rotateMutation = useMutation({
    mutationFn: api.rotateNodeToken,
    onSuccess: (data) => setToken(data.token),
    onError: fail,
  });

  const nodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = nodesQuery.data?.nodes ?? [];
    if (!q) return all;
    return all.filter((n) =>
      [String(n.id), n.name, n.address, n.display_address ?? ""].some((field) => field.toLowerCase().includes(q)),
    );
  }, [nodesQuery.data, search]);

  return (
    <PageShell>
      <PageHeader
        title="节点列表"
        description="管理 GOST 中继节点及其接入配置"
        action={
          <Button onPress={() => setCreating(true)}>
            <IconPlus size={16} />
            新建节点
          </Button>
        }
      />
      <ListToolbar>
        <IconAction
          label="刷新"
          icon={<IconRefresh size={16} stroke={2} />}
          onPress={() => {
            nodesQuery.refetch();
            healthQuery.refetch();
          }}
        />
        <SearchInput value={search} onChange={setSearch} placeholder="搜索节点 / 地址" />
      </ListToolbar>
      {nodesQuery.isError ? (
        <TableError onRetry={() => nodesQuery.refetch()} />
      ) : nodesQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[1040px]">
            <Table.Content aria-label="节点列表">
              <Table.Header>
                <Table.Column id="id" defaultWidth={60} isRowHeader>
                  ID
                </Table.Column>
                <Table.Column id="name">名称</Table.Column>
                <Table.Column id="address">地址</Table.Column>
                <Table.Column id="display">对外地址</Table.Column>
                <Table.Column id="ports" defaultWidth={130}>
                  端口段
                </Table.Column>
                <Table.Column id="rate" defaultWidth={90}>
                  计费倍率
                </Table.Column>
                <Table.Column id="traffic" defaultWidth={180}>
                  流量 (入/出)
                </Table.Column>
                <Table.Column id="health" defaultWidth={110}>
                  健康
                </Table.Column>
                <Table.Column id="version" defaultWidth={100}>
                  配置版本
                </Table.Column>
                <Table.Column id="actions" defaultWidth={200}>
                  <span className="flex justify-end">操作</span>
                </Table.Column>
              </Table.Header>
              <Table.Body
                items={nodes}
                renderEmptyState={emptyState(search ? "没有匹配的结果" : "暂无数据，点击「新建节点」开始")}
              >
                {(n) => (
                  <Table.Row id={n.id}>
                    <Table.Cell>
                      <DataText>{n.id}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="flex items-center gap-1.5 font-medium">
                        {n.name}
                        {n.is_public && <StatusChip tone="accent">公开</StatusChip>}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <DataText>{n.address}</DataText>
                    </Table.Cell>
                    <Table.Cell>{n.display_address ?? <span className="text-muted">-</span>}</Table.Cell>
                    <Table.Cell>
                      <DataText>{n.ports}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      <DataText>{n.rate === 1 ? "1" : `${n.rate}×`}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="flex flex-col">
                        <DataText>入 {formatTraffic(n.ingress_traffic)}</DataText>
                        <DataText>出 {formatTraffic(n.egress_traffic)}</DataText>
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <NodeHealthChip health={healthByNode.get(n.id)} />
                    </Table.Cell>
                    <Table.Cell>
                      {n.config_version === null ? (
                        <span className="text-muted">-</span>
                      ) : (
                        <DataText>{n.config_version}</DataText>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-0.5">
                        <IconAction
                          label="编辑"
                          icon={<IconPencil size={16} stroke={2} />}
                          onPress={() => setEditing(n)}
                        />
                        <IconAction
                          label="统计"
                          icon={<IconChartBar size={16} stroke={2} />}
                          onPress={() => setStatsNode(n)}
                        />
                        <IconAction
                          label="轮换令牌"
                          tone="warning"
                          icon={<IconKey size={16} stroke={2} />}
                          onPress={() =>
                            confirmDanger("轮换令牌", "旧令牌立即失效，节点机需同步更新 .env 并重启，确定？", () =>
                              rotateMutation.mutate(n.id),
                            )
                          }
                        />
                        <IconAction
                          label="重新计算配置"
                          icon={<IconRefresh size={16} stroke={2} />}
                          onPress={() => recomputeMutation.mutate(n.id)}
                        />
                        <IconAction
                          label="删除"
                          tone="danger"
                          icon={<IconTrash size={16} stroke={2} />}
                          onPress={() =>
                            confirmDanger("删除节点", "其链路将一并删除并触发相关节点重算，确定？", () =>
                              deleteMutation.mutate(n.id),
                            )
                          }
                        />
                      </div>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table>
        </Table.ScrollContainer>
      )}

      <NodeDialog node={null} opened={creating} onClose={() => setCreating(false)} onCreated={(t) => setToken(t)} />
      <NodeDialog node={editing} opened={editing !== null} onClose={() => setEditing(null)} onCreated={() => {}} />
      <TokenDialog token={token} onClose={() => setToken(null)} />
      {statsNode !== null && <StatsDrawer key={statsNode.id} node={statsNode} onClose={() => setStatsNode(null)} />}
    </PageShell>
  );
}
