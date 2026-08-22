import { Button, Table } from "@heroui/react";
import { IconPencil, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreatePackageInput, Package, RelayNode, Tunnel } from "@tyz/shared";
import { type FormEvent, useMemo, useState } from "react";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import { formatBytes } from "../format";
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
  StatusChip,
  TableError,
  TableLoading,
  TextForm,
  useCrudMutation,
  useFormValues,
} from "../ui";

// ---- Package form ----

interface PackageFormValues {
  name: string;
  traffic_gb: number;
  period_days: number;
  max_rules: number;
  node_ids: number[];
  tunnel_ids: number[];
  note: string;
}

function packageFormValues(pkg: Package | null): PackageFormValues {
  return pkg
    ? {
        name: pkg.name,
        traffic_gb: pkg.traffic_bytes / 1024 ** 3,
        period_days: pkg.period_days,
        max_rules: pkg.max_rules,
        node_ids: pkg.node_ids ?? [],
        tunnel_ids: pkg.tunnel_ids ?? [],
        note: pkg.note ?? "",
      }
    : { name: "", traffic_gb: 0, period_days: 0, max_rules: 0, node_ids: [], tunnel_ids: [], note: "" };
}

function PackageDialog({
  pkg,
  nodes,
  tunnels,
  opened,
  onClose,
}: {
  pkg: Package | null;
  nodes: RelayNode[];
  tunnels: Tunnel[];
  opened: boolean;
  onClose: () => void;
}) {
  const { save, isPending } = useCrudMutation({
    invalidateKeys: [["packages"]],
    create: (input: CreatePackageInput) => api.createPackage(input),
    update: (id, input: CreatePackageInput) => api.updatePackage(id, input),
    onClose,
  });

  return (
    <FormModal title={pkg === null ? "新建套餐" : `编辑套餐 #${pkg.id}`} isOpen={opened} onClose={onClose}>
      {opened && (
        <PackageForm
          key={pkg?.id ?? "create"}
          pkg={pkg}
          nodes={nodes}
          tunnels={tunnels}
          submitting={isPending}
          onCancel={onClose}
          onSubmit={(input) => save(pkg?.id ?? null, input)}
        />
      )}
    </FormModal>
  );
}

function PackageForm({
  pkg,
  nodes,
  tunnels,
  onSubmit,
  submitting,
  onCancel,
}: {
  pkg: Package | null;
  nodes: RelayNode[];
  tunnels: Tunnel[];
  onSubmit: (input: CreatePackageInput) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => packageFormValues(pkg));
  const [errors, setErrors] = useState<FormErrors<PackageFormValues>>({});

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<PackageFormValues> = {};
    if (!values.name.trim()) errs.name = "请输入名称";
    setErrors(errs);
    if (hasErrors(errs)) return;
    onSubmit({
      name: values.name,
      traffic_bytes: Math.round(values.traffic_gb * 1024 ** 3),
      period_days: values.period_days,
      max_rules: values.max_rules,
      node_ids: values.node_ids.length > 0 ? values.node_ids : null,
      tunnel_ids: values.tunnel_ids.length > 0 ? values.tunnel_ids : null,
      note: values.note || undefined,
    });
  };

  return (
    <FormShell onSubmit={onSubmitForm}>
      <TextForm label="名称" isRequired value={values.name} onChange={(v) => set("name", v)} error={errors.name} />
      <div className="grid grid-cols-3 gap-3">
        <NumberForm
          label="流量 (GiB)"
          minValue={0}
          step={0.1}
          hint="0 = 不限"
          value={values.traffic_gb}
          onChange={(v) => set("traffic_gb", v ?? 0)}
        />
        <NumberForm
          label="有效天数"
          minValue={0}
          hint="0 = 永久"
          value={values.period_days}
          onChange={(v) => set("period_days", v ?? 0)}
        />
        <NumberForm
          label="规则上限"
          minValue={0}
          hint="0 = 不限"
          value={values.max_rules}
          onChange={(v) => set("max_rules", v ?? 0)}
        />
      </div>
      <SelectForm
        label="可用隧道"
        multiple
        placeholder="不选 = 不限制"
        options={tunnels.map((t) => ({ value: String(t.id), label: `${t.name} (#${t.id})` }))}
        value={values.tunnel_ids.map(String)}
        onChange={(v) => set("tunnel_ids", Array.isArray(v) ? v.map(Number) : [])}
      />
      <SelectForm
        label="可用节点"
        multiple
        placeholder="不选 = 不限制"
        options={nodes.map((n) => ({ value: String(n.id), label: `${n.name} (#${n.id})` }))}
        value={values.node_ids.map(String)}
        onChange={(v) => set("node_ids", Array.isArray(v) ? v.map(Number) : [])}
      />
      <TextForm label="备注" value={values.note} onChange={(v) => set("note", v)} />
      <FormFooter onCancel={onCancel} isPending={submitting} />
    </FormShell>
  );
}

// ---- Page ----

export default function PackagesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Package | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");

  const packagesQuery = useQuery({ queryKey: ["packages"], queryFn: api.listPackages });
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
  const tunnelsQuery = useQuery({ queryKey: ["tunnels"], queryFn: api.listTunnels });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["packages"] });
  const deleteMutation = useMutation({ mutationFn: api.deletePackage, onSuccess: invalidate, onError: fail });

  const nodes = nodesQuery.data?.nodes ?? [];
  const tunnels = tunnelsQuery.data?.tunnels ?? [];
  const packages = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = packagesQuery.data?.packages ?? [];
    if (!q) return all;
    return all.filter((p) => [String(p.id), p.name, p.note ?? ""].some((field) => field.toLowerCase().includes(q)));
  }, [packagesQuery.data, search]);

  return (
    <PageShell>
      <PageHeader
        title="套餐列表"
        description="流量配额、有效期、线路授权与规则数上限"
        action={
          <Button onPress={() => setCreating(true)}>
            <IconPlus size={16} />
            新建套餐
          </Button>
        }
      />
      <ListToolbar>
        <IconAction label="刷新" icon={<IconRefresh size={16} stroke={2} />} onPress={() => packagesQuery.refetch()} />
        <SearchInput value={search} onChange={setSearch} placeholder="搜索套餐" />
      </ListToolbar>
      {packagesQuery.isError ? (
        <TableError onRetry={() => packagesQuery.refetch()} />
      ) : packagesQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[760px]">
            <Table.Content aria-label="套餐列表">
              <Table.Header>
                <Table.Column id="id" defaultWidth={60} isRowHeader>
                  ID
                </Table.Column>
                <Table.Column id="name">名称</Table.Column>
                <Table.Column id="traffic" defaultWidth={110}>
                  流量
                </Table.Column>
                <Table.Column id="period" defaultWidth={90}>
                  有效期
                </Table.Column>
                <Table.Column id="scope">授权</Table.Column>
                <Table.Column id="actions" defaultWidth={140}>
                  <span className="flex justify-end">操作</span>
                </Table.Column>
              </Table.Header>
              <Table.Body
                items={packages}
                renderEmptyState={emptyState(search ? "没有匹配的结果" : "暂无数据，点击「新建套餐」开始")}
              >
                {(pkg) => (
                  <Table.Row id={pkg.id}>
                    <Table.Cell>
                      <DataText>{pkg.id}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-medium">
                        {pkg.name}
                        {pkg.max_rules > 0 && <span className="ml-2 text-xs text-muted">≤{pkg.max_rules} 规则</span>}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <DataText>{formatBytes(pkg.traffic_bytes)}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      {pkg.period_days > 0 ? (
                        <DataText>{pkg.period_days} 天</DataText>
                      ) : (
                        <StatusChip tone="accent">永久</StatusChip>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {pkg.tunnel_ids === null && pkg.node_ids === null ? (
                        <span className="text-muted">不限</span>
                      ) : (
                        <span className="text-xs text-muted">
                          隧道 {pkg.tunnel_ids === null ? "不限" : `#${pkg.tunnel_ids.join(" #")}`}
                          <br />
                          节点 {pkg.node_ids === null ? "不限" : `#${pkg.node_ids.join(" #")}`}
                        </span>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-0.5">
                        <IconAction
                          label="编辑"
                          icon={<IconPencil size={16} stroke={2} />}
                          onPress={() => setEditing(pkg)}
                        />
                        <IconAction
                          label="删除"
                          tone="danger"
                          icon={<IconTrash size={16} stroke={2} />}
                          onPress={() =>
                            confirmDanger("删除套餐", "有活跃订阅时无法删除，确定继续？", () =>
                              deleteMutation.mutate(pkg.id),
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

      <PackageDialog pkg={null} nodes={nodes} tunnels={tunnels} opened={creating} onClose={() => setCreating(false)} />
      <PackageDialog
        pkg={editing}
        nodes={nodes}
        tunnels={tunnels}
        opened={editing !== null}
        onClose={() => setEditing(null)}
      />
    </PageShell>
  );
}
