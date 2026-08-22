import { Button, Table } from "@heroui/react";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CreateEndpointInput, type Endpoint, type EndpointWithMeta, endpointAddress } from "@tyz/shared";
import { type FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { confirmDanger } from "../confirm";
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
  StatusChip,
  TableError,
  TableLoading,
  TextForm,
  useCrudMutation,
  useFormValues,
} from "../ui";

// ---- Endpoint form ----

interface EndpointFormValues {
  name: string;
  host: string;
  port: number;
  note: string;
}

function endpointFormValues(endpoint: Endpoint | null): EndpointFormValues {
  return endpoint
    ? { name: endpoint.name, host: endpoint.host, port: endpoint.port, note: endpoint.note ?? "" }
    : { name: "", host: "", port: 0, note: "" };
}

function EndpointDialog({
  endpoint,
  opened,
  onClose,
}: {
  endpoint: Endpoint | null;
  opened: boolean;
  onClose: () => void;
}) {
  const { save, isPending } = useCrudMutation({
    invalidateKeys: [["endpoints"], ["rules"]],
    create: (input: CreateEndpointInput) => api.createEndpoint(input),
    update: (id, input: CreateEndpointInput) => api.updateEndpoint(id, input),
    onClose,
  });

  return (
    <FormModal
      title={endpoint === null ? "新建目标端点" : `编辑目标端点 #${endpoint.id}`}
      isOpen={opened}
      onClose={onClose}
    >
      {opened && (
        <EndpointForm
          key={endpoint?.id ?? "create"}
          endpoint={endpoint}
          submitting={isPending}
          onCancel={onClose}
          onSubmit={(input) => save(endpoint?.id ?? null, input)}
        />
      )}
    </FormModal>
  );
}

function EndpointForm({
  endpoint,
  onSubmit,
  submitting,
  onCancel,
}: {
  endpoint: Endpoint | null;
  onSubmit: (input: CreateEndpointInput) => void;
  submitting: boolean;
  onCancel: () => void;
}) {
  const { values, set } = useFormValues(() => endpointFormValues(endpoint));
  const [errors, setErrors] = useState<FormErrors<EndpointFormValues>>({});

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<EndpointFormValues> = {};
    if (!values.name.trim()) errs.name = "请输入名称";
    if (!values.host.trim()) errs.host = "请输入主机（IP 或域名）";
    if (values.port < 1 || values.port > 65535) errs.port = "端口范围 1-65535";
    setErrors(errs);
    if (hasErrors(errs)) return;
    onSubmit({ name: values.name, host: values.host, port: values.port, note: values.note || undefined });
  };

  return (
    <FormShell onSubmit={onSubmitForm}>
      <TextForm label="名称" isRequired value={values.name} onChange={(v) => set("name", v)} error={errors.name} />
      <div className="grid grid-cols-[1fr_140px] gap-3">
        <TextForm
          label="主机"
          isRequired
          placeholder="IP 或域名"
          hint="修改地址将自动同步所有引用该端点的规则"
          value={values.host}
          onChange={(v) => set("host", v)}
          error={errors.host}
        />
        <NumberForm
          label="端口"
          isRequired
          minValue={1}
          maxValue={65535}
          value={values.port}
          onChange={(v) => set("port", v ?? 0)}
          error={errors.port}
        />
      </div>
      <TextForm label="备注" value={values.note} onChange={(v) => set("note", v)} />
      <FormFooter onCancel={onCancel} isPending={submitting} />
    </FormShell>
  );
}

// ---- Page ----

export default function EndpointsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Endpoint | null>(null);
  const [searchParams] = useSearchParams();
  const [creating, setCreating] = useState(searchParams.get("create") === "1");
  const [search, setSearch] = useState("");

  const endpointsQuery = useQuery({ queryKey: ["endpoints"], queryFn: api.listEndpoints });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["endpoints"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteEndpoint, onSuccess: invalidate, onError: fail });

  const endpoints = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all: EndpointWithMeta[] = endpointsQuery.data?.endpoints ?? [];
    if (!q) return all;
    return all.filter((e) =>
      [String(e.id), e.name, e.host, String(e.port), e.note ?? ""].some((field) => field.toLowerCase().includes(q)),
    );
  }, [endpointsQuery.data, search]);

  return (
    <PageShell>
      <PageHeader
        title="目标端点列表"
        description="集中管理转发目标服务，创建规则时可直接选取"
        action={
          <Button onPress={() => setCreating(true)}>
            <IconPlus size={16} />
            新建端点
          </Button>
        }
      />
      <ListToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="搜索端点 / 主机" />
      </ListToolbar>
      {endpointsQuery.isError ? (
        <TableError onRetry={() => endpointsQuery.refetch()} />
      ) : endpointsQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[760px]">
            <Table.Content aria-label="目标端点列表">
              <Table.Header>
                <Table.Column id="id" defaultWidth={60} isRowHeader>
                  ID
                </Table.Column>
                <Table.Column id="name">名称</Table.Column>
                <Table.Column id="address" defaultWidth={220}>
                  地址
                </Table.Column>
                <Table.Column id="refs" defaultWidth={110}>
                  引用规则
                </Table.Column>
                <Table.Column id="note">备注</Table.Column>
                <Table.Column id="actions" defaultWidth={140}>
                  <span className="flex justify-end">操作</span>
                </Table.Column>
              </Table.Header>
              <Table.Body
                items={endpoints}
                renderEmptyState={emptyState(search ? "没有匹配的结果" : "暂无数据，点击「新建端点」开始")}
              >
                {(e) => (
                  <Table.Row id={e.id}>
                    <Table.Cell>
                      <DataText>{e.id}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-medium">{e.name}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <DataText>{endpointAddress(e.host, e.port)}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      {e.rule_count > 0 ? (
                        <StatusChip tone="accent">{e.rule_count} 条规则</StatusChip>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <span className="text-xs text-muted">{e.note || "-"}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-0.5">
                        <IconAction
                          label="编辑"
                          icon={<IconPencil size={16} stroke={2} />}
                          onPress={() => setEditing(e)}
                        />
                        <IconAction
                          label="删除"
                          tone="danger"
                          icon={<IconTrash size={16} stroke={2} />}
                          onPress={() =>
                            confirmDanger("删除目标端点", "有规则引用时无法删除，确定继续？", () =>
                              deleteMutation.mutate(e.id),
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

      <EndpointDialog endpoint={null} opened={creating} onClose={() => setCreating(false)} />
      <EndpointDialog endpoint={editing} opened={editing !== null} onClose={() => setEditing(null)} />
    </PageShell>
  );
}
