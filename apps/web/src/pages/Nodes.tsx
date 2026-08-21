import { Button, Switch, Table, Tooltip, toast } from "@heroui/react";
import { IconCheck, IconCopy, IconPlus, IconRefresh, IconRotateClockwise } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateNodeInput, NodeWithMeta } from "@tyz/shared";
import { type FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import { serviceStateLabel } from "../labels";
import {
  emptyState,
  type FormErrors,
  FormFooter,
  FormModal,
  FormShell,
  fail,
  hasErrors,
  ListToolbar,
  Mono,
  NumberForm,
  PageHeader,
  Pager,
  PageShell,
  RowButton,
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
  enlarge_scale: number;
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
        enlarge_scale: node.enlarge_scale,
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
        enlarge_scale: 1,
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
      enlarge_scale: values.enlarge_scale,
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
          label="扩容倍数"
          minValue={1}
          value={values.enlarge_scale}
          onChange={(v) => set("enlarge_scale", v ?? 1)}
        />
        <NumberForm
          label="计费倍率"
          minValue={0.1}
          maxValue={100}
          step={0.1}
          hint="真实流量 × 倍率"
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
          <p className="text-sm text-warning">令牌仅此一次完整显示，请立即保存：</p>
          <div className="mt-2 flex items-start gap-2">
            <Mono className="flex-1 break-all text-sm leading-5">{token}</Mono>
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
                      <Mono className="truncate">{h.service}</Mono>
                      {conn && (
                        <span className="shrink-0 text-xs text-muted">
                          24h 峰值 {conn.max} · 均值 {conn.avg.toFixed(1)}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {h.error && (
                        <Tooltip delay={0}>
                          <span className="max-w-[280px] truncate text-xs text-danger">{h.error}</span>
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
                        <Mono>{row.service}</Mono>
                      </Table.Cell>
                      <Table.Cell>
                        {row.stats.totalConns} / {row.stats.currentConns}
                      </Table.Cell>
                      <Table.Cell>
                        <Mono>
                          {row.stats.inputBytes} / {row.stats.outputBytes} B
                        </Mono>
                      </Table.Cell>
                      <Table.Cell>{row.stats.totalErrs}</Table.Cell>
                      <Table.Cell>
                        <Mono className="text-muted">{row.reported_at.replace("T", " ").slice(0, 19)}</Mono>
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
        <SearchInput value={search} onChange={setSearch} placeholder="搜索节点 / 地址" />
      </ListToolbar>
      {nodesQuery.isError ? (
        <TableError onRetry={() => nodesQuery.refetch()} />
      ) : nodesQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[960px]">
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
                <Table.Column id="version" defaultWidth={100}>
                  配置版本
                </Table.Column>
                <Table.Column id="actions" defaultWidth={300}>
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
                      <Mono>{n.id}</Mono>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="flex items-center gap-1.5 font-medium">
                        {n.name}
                        {n.is_public && <StatusChip tone="accent">公开</StatusChip>}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <Mono>{n.address}</Mono>
                    </Table.Cell>
                    <Table.Cell>{n.display_address ?? <span className="text-muted">-</span>}</Table.Cell>
                    <Table.Cell>
                      <Mono>{n.ports}</Mono>
                    </Table.Cell>
                    <Table.Cell>
                      <Mono>{n.rate === 1 ? "1" : `${n.rate}×`}</Mono>
                    </Table.Cell>
                    <Table.Cell>
                      {n.config_version === null ? (
                        <span className="text-muted">-</span>
                      ) : (
                        <Mono>{n.config_version}</Mono>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-1">
                        <RowButton onPress={() => setStatsNode(n)}>统计</RowButton>
                        <RowButton onPress={() => setEditing(n)}>编辑</RowButton>
                        <RowButton
                          onPress={() =>
                            confirmDanger("轮换令牌", "旧令牌立即失效，新令牌仅显示一次，确定？", () =>
                              rotateMutation.mutate(n.id),
                            )
                          }
                        >
                          <IconRotateClockwise size={14} stroke={1.7} />
                          轮换
                        </RowButton>
                        <Tooltip delay={0}>
                          <RowButton
                            isIconOnly
                            aria-label="重新计算配置"
                            onPress={() => recomputeMutation.mutate(n.id)}
                          >
                            <IconRefresh size={15} stroke={1.7} />
                          </RowButton>
                          <Tooltip.Content>
                            <p>重新计算配置</p>
                          </Tooltip.Content>
                        </Tooltip>
                        <RowButton
                          danger
                          onPress={() =>
                            confirmDanger("删除节点", "其链路将一并删除并触发相关节点重算，确定？", () =>
                              deleteMutation.mutate(n.id),
                            )
                          }
                        >
                          删除
                        </RowButton>
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
