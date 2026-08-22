import { Button, FieldError, Switch, Table } from "@heroui/react";
import { IconPencil, IconPlus, IconRoute, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Chain,
  ChainType,
  type CreateChainInput,
  type CreateTunnelInput,
  ForwardMode,
  type NodeWithMeta,
  Transport,
  type Tunnel,
  type TunnelWithMeta,
} from "@tyz/shared";
import { type FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import { chainTypeLabel, FORWARD_MODE_HINTS, forwardModeLabel } from "../labels";
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
  PageShell,
  SearchInput,
  SelectForm,
  SideDrawer,
  StatusChip,
  TableError,
  TableLoading,
  TextForm,
  useCrudMutation,
  useFormValues,
} from "../ui";

// ---- Tunnel form ----

const FORWARD_MODE_OPTIONS = [
  { value: ForwardMode.RELAY, label: "端口复用（relay 协议，默认）" },
  { value: ForwardMode.RAW, label: "直通转发（原生 TCP，每规则独立端口）" },
];

interface TunnelFormValues {
  name: string;
  ingress_display_address: string;
  description: string;
  forward_mode: string;
  tls_enabled: boolean;
}

function TunnelDialog({
  tunnel,
  opened,
  onClose,
}: {
  tunnel: TunnelWithMeta | null;
  opened: boolean;
  onClose: () => void;
}) {
  const { save, isPending } = useCrudMutation({
    invalidateKeys: [["tunnels"]],
    create: (input: CreateTunnelInput) => api.createTunnel(input),
    update: (id, input: CreateTunnelInput) => api.updateTunnel(id, input),
    onClose,
  });

  return (
    <FormModal title={tunnel === null ? "新建隧道" : `编辑隧道 #${tunnel.id}`} isOpen={opened} onClose={onClose}>
      {opened && (
        <TunnelForm
          key={tunnel?.id ?? "create"}
          tunnel={tunnel}
          submitting={isPending}
          onCancel={onClose}
          onSubmit={(input) => save(tunnel?.id ?? null, input)}
        />
      )}
    </FormModal>
  );
}

function TunnelForm({
  tunnel,
  onSubmit,
  submitting,
  onCancel,
}: {
  tunnel: TunnelWithMeta | null;
  onSubmit: (input: CreateTunnelInput) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => ({
    name: tunnel?.name ?? "",
    ingress_display_address: tunnel?.ingress_display_address ?? "",
    description: tunnel?.description ?? "",
    forward_mode: (tunnel?.forward_mode ?? ForwardMode.RELAY) as string,
    tls_enabled: tunnel?.tls_enabled ?? false,
  }));
  const [errors, setErrors] = useState<FormErrors<TunnelFormValues>>({});
  // A single-hop tunnel (one `in` chain, no exit node) renders identically
  // for both modes (direct tcp forwarding); the stored value is kept as the
  // operator picks it. TLS needs the 2-hop shape, so it stays hidden.
  const singleHop = (tunnel?.chain_count ?? 0) === 1;

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<TunnelFormValues> = {};
    if (!values.name.trim()) errs.name = "请输入名称";
    if (values.forward_mode === ForwardMode.RAW && values.tls_enabled) {
      errs.tls_enabled = "直通转发不支持 TLS（链路即纯 TCP）";
    }
    setErrors(errs);
    if (hasErrors(errs)) return;
    onSubmit({
      name: values.name,
      ingress_display_address: values.ingress_display_address || undefined,
      description: values.description || undefined,
      forward_mode: values.forward_mode as ForwardMode,
      tls_enabled: values.tls_enabled,
    });
  };

  return (
    <FormShell onSubmit={onSubmitForm}>
      <TextForm label="名称" isRequired value={values.name} onChange={(v) => set("name", v)} error={errors.name} />
      <TextForm
        label="入口地址"
        placeholder="可选，如 entry.example.com:80"
        value={values.ingress_display_address}
        onChange={(v) => set("ingress_display_address", v)}
      />
      <SelectForm
        label="转发模式"
        options={FORWARD_MODE_OPTIONS}
        value={values.forward_mode}
        onChange={(v) => set("forward_mode", String(v))}
        hint={
          singleHop ? "单节点隧道两种模式生成的配置相同（直连转发）；添加出口链路后模式才会产生实际区别" : undefined
        }
      />
      {singleHop ? null : values.forward_mode === ForwardMode.RAW ? (
        <p className="text-muted">
          直通转发：不走 relay 协议、无端口复用——每条规则在两端各占一个独立 TCP 端口，链路上无任何自定义协议特征。
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <Switch
            isSelected={values.tls_enabled}
            onChange={(v) => set("tls_enabled", v)}
            isInvalid={!!errors.tls_enabled}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              TLS 加密链路（平台证书，双向验证）
            </Switch.Content>
            {errors.tls_enabled ? <FieldError>{errors.tls_enabled}</FieldError> : null}
          </Switch>
          {values.tls_enabled ? (
            <p className="text-muted">
              出口链路的传输需为 grpc 或 tls（grpc 走 TLS1.3 + h2，外观为普通 gRPC 流量）。启用前请先在设置中配置 TLS
              伪装域名。
            </p>
          ) : null}
        </div>
      )}
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

// ---- Chain form ----

const CHAIN_TYPE_OPTIONS = [
  { value: ChainType.IN, label: "入口 (in)" },
  { value: ChainType.CHAIN, label: "中继 (chain)" },
  { value: ChainType.OUT, label: "出口 (out)" },
];
const TRANSPORT_OPTIONS = Object.values(Transport).map((v) => ({ value: v, label: v }));

interface ChainFormValues {
  node_id: string | null;
  chain_type: string;
  transport: string;
  index: number;
  port: number;
  strategy: string;
}

function chainFormValues(chain: Chain | null): ChainFormValues {
  return chain
    ? {
        node_id: String(chain.node_id),
        chain_type: chain.chain_type,
        transport: chain.transport,
        index: chain.index,
        port: chain.port,
        strategy: chain.strategy,
      }
    : {
        node_id: null,
        chain_type: ChainType.CHAIN,
        transport: Transport.RAW,
        index: 0,
        port: 0,
        strategy: "round",
      };
}

function ChainDialog({
  tunnelId,
  chain,
  nodes,
  opened,
  onClose,
}: {
  tunnelId: number;
  chain: Chain | null;
  nodes: NodeWithMeta[];
  opened: boolean;
  onClose: () => void;
}) {
  const { save, isPending } = useCrudMutation({
    invalidateKeys: [["chains", tunnelId], ["tunnels"]],
    create: (input: CreateChainInput) => api.createChain(input),
    update: (id, input: CreateChainInput) => api.updateChain(id, input),
    onClose,
  });

  return (
    <FormModal title={chain === null ? "添加链路" : `编辑链路 #${chain.id}`} isOpen={opened} onClose={onClose}>
      {opened && (
        <ChainForm
          key={chain?.id ?? "create"}
          chain={chain}
          nodes={nodes}
          submitting={isPending}
          onCancel={onClose}
          onSubmit={(input) => save(chain?.id ?? null, { ...input, tunnel_id: tunnelId })}
        />
      )}
    </FormModal>
  );
}

function ChainForm({
  chain,
  nodes,
  onSubmit,
  submitting,
  onCancel,
}: {
  chain: Chain | null;
  nodes: NodeWithMeta[];
  onSubmit: (input: Omit<CreateChainInput, "tunnel_id">) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => chainFormValues(chain));
  const [errors, setErrors] = useState<FormErrors<ChainFormValues>>({});

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<ChainFormValues> = {};
    if (!values.node_id) errs.node_id = "请选择节点";
    setErrors(errs);
    if (hasErrors(errs)) return;
    onSubmit({
      node_id: Number(values.node_id),
      chain_type: values.chain_type as ChainType,
      transport: values.transport as Transport,
      index: values.index,
      // 入口行的监听端口由转发规则指定，链路端口不适用（服务端同样强制 0）。
      port: values.chain_type === ChainType.IN ? 0 : values.port,
      strategy: values.strategy,
    });
  };

  return (
    <FormShell onSubmit={onSubmitForm}>
      <SelectForm
        label="节点"
        placeholder="选择节点"
        options={nodes.map((n) => ({ value: String(n.id), label: `${n.name} (#${n.id})` }))}
        value={values.node_id}
        onChange={(v) => set("node_id", (v as string | null) ?? null)}
        error={errors.node_id}
      />
      <div className="grid grid-cols-2 gap-3">
        <SelectForm
          label="类型"
          options={CHAIN_TYPE_OPTIONS}
          value={values.chain_type}
          onChange={(v) => set("chain_type", String(v))}
        />
        <SelectForm
          label="传输"
          options={TRANSPORT_OPTIONS}
          value={values.transport}
          onChange={(v) => set("transport", String(v))}
        />
        <NumberForm label="顺序" minValue={0} value={values.index} onChange={(v) => set("index", v ?? 0)} />
        <NumberForm
          label="端口"
          minValue={0}
          maxValue={65535}
          hint={values.chain_type === ChainType.IN ? "入口行不适用：监听端口由转发规则指定" : "0 = 自动分配"}
          isDisabled={values.chain_type === ChainType.IN}
          value={values.port}
          onChange={(v) => set("port", v ?? 0)}
        />
      </div>
      <TextForm label="策略" placeholder="round" value={values.strategy} onChange={(v) => set("strategy", v)} />
      <FormFooter onCancel={onCancel} isPending={submitting} />
    </FormShell>
  );
}

// ---- Chains drawer ----

function ChainsDrawer({ tunnel, nodes, onClose }: { tunnel: Tunnel; nodes: NodeWithMeta[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Chain | null>(null);
  const [creating, setCreating] = useState(false);

  const chainsQuery = useQuery({ queryKey: ["chains", tunnel.id], queryFn: () => api.tunnelChains(tunnel.id) });
  // Chain changes also affect the tunnel list's derived mode display
  // (chain_count) — refresh both.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["chains", tunnel.id] });
    queryClient.invalidateQueries({ queryKey: ["tunnels"] });
  };
  const deleteMutation = useMutation({ mutationFn: api.deleteChain, onSuccess: invalidate, onError: fail });

  const chains = chainsQuery.data?.chains ?? [];

  return (
    <SideDrawer title={`链路管理：${tunnel.name}`} isOpen onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-muted">按「顺序」从小到大排列组成完整转发链路</p>
        <div className="flex justify-end">
          <Button size="sm" onPress={() => setCreating(true)}>
            <IconPlus size={14} />
            添加链路
          </Button>
        </div>
        {chainsQuery.isLoading ? (
          <TableLoading />
        ) : (
          <Table.ScrollContainer>
            <Table className="min-w-[640px]">
              <Table.Content aria-label="链路列表">
                <Table.Header>
                  <Table.Column id="index" defaultWidth={60} isRowHeader>
                    顺序
                  </Table.Column>
                  <Table.Column id="node">节点</Table.Column>
                  <Table.Column id="type" defaultWidth={90}>
                    类型
                  </Table.Column>
                  <Table.Column id="transport" defaultWidth={80}>
                    传输
                  </Table.Column>
                  <Table.Column id="port" defaultWidth={80}>
                    端口
                  </Table.Column>
                  <Table.Column id="strategy" defaultWidth={90}>
                    策略
                  </Table.Column>
                  <Table.Column id="actions" defaultWidth={130}>
                    <span className="flex justify-end">操作</span>
                  </Table.Column>
                </Table.Header>
                <Table.Body items={chains} renderEmptyState={emptyState("暂无链路")}>
                  {(c) => (
                    <Table.Row id={c.id}>
                      <Table.Cell>
                        <DataText>{c.index}</DataText>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="font-medium">
                          {nodes.find((n) => n.id === c.node_id)?.name ?? "?"}{" "}
                          <DataText className="text-muted">#{c.node_id}</DataText>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <StatusChip tone={chainTypeLabel(c.chain_type).tone} title={c.chain_type}>
                          {chainTypeLabel(c.chain_type).label}
                        </StatusChip>
                      </Table.Cell>
                      <Table.Cell>
                        <DataText>{c.transport}</DataText>
                      </Table.Cell>
                      <Table.Cell>
                        <DataText>{c.port === 0 ? "自动" : c.port}</DataText>
                      </Table.Cell>
                      <Table.Cell>{c.strategy || "-"}</Table.Cell>
                      <Table.Cell>
                        <div className="flex justify-end gap-0.5">
                          <IconAction
                            label="编辑"
                            icon={<IconPencil size={16} stroke={2} />}
                            onPress={() => setEditing(c)}
                          />
                          <IconAction
                            label="删除"
                            tone="danger"
                            icon={<IconTrash size={16} stroke={2} />}
                            onPress={() =>
                              confirmDanger("删除链路", "确定删除该链路？", () => deleteMutation.mutate(c.id))
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
      </div>

      <ChainDialog
        tunnelId={tunnel.id}
        chain={null}
        nodes={nodes}
        opened={creating}
        onClose={() => setCreating(false)}
      />
      <ChainDialog
        tunnelId={tunnel.id}
        chain={editing}
        nodes={nodes}
        opened={editing !== null}
        onClose={() => setEditing(null)}
      />
    </SideDrawer>
  );
}

// ---- Page ----

export default function TunnelsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TunnelWithMeta | null>(null);
  const [searchParams] = useSearchParams();
  const [creating, setCreating] = useState(searchParams.get("create") === "1");
  const [chainsOf, setChainsOf] = useState<TunnelWithMeta | null>(null);
  const [search, setSearch] = useState("");

  const tunnelsQuery = useQuery({ queryKey: ["tunnels"], queryFn: api.listTunnels });
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tunnels"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteTunnel, onSuccess: invalidate, onError: fail });

  const nodes = nodesQuery.data?.nodes ?? [];
  const tunnels = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = tunnelsQuery.data?.tunnels ?? [];
    if (!q) return all;
    return all.filter((t) =>
      [String(t.id), t.name, t.description ?? "", t.ingress_display_address ?? ""].some((field) =>
        field.toLowerCase().includes(q),
      ),
    );
  }, [tunnelsQuery.data, search]);

  return (
    <PageShell>
      <PageHeader
        title="隧道列表"
        description="隧道由一组有序链路组成，串联入口、中继与出口节点"
        action={
          <Button onPress={() => setCreating(true)}>
            <IconPlus size={16} />
            新建隧道
          </Button>
        }
      />
      <ListToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="搜索隧道" />
      </ListToolbar>
      {tunnelsQuery.isError ? (
        <TableError onRetry={() => tunnelsQuery.refetch()} />
      ) : tunnelsQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[720px]">
            <Table.Content aria-label="隧道列表">
              <Table.Header>
                <Table.Column id="id" defaultWidth={60} isRowHeader>
                  ID
                </Table.Column>
                <Table.Column id="name">名称</Table.Column>
                <Table.Column id="mode" defaultWidth={150}>
                  模式
                </Table.Column>
                <Table.Column id="ingress">入口地址</Table.Column>
                <Table.Column id="description">描述</Table.Column>
                <Table.Column id="actions" defaultWidth={190}>
                  <span className="flex justify-end">操作</span>
                </Table.Column>
              </Table.Header>
              <Table.Body
                items={tunnels}
                renderEmptyState={emptyState(search ? "没有匹配的结果" : "暂无数据，点击「新建隧道」开始")}
              >
                {(t) => (
                  <Table.Row id={t.id}>
                    <Table.Cell>
                      <DataText>{t.id}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-medium">{t.name}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex items-center gap-1">
                        <StatusChip
                          tone={forwardModeLabel(t.forward_mode).tone}
                          title={FORWARD_MODE_HINTS[t.forward_mode] ?? t.forward_mode}
                        >
                          {forwardModeLabel(t.forward_mode).label}
                        </StatusChip>
                        {t.tls_enabled ? (
                          <StatusChip tone="success" title="链路 TLS（mTLS + 平台证书）">
                            TLS
                          </StatusChip>
                        ) : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell>{t.ingress_display_address ?? <span className="text-muted">-</span>}</Table.Cell>
                    <Table.Cell>
                      {t.description ? <span>{t.description}</span> : <span className="text-muted">-</span>}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-0.5">
                        <IconAction
                          label="编辑"
                          icon={<IconPencil size={16} stroke={2} />}
                          onPress={() => setEditing(t)}
                        />
                        <IconAction
                          label="链路管理"
                          icon={<IconRoute size={16} stroke={2} />}
                          onPress={() => setChainsOf(t)}
                        />
                        <IconAction
                          label="删除"
                          tone="danger"
                          icon={<IconTrash size={16} stroke={2} />}
                          onPress={() =>
                            confirmDanger("删除隧道", "其下链路与规则关联将一并清理，确定？", () =>
                              deleteMutation.mutate(t.id),
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

      <TunnelDialog tunnel={null} opened={creating} onClose={() => setCreating(false)} />
      <TunnelDialog tunnel={editing} opened={editing !== null} onClose={() => setEditing(null)} />
      {chainsOf !== null && (
        <ChainsDrawer key={chainsOf.id} tunnel={chainsOf} nodes={nodes} onClose={() => setChainsOf(null)} />
      )}
    </PageShell>
  );
}
