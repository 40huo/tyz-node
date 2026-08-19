import { Button, Chip, Table } from "@heroui/react";
import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NodeWithMeta } from "@tyz/shared";
import {
  type Chain,
  ChainType,
  type CreateChainInput,
  type CreateTunnelInput,
  Transport,
  type Tunnel,
  type UpdateChainInput,
  type UpdateTunnelInput,
} from "@tyz/shared";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import {
  emptyState,
  type FormErrors,
  FormModal,
  FormShell,
  fail,
  hasErrors,
  Mono,
  NumberForm,
  PageHeader,
  PageShell,
  RowButton,
  SelectForm,
  SideDrawer,
  SubmitButton,
  TableLoading,
  TextForm,
  useFormValues,
} from "../ui";

// ---- Tunnel form ----

interface TunnelFormValues {
  name: string;
  ingress_display_address: string;
  description: string;
}

function TunnelDialog({ tunnel, opened, onClose }: { tunnel: Tunnel | null; opened: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tunnels"] });

  const createMutation = useMutation({
    mutationFn: (input: CreateTunnelInput) => api.createTunnel(input),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: fail,
  });
  const updateMutation = useMutation({
    mutationFn: (input: UpdateTunnelInput) => api.updateTunnel(tunnel!.id, input),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: fail,
  });

  return (
    <FormModal title={tunnel === null ? "新建隧道" : `编辑隧道 #${tunnel.id}`} isOpen={opened} onClose={onClose}>
      {opened && (
        <TunnelForm
          key={tunnel?.id ?? "create"}
          tunnel={tunnel}
          submitting={createMutation.isPending || updateMutation.isPending}
          onCancel={onClose}
          onSubmit={(input) => {
            if (tunnel === null) createMutation.mutate(input);
            else updateMutation.mutate(input);
          }}
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
  tunnel: Tunnel | null;
  onSubmit: (input: CreateTunnelInput) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => ({
    name: tunnel?.name ?? "",
    ingress_display_address: tunnel?.ingress_display_address ?? "",
    description: tunnel?.description ?? "",
  }));
  const [errors, setErrors] = useState<FormErrors<TunnelFormValues>>({});

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<TunnelFormValues> = {};
    if (!values.name.trim()) errs.name = "请输入名称";
    setErrors(errs);
    if (hasErrors(errs)) return;
    onSubmit({
      name: values.name,
      ingress_display_address: values.ingress_display_address || undefined,
      description: values.description || undefined,
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
      <TextForm
        label="描述"
        multiline
        inputProps={{ rows: 2 }}
        value={values.description}
        onChange={(v) => set("description", v)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="tertiary" onPress={onCancel}>
          取消
        </Button>
        <SubmitButton isPending={submitting}>保存</SubmitButton>
      </div>
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

const CHAIN_TYPE_COLOR: Record<string, "success" | "accent" | "danger"> = {
  [ChainType.IN]: "success",
  [ChainType.CHAIN]: "accent",
  [ChainType.OUT]: "danger",
};
const CHAIN_TYPE_LABELS: Record<string, string> = {
  [ChainType.IN]: "入口",
  [ChainType.CHAIN]: "中继",
  [ChainType.OUT]: "出口",
};

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
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["chains", tunnelId] });

  const createMutation = useMutation({
    mutationFn: (input: CreateChainInput) => api.createChain(input),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: fail,
  });
  const updateMutation = useMutation({
    mutationFn: (input: UpdateChainInput) => api.updateChain(chain!.id, input),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: fail,
  });

  return (
    <FormModal title={chain === null ? "添加链路" : `编辑链路 #${chain.id}`} isOpen={opened} onClose={onClose}>
      {opened && (
        <ChainForm
          key={chain?.id ?? "create"}
          chain={chain}
          nodes={nodes}
          submitting={createMutation.isPending || updateMutation.isPending}
          onCancel={onClose}
          onSubmit={(input) => {
            const full = { ...input, tunnel_id: tunnelId };
            if (chain === null) createMutation.mutate(full);
            else updateMutation.mutate(full);
          }}
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
      port: values.port,
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
          hint="0 = 自动分配"
          value={values.port}
          onChange={(v) => set("port", v ?? 0)}
        />
      </div>
      <TextForm label="策略" placeholder="round" value={values.strategy} onChange={(v) => set("strategy", v)} />
      <div className="flex justify-end gap-2">
        <Button variant="tertiary" onPress={onCancel}>
          取消
        </Button>
        <SubmitButton isPending={submitting}>保存</SubmitButton>
      </div>
    </FormShell>
  );
}

// ---- Chains drawer ----

function ChainsDrawer({ tunnel, nodes, onClose }: { tunnel: Tunnel; nodes: NodeWithMeta[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Chain | null>(null);
  const [creating, setCreating] = useState(false);

  const chainsQuery = useQuery({ queryKey: ["chains", tunnel.id], queryFn: () => api.tunnelChains(tunnel.id) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["chains", tunnel.id] });
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
                        <Mono>{c.index}</Mono>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="font-medium">
                          {nodes.find((n) => n.id === c.node_id)?.name ?? "?"}{" "}
                          <Mono className="text-muted">#{c.node_id}</Mono>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip color={CHAIN_TYPE_COLOR[c.chain_type] ?? "default"} variant="soft" size="sm">
                          <Chip.Label>{CHAIN_TYPE_LABELS[c.chain_type] ?? c.chain_type}</Chip.Label>
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <Mono>{c.transport}</Mono>
                      </Table.Cell>
                      <Table.Cell>
                        <Mono>{c.port === 0 ? "自动" : c.port}</Mono>
                      </Table.Cell>
                      <Table.Cell>{c.strategy || "-"}</Table.Cell>
                      <Table.Cell>
                        <div className="flex justify-end gap-1">
                          <RowButton onPress={() => setEditing(c)}>编辑</RowButton>
                          <RowButton
                            danger
                            onPress={() =>
                              confirmDanger("删除链路", "确定删除该链路？", () => deleteMutation.mutate(c.id))
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
  const [editing, setEditing] = useState<Tunnel | null>(null);
  const [creating, setCreating] = useState(false);
  const [chainsOf, setChainsOf] = useState<Tunnel | null>(null);

  const tunnelsQuery = useQuery({ queryKey: ["tunnels"], queryFn: api.listTunnels });
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tunnels"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteTunnel, onSuccess: invalidate, onError: fail });

  const tunnels = tunnelsQuery.data?.tunnels ?? [];
  const nodes = nodesQuery.data?.nodes ?? [];

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
      {tunnelsQuery.isLoading ? (
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
                <Table.Column id="ingress">入口地址</Table.Column>
                <Table.Column id="description">描述</Table.Column>
                <Table.Column id="actions" defaultWidth={190}>
                  <span className="flex justify-end">操作</span>
                </Table.Column>
              </Table.Header>
              <Table.Body items={tunnels} renderEmptyState={emptyState("暂无数据，点击「新建隧道」开始")}>
                {(t) => (
                  <Table.Row id={t.id}>
                    <Table.Cell>
                      <Mono>{t.id}</Mono>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-medium">{t.name}</span>
                    </Table.Cell>
                    <Table.Cell>{t.ingress_display_address ?? <span className="text-muted">-</span>}</Table.Cell>
                    <Table.Cell>
                      {t.description ? <span>{t.description}</span> : <span className="text-muted">-</span>}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-1">
                        <RowButton onPress={() => setEditing(t)}>编辑</RowButton>
                        <RowButton onPress={() => setChainsOf(t)}>链路</RowButton>
                        <RowButton
                          danger
                          onPress={() =>
                            confirmDanger("删除隧道", "其下链路与规则关联将一并清理，确定？", () =>
                              deleteMutation.mutate(t.id),
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

      <TunnelDialog tunnel={null} opened={creating} onClose={() => setCreating(false)} />
      <TunnelDialog tunnel={editing} opened={editing !== null} onClose={() => setEditing(null)} />
      {chainsOf !== null && (
        <ChainsDrawer key={chainsOf.id} tunnel={chainsOf} nodes={nodes} onClose={() => setChainsOf(null)} />
      )}
    </PageShell>
  );
}
