import { Button, Table, toast } from "@heroui/react";
import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AdminRuleRow,
  type CreateRuleInput,
  ForwardMode,
  limiterConfigSchema,
  type RelayRule,
  RelayRuleStatus,
  type Tunnel,
  type UserListItem,
} from "@tyz/shared";
import { type FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import { quotaStopReasonLabel, ruleStatusLabel } from "../labels";
import {
  emptyState,
  FilterChips,
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
  PageShell,
  RowButton,
  SearchInput,
  SelectForm,
  StatusChip,
  TableError,
  TableLoading,
  TextForm,
  useCrudMutation,
  useFormValues,
} from "../ui";

function validateLimitText(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "不是合法的 JSON";
  }
  const result = limiterConfigSchema.safeParse(parsed);
  if (!result.success) return `限速配置无效: ${result.error.issues[0]?.message ?? ""}`;
  return undefined;
}

// ---- Rule form ----

interface RuleFormValues {
  name: string;
  listen_port: number;
  targets: string;
  status: string;
  description: string;
  tunnel_id: string | null;
  user_id: string | null;
  exit_port: number;
  limitText: string;
}

function ruleFormValues(rule: RelayRule | null): RuleFormValues {
  return rule
    ? {
        name: rule.name,
        listen_port: rule.listen_port,
        targets: rule.targets,
        tunnel_id: rule.tunnel_id === undefined ? null : String(rule.tunnel_id),
        user_id: rule.user_id === undefined ? null : String(rule.user_id),
        status: rule.status,
        exit_port: rule.exit_port ?? 0,
        limitText: rule.limit ? JSON.stringify(rule.limit, null, 2) : "",
        description: rule.description ?? "",
      }
    : {
        name: "",
        listen_port: 0,
        targets: "",
        tunnel_id: null,
        user_id: null,
        status: RelayRuleStatus.CREATED,
        exit_port: 0,
        limitText: "",
        description: "",
      };
}

function RuleDialog({
  rule,
  tunnels,
  users,
  opened,
  onClose,
}: {
  rule: RelayRule | null;
  tunnels: Tunnel[];
  users: UserListItem[];
  opened: boolean;
  onClose: () => void;
}) {
  const { save, isPending } = useCrudMutation({
    invalidateKeys: [["rules"]],
    create: (input: CreateRuleInput) => api.createRule(input),
    update: (id, input: CreateRuleInput) => api.updateRule(id, input),
    onClose,
  });

  return (
    <FormModal
      title={rule === null ? "新建规则" : `编辑规则 #${rule.id}`}
      isOpen={opened}
      onClose={onClose}
      width="sm:max-w-lg"
    >
      {opened && (
        <RuleForm
          key={rule?.id ?? "create"}
          rule={rule}
          tunnels={tunnels}
          users={users}
          submitting={isPending}
          onCancel={onClose}
          onSubmit={(input) => save(rule?.id ?? null, input)}
        />
      )}
    </FormModal>
  );
}

function RuleForm({
  rule,
  tunnels,
  users,
  onSubmit,
  submitting,
  onCancel,
}: {
  rule: RelayRule | null;
  tunnels: Tunnel[];
  users: UserListItem[];
  onSubmit: (input: CreateRuleInput) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => ruleFormValues(rule));
  const [errors, setErrors] = useState<FormErrors<RuleFormValues>>({});

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<RuleFormValues> = {};
    if (!values.name.trim()) errs.name = "请输入名称";
    if (!values.targets.trim()) errs.targets = "请输入目标地址";
    if (values.listen_port < 1 || values.listen_port > 65535) errs.listen_port = "端口范围 1-65535";
    const limitError = validateLimitText(values.limitText);
    if (limitError) errs.limitText = limitError;
    setErrors(errs);
    if (hasErrors(errs)) return;

    onSubmit({
      name: values.name,
      listen_port: values.listen_port,
      targets: values.targets,
      status: values.status as RelayRuleStatus,
      description: values.description || undefined,
      tunnel_id: values.tunnel_id ? Number(values.tunnel_id) : null,
      user_id: values.user_id ? Number(values.user_id) : null,
      exit_port: values.exit_port,
      limit: values.limitText.trim() === "" ? null : (JSON.parse(values.limitText) as CreateRuleInput["limit"]),
    });
  };

  return (
    <FormShell onSubmit={onSubmitForm}>
      <TextForm label="名称" isRequired value={values.name} onChange={(v) => set("name", v)} error={errors.name} />
      <div className="grid grid-cols-2 gap-3">
        <NumberForm
          label="监听端口"
          minValue={1}
          maxValue={65535}
          value={values.listen_port}
          onChange={(v) => set("listen_port", v ?? 0)}
          error={errors.listen_port}
        />
        <SelectForm
          label="状态"
          options={Object.values(RelayRuleStatus).map((v) => ({ value: v, label: ruleStatusLabel(v).label }))}
          value={values.status}
          onChange={(v) => set("status", String(v))}
        />
      </div>
      <TextForm
        label="目标地址"
        isRequired
        placeholder="如 example.com:80"
        value={values.targets}
        onChange={(v) => set("targets", v)}
        error={errors.targets}
      />
      <div className="grid grid-cols-2 gap-3">
        <SelectForm
          label="所属隧道"
          placeholder="不指定（直连转发）"
          options={[
            { value: "", label: "不指定（直连转发）" },
            ...tunnels.map((t) => ({ value: String(t.id), label: `${t.name} (#${t.id})` })),
          ]}
          value={values.tunnel_id}
          onChange={(v) => set("tunnel_id", (v as string | null) ?? null)}
        />
        <SelectForm
          label="所属用户"
          placeholder="管理员（无配额）"
          options={[
            { value: "", label: "管理员（无配额）" },
            ...users.map((u) => ({ value: String(u.id), label: `${u.name} (#${u.id})` })),
          ]}
          value={values.user_id}
          onChange={(v) => set("user_id", (v as string | null) ?? null)}
        />
      </div>
      {tunnels.find((t) => String(t.id) === values.tunnel_id)?.forward_mode === ForwardMode.RAW ? (
        <NumberForm
          label="出口端口"
          minValue={0}
          maxValue={65535}
          hint="裸转发隧道在出口节点上的独立监听端口；0 = 自动分配"
          value={values.exit_port}
          onChange={(v) => set("exit_port", v ?? 0)}
        />
      ) : null}
      <TextForm
        label="限速配置 (JSON)"
        multiline
        hint='如 {"traffic":{"service_in":1048576}}；留空不限速'
        inputProps={{ rows: 4, className: "font-mono text-xs" }}
        value={values.limitText}
        onChange={(v) => set("limitText", v)}
        error={errors.limitText}
      />
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

// ---- Page ----

type RuleFilter = "all" | "created" | "paused" | "running" | "error" | "quota_stopped";

const RULE_FILTERS: { value: RuleFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "paused", label: "已暂停" },
  { value: "created", label: "已创建" },
  { value: "error", label: "错误" },
  { value: "quota_stopped", label: "配额停用" },
];

export default function RulesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RelayRule | null>(null);
  const [searchParams] = useSearchParams();
  const [creating, setCreating] = useState(searchParams.get("create") === "1");
  const initialFilter = RULE_FILTERS.some((f) => f.value === searchParams.get("status"))
    ? (searchParams.get("status") as RuleFilter)
    : "all";
  const [filter, setFilter] = useState<RuleFilter>(initialFilter);
  const [search, setSearch] = useState("");

  const rulesQuery = useQuery({ queryKey: ["rules"], queryFn: api.listRules });
  const tunnelsQuery = useQuery({ queryKey: ["tunnels"], queryFn: api.listTunnels });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: api.listUsers });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["rules"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteRule, onSuccess: invalidate, onError: fail });
  const restartMutation = useMutation({
    mutationFn: api.restartRule,
    onSuccess: (res) => toast(`重启指令已下发（${res.nodes} 个节点）：现有连接将被断开并立即重建监听`),
    onError: fail,
  });

  const tunnels = tunnelsQuery.data?.tunnels ?? [];
  const users = usersQuery.data?.users ?? [];
  const rules: AdminRuleRow[] = rulesQuery.data?.rules ?? [];

  const counts = useMemo(() => {
    const by: Record<RuleFilter, number> = {
      all: rules.length,
      created: 0,
      paused: 0,
      running: 0,
      error: 0,
      quota_stopped: 0,
    };
    for (const r of rules) {
      by[r.status as RuleFilter] = (by[r.status as RuleFilter] ?? 0) + 1;
      if (r.quota_stopped) by.quota_stopped += 1;
    }
    return by;
  }, [rules]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter((r) => {
      const statusOk = filter === "all" ? true : filter === "quota_stopped" ? !!r.quota_stopped : r.status === filter;
      if (!statusOk) return false;
      if (!q) return true;
      return [String(r.id), r.name, r.targets, String(r.listen_port)].some((field) => field.toLowerCase().includes(q));
    });
  }, [rules, filter, search]);

  return (
    <PageShell>
      <PageHeader
        title="转发规则列表"
        description="定义入口节点的监听端口与转发目标"
        action={
          <Button onPress={() => setCreating(true)}>
            <IconPlus size={16} />
            新建规则
          </Button>
        }
      />
      <ListToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="搜索规则 / 端口 / 目标" />
        <FilterChips
          options={RULE_FILTERS.map((f) => ({ ...f, count: counts[f.value] }))}
          value={filter}
          onChange={setFilter}
        />
      </ListToolbar>
      {rulesQuery.isError ? (
        <TableError onRetry={() => rulesQuery.refetch()} />
      ) : rulesQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[960px]">
            <Table.Content aria-label="转发规则列表">
              <Table.Header>
                <Table.Column id="id" defaultWidth={60} isRowHeader>
                  ID
                </Table.Column>
                <Table.Column id="name">名称</Table.Column>
                <Table.Column id="port" defaultWidth={80}>
                  端口
                </Table.Column>
                <Table.Column id="targets">目标</Table.Column>
                <Table.Column id="tunnel" defaultWidth={130}>
                  隧道
                </Table.Column>
                <Table.Column id="user" defaultWidth={100}>
                  用户
                </Table.Column>
                <Table.Column id="status" defaultWidth={210}>
                  状态
                </Table.Column>
                <Table.Column id="actions" defaultWidth={150}>
                  <span className="flex justify-end">操作</span>
                </Table.Column>
              </Table.Header>
              <Table.Body
                items={filtered}
                renderEmptyState={emptyState(
                  search || filter !== "all" ? "没有匹配的结果" : "暂无数据，点击「新建规则」开始",
                )}
              >
                {(r) => (
                  <Table.Row id={r.id}>
                    <Table.Cell>
                      <Mono>{r.id}</Mono>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-medium">{r.name}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <Mono>{r.listen_port}</Mono>
                    </Table.Cell>
                    <Table.Cell>
                      <Mono>{r.targets}</Mono>
                    </Table.Cell>
                    <Table.Cell>
                      {r.tunnel_id ? (
                        <span>
                          {tunnels.find((t) => t.id === r.tunnel_id)?.name ?? "?"}{" "}
                          <Mono className="text-muted">#{r.tunnel_id}</Mono>
                        </span>
                      ) : (
                        "-"
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {r.user_id !== undefined ? (
                        (users.find((u) => u.id === r.user_id)?.name ?? "?")
                      ) : (
                        <span className="text-muted">管理员</span>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex items-center gap-1">
                        <StatusChip tone={ruleStatusLabel(r.status).tone} title={r.status}>
                          {ruleStatusLabel(r.status).label}
                        </StatusChip>
                        {r.quota_stopped && (
                          <StatusChip
                            tone="danger"
                            title={`配额硬停：该规则已从节点配置中剔除（原因：${quotaStopReasonLabel(r.quota_reason).label}）`}
                          >
                            配额停用 · {quotaStopReasonLabel(r.quota_reason).label}
                          </StatusChip>
                        )}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-1">
                        <RowButton onPress={() => setEditing(r)}>编辑</RowButton>
                        <RowButton isDisabled={restartMutation.isPending} onPress={() => restartMutation.mutate(r.id)}>
                          重启
                        </RowButton>
                        <RowButton
                          danger
                          onPress={() =>
                            confirmDanger("删除规则", "确定删除该规则？", () => deleteMutation.mutate(r.id))
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

      <RuleDialog rule={null} tunnels={tunnels} users={users} opened={creating} onClose={() => setCreating(false)} />
      <RuleDialog
        rule={editing}
        tunnels={tunnels}
        users={users}
        opened={editing !== null}
        onClose={() => setEditing(null)}
      />
    </PageShell>
  );
}
