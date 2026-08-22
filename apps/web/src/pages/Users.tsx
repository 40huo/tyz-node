import { Button, ProgressBar, Separator, Table, toast } from "@heroui/react";
import { IconBan, IconCircleCheck, IconCreditCard, IconEye, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type UserDetail, type UserListItem, UserStatus } from "@tyz/shared";
import { type FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import { formatBytes } from "../format";
import { quotaStopReasonLabel, userStatusLabel } from "../labels";
import {
  DataText,
  emptyState,
  FormFooter,
  FormModal,
  FormShell,
  fail,
  IconAction,
  ListToolbar,
  PageHeader,
  PageShell,
  SearchInput,
  SelectForm,
  StatusChip,
  SubmitButton,
  TableError,
  TableLoading,
  TextForm,
} from "../ui";

function CreateUserDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const createMutation = useMutation({
    mutationFn: () => api.createUser({ name, note: note || undefined, status: UserStatus.ACTIVE }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
      setName("");
      setNote("");
      setError(undefined);
      toast.success("用户已创建");
    },
    onError: fail,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("请输入名称");
      return;
    }
    setError(undefined);
    createMutation.mutate();
  };

  return (
    <FormModal title="新建用户" isOpen={opened} onClose={onClose}>
      {opened && (
        <FormShell onSubmit={onSubmit}>
          <TextForm label="名称" placeholder="用户名" value={name} onChange={setName} error={error} />
          <TextForm label="备注" placeholder="可选" value={note} onChange={setNote} />
          <FormFooter onCancel={onClose} isPending={createMutation.isPending} label="创建" />
        </FormShell>
      )}
    </FormModal>
  );
}

function SubscribeDialog({
  user,
  opened,
  onClose,
}: {
  user: UserListItem | null;
  opened: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const packagesQuery = useQuery({ queryKey: ["packages"], queryFn: api.listPackages, enabled: opened });
  const [packageId, setPackageId] = useState<string | null>(null);

  const subscribeMutation = useMutation({
    mutationFn: (pkgId: number) => api.subscribeUser(user!.id, pkgId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["user-detail", user?.id] });
      queryClient.invalidateQueries({ queryKey: ["rules"] });
      onClose();
      toast.success("订阅已生效");
    },
    onError: fail,
  });

  const currentPackageId = user?.subscription?.package_id;
  const switching = currentPackageId !== undefined && packageId !== null && Number(packageId) !== currentPackageId;

  return (
    <FormModal title={`为「${user?.name}」订阅套餐`} isOpen={opened} onClose={onClose}>
      {opened && (
        <div className="flex flex-col gap-4">
          <p className="text-muted">订阅 / 换购会开启新的计费窗口：历史用量清零，剩余额度按新套餐计算。</p>
          <SelectForm
            label="套餐"
            placeholder="选择套餐"
            options={(packagesQuery.data?.packages ?? []).map((p) => ({
              value: String(p.id),
              label: `${p.name}（${p.traffic_bytes > 0 ? formatBytes(p.traffic_bytes) : "不限量"} / ${p.period_days > 0 ? `${p.period_days} 天` : "永久"}）`,
            }))}
            value={packageId}
            onChange={(v) => setPackageId((v as string | null) ?? null)}
          />
          {switching && <p className="text-sm text-warning">换购不同套餐：当前套餐的剩余流量与有效期将被替换。</p>}
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onPress={onClose}>
              取消
            </Button>
            <SubmitButton isPending={subscribeMutation.isPending} isDisabled={packageId === null}>
              确认订阅
            </SubmitButton>
          </div>
        </div>
      )}
    </FormModal>
  );
}

function UserDetailDialog({
  userId,
  opened,
  onClose,
}: {
  userId: number | null;
  opened: boolean;
  onClose: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: ["user-detail", userId],
    queryFn: () => api.userDetail(userId!),
    enabled: opened && userId !== null,
  });
  const d: UserDetail | undefined = detailQuery.data;
  const total = d?.subscription?.pkg.traffic_bytes ?? 0;
  const remaining = d?.decision.quota?.limit_bytes ?? 0;

  return (
    <FormModal title={`用户详情 · ${d?.user.name ?? "…"}`} isOpen={opened} onClose={onClose} width="sm:max-w-lg">
      {detailQuery.isLoading || !d ? (
        <TableLoading />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted">当前订阅</p>
              {d.subscription ? (
                <p className="mt-1 text-sm">
                  {d.subscription.pkg.name}
                  <DataText className="ml-2 text-muted">
                    {d.subscription.pkg.traffic_bytes > 0 ? formatBytes(d.subscription.pkg.traffic_bytes) : "不限量"}
                    {d.subscription.subscription.expires_at
                      ? ` / 至 ${d.subscription.subscription.expires_at.slice(0, 10)}`
                      : " / 永久"}
                  </DataText>
                </p>
              ) : (
                <StatusChip tone="warning" className="mt-1">
                  无订阅
                </StatusChip>
              )}
            </div>
            <div>
              <p className="text-xs text-muted">转发状态</p>
              {d.decision.stopped ? (
                <StatusChip tone="danger" className="mt-1">
                  已停用（{quotaStopReasonLabel(d.decision.reason).label}）
                </StatusChip>
              ) : (
                <StatusChip tone="success" className="mt-1">
                  正常
                </StatusChip>
              )}
            </div>
          </div>

          {d.decision.quota && total > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-muted">共享流量额度（所有规则共用，按线路倍率计费）</p>
                <DataText>{formatBytes(remaining)} 剩余</DataText>
              </div>
              <ProgressBar value={Math.min(100, (remaining / total) * 100)} color="success">
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
              <p className="mt-1.5 text-xs text-muted">
                窗口 {d.decision.quota.starts_at.slice(0, 16).replace("T", " ")} 起
                {d.decision.quota.expires_at ? `，至 ${d.decision.quota.expires_at.slice(0, 10)}` : "，永久有效"}
              </p>
            </div>
          )}

          <Separator />
          <div>
            <h3 className="mb-2 text-sm font-medium">规则用量（本订阅窗口）</h3>
            {d.rules.length === 0 ? (
              <p className="py-2 text-center text-sm text-muted">该用户暂无规则</p>
            ) : (
              <Table.ScrollContainer>
                <Table className="min-w-[420px]">
                  <Table.Content aria-label="规则用量">
                    <Table.Header>
                      <Table.Column id="rule" isRowHeader>
                        规则
                      </Table.Column>
                      <Table.Column id="used" defaultWidth={140}>
                        <span className="flex justify-end">已用（计费）</span>
                      </Table.Column>
                    </Table.Header>
                    <Table.Body items={d.rules}>
                      {(r) => (
                        <Table.Row id={r.rule_id}>
                          <Table.Cell>
                            {r.rule_name} <DataText className="text-muted">#{r.rule_id}</DataText>
                          </Table.Cell>
                          <Table.Cell>
                            <span className="flex justify-end">
                              <DataText>{formatBytes(Math.max(r.used_bytes, 0))}</DataText>
                            </span>
                          </Table.Cell>
                        </Table.Row>
                      )}
                    </Table.Body>
                  </Table.Content>
                </Table>
              </Table.ScrollContainer>
            )}
          </div>
        </div>
      )}
    </FormModal>
  );
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [creating, setCreating] = useState(searchParams.get("create") === "1");
  const [subscribing, setSubscribing] = useState<UserListItem | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const usersQuery = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const toggleMutation = useMutation({
    mutationFn: (u: UserListItem) =>
      api.updateUser(u.id, { status: u.status === "active" ? UserStatus.DISABLED : UserStatus.ACTIVE }),
    onSuccess: invalidate,
    onError: fail,
  });
  const deleteMutation = useMutation({ mutationFn: api.deleteUser, onSuccess: invalidate, onError: fail });

  const users = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = usersQuery.data?.users ?? [];
    if (!q) return all;
    return all.filter((u) =>
      [String(u.id), u.name, u.note ?? "", u.subscription?.package_name ?? ""].some((field) =>
        field.toLowerCase().includes(q),
      ),
    );
  }, [usersQuery.data, search]);

  return (
    <PageShell>
      <PageHeader
        title="用户列表"
        description="租户及其套餐订阅；配额与线路授权跟随订阅"
        action={
          <Button onPress={() => setCreating(true)}>
            <IconPlus size={16} />
            新建用户
          </Button>
        }
      />
      <ListToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="搜索用户 / 套餐" />
      </ListToolbar>
      {usersQuery.isError ? (
        <TableError onRetry={() => usersQuery.refetch()} />
      ) : usersQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[760px]">
            <Table.Content aria-label="用户列表">
              <Table.Header>
                <Table.Column id="id" defaultWidth={60} isRowHeader>
                  ID
                </Table.Column>
                <Table.Column id="name">名称</Table.Column>
                <Table.Column id="status" defaultWidth={100}>
                  状态
                </Table.Column>
                <Table.Column id="subscription">订阅</Table.Column>
                <Table.Column id="actions" defaultWidth={280}>
                  <span className="flex justify-end">操作</span>
                </Table.Column>
              </Table.Header>
              <Table.Body items={users} renderEmptyState={emptyState(search ? "没有匹配的结果" : "暂无用户")}>
                {(u) => (
                  <Table.Row id={u.id}>
                    <Table.Cell>
                      <DataText>{u.id}</DataText>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-medium">{u.name}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusChip tone={userStatusLabel(u.status).tone}>{userStatusLabel(u.status).label}</StatusChip>
                    </Table.Cell>
                    <Table.Cell>
                      {u.subscription ? (
                        <span className="flex items-center gap-1.5 text-sm">
                          {u.subscription.package_name}
                          {u.subscription.expired && <StatusChip tone="danger">已过期</StatusChip>}
                        </span>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-0.5">
                        <IconAction
                          label="详情"
                          icon={<IconEye size={16} stroke={2} />}
                          onPress={() => setDetailId(u.id)}
                        />
                        <IconAction
                          label="订阅套餐"
                          icon={<IconCreditCard size={16} stroke={2} />}
                          onPress={() => setSubscribing(u)}
                        />
                        {u.status === "active" ? (
                          <IconAction
                            label="禁用"
                            tone="warning"
                            icon={<IconBan size={16} stroke={2} />}
                            onPress={() => toggleMutation.mutate(u)}
                          />
                        ) : (
                          <IconAction
                            label="启用"
                            tone="success"
                            icon={<IconCircleCheck size={16} stroke={2} />}
                            onPress={() => toggleMutation.mutate(u)}
                          />
                        )}
                        <IconAction
                          label="删除"
                          tone="danger"
                          icon={<IconTrash size={16} stroke={2} />}
                          onPress={() =>
                            confirmDanger(
                              "删除用户",
                              "其名下规则将转为无主（不受配额限制），订阅一并删除，确定？",
                              () => deleteMutation.mutate(u.id),
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

      <CreateUserDialog opened={creating} onClose={() => setCreating(false)} />
      <SubscribeDialog user={subscribing} opened={subscribing !== null} onClose={() => setSubscribing(null)} />
      <UserDetailDialog userId={detailId} opened={detailId !== null} onClose={() => setDetailId(null)} />
    </PageShell>
  );
}
