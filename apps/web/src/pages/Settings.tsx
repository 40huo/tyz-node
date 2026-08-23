import { Fieldset, Surface, Table, toast } from "@heroui/react";
import { IconRefresh, IconSettings } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { confirmDanger } from "../confirm";
import { tlsStatusOptions } from "../queries";
import {
  DataText,
  FormShell,
  fail,
  ListToolbar,
  NumberForm,
  PageHeader,
  PageShell,
  SubmitButton,
  TableLoading,
  TextForm,
  ToolbarButton,
} from "../ui";

/** 系统设置各二级页面的内容均尚未有后端支撑，先以规划说明占位（tls 除外）。 */
const SECTIONS = {
  basic: {
    title: "基础设置",
    description: "平台运行参数与默认值配置",
    planned: ["默认传输协议与端口分配策略", "流量统计与计费倍率口径", "节点离线判定与重连阈值"],
  },
  notification: {
    title: "通知设置",
    description: "异常告警与提醒通知渠道",
    planned: ["节点失联 / 服务异常告警", "配额耗尽与订阅到期提醒", "Webhook 通知渠道接入"],
  },
  announcement: {
    title: "公告设置",
    description: "面向用户的公告内容管理",
    planned: ["控制台公告发布与置顶", "维护窗口通知"],
  },
  site: {
    title: "站点设置",
    description: "站点展示信息配置",
    planned: ["站点名称与 Logo", "登录页文案"],
  },
  tls: {
    title: "链路 TLS",
    description: "relay 隧道加密链路的平台证书：统一伪装域名、证书有效期与自动续期",
    planned: [],
  },
} as const;

export type SettingsKind = keyof typeof SECTIONS;

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return iso.replace("T", " ").slice(0, 16);
}

/** 链路 TLS 设置：伪装域名（SNI / 证书 SAN）+ 证书画像 + 平台证书状态。
 * 域名与画像共用一个保存入口：任何会导致证书重签的保存都先经风险确认。 */
interface ProfileDraft {
  ca_common_name: string;
  ca_organization: string;
  ca_validity_days: number;
  leaf_validity_days: number;
}

const FALLBACK_PROFILE: ProfileDraft = {
  ca_common_name: "",
  ca_organization: "",
  ca_validity_days: 3650,
  leaf_validity_days: 365,
};

function TlsSettingsSection() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery(tlsStatusOptions);
  const [domain, setDomain] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (input: { domain: string; profile: ProfileDraft; saveDomain: boolean; saveProfile: boolean }) => {
      // Two independent endpoints, sequential: a failure mid-way surfaces the
      // first error, and the already-applied write is visible in the panel.
      // scope precedence: all > certs > issued > none.
      let scope: "none" | "issued" | "certs" | "all" = "none";
      if (input.saveDomain) {
        const res = await api.setTlsDomain(input.domain);
        if (res.issued) scope = "issued";
        else if (res.changed) scope = "certs";
      }
      if (input.saveProfile) {
        const res = await api.setTlsProfile({
          ca_common_name: input.profile.ca_common_name.trim(),
          ca_organization: input.profile.ca_organization.trim(),
          ca_validity_days: input.profile.ca_validity_days,
          leaf_validity_days: input.profile.leaf_validity_days,
        });
        if (res.regenerated === "all") scope = "all";
        else if (res.regenerated === "leaves") scope = "certs";
        else if (res.regenerated === "issued" && scope === "none") scope = "issued";
      }
      return scope;
    },
    onSuccess: (scope) => {
      toast.success(
        scope === "all"
          ? "设置已保存：整套证书重签完成，配置下发中——TLS 隧道将短暂断连并自动恢复"
          : scope === "certs"
            ? "设置已保存：证书已重签，配置下发中——TLS 隧道将短暂断连并自动恢复"
            : scope === "issued"
              ? "设置已保存：证书已按当前画像生成，启用 TLS 隧道时自动下发到节点"
              : "设置已保存（证书无变化，未重签）",
      );
      queryClient.invalidateQueries({ queryKey: ["tls-status"] });
      setDomain(null);
      setProfileDraft(null);
    },
    onError: fail,
  });

  const status = statusQuery.data;
  const editingValue = domain ?? status?.domain ?? "";
  const editingProfile: ProfileDraft = profileDraft ?? status?.profile ?? FALLBACK_PROFILE;
  const setProfile = (patch: Partial<ProfileDraft>) => setProfileDraft({ ...editingProfile, ...patch });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedDomain = editingValue.trim();
    if (!trimmedDomain) {
      toast.danger("请输入伪装域名，如 relay.example.com");
      return;
    }
    if (!editingProfile.ca_common_name.trim()) {
      toast.danger("CA 通用名称不能为空");
      return;
    }
    if (editingProfile.ca_validity_days < 366 || editingProfile.leaf_validity_days < 30) {
      toast.danger("CA 有效期至少 366 天、叶证书有效期至少 30 天");
      return;
    }
    const domainChanged = trimmedDomain !== (status?.domain ?? "");
    const current = status?.profile;
    const profileChanged =
      current !== undefined &&
      (current.ca_common_name !== editingProfile.ca_common_name.trim() ||
        current.ca_organization !== editingProfile.ca_organization.trim() ||
        current.ca_validity_days !== editingProfile.ca_validity_days ||
        current.leaf_validity_days !== editingProfile.leaf_validity_days);
    // No material yet (status table shows 未生成): always save — the server
    // issues the full set even when the values are unchanged, so the user is
    // never told "nothing to save" while certs are missing.
    const noMaterial = status?.ca_not_after == null;
    if (!domainChanged && !profileChanged && !noMaterial) {
      toast("没有需要保存的变更");
      return;
    }
    const submit = () =>
      saveMutation.mutate({
        domain: trimmedDomain,
        profile: editingProfile,
        saveDomain: domainChanged,
        // Forced profile write on the no-material path so the server issues
        // even when every field matches the stored values.
        saveProfile: profileChanged || noMaterial,
      });
    if (noMaterial) {
      // Nothing is serving yet, so there is nothing to disrupt: skip the risk
      // modal — this save only issues fresh certs.
      submit();
      return;
    }
    // Risk confirmation per regeneration scope: domain → server leaf; CA
    // identity → whole set (new trust anchor); leaf validity → both leaves.
    const caIdentityChanged =
      current !== undefined &&
      (current.ca_common_name !== editingProfile.ca_common_name.trim() ||
        current.ca_organization !== editingProfile.ca_organization.trim() ||
        current.ca_validity_days !== editingProfile.ca_validity_days);
    const scope = caIdentityChanged ? "整套证书（新 CA + 服务端 + 客户端）" : "证书（服务端 / 客户端叶证书）";
    confirmDanger(
      "保存并重签证书？",
      `本次保存将重新生成${scope}，新证书与配置会立即下发到相关节点，TLS 隧道上的当前连接会断开并自动重连；切换期间（数秒）链路可能握手失败。该操作不可撤销。`,
      submit,
    );
  };

  return (
    <PageShell>
      <PageHeader title={SECTIONS.tls.title} description={SECTIONS.tls.description} />
      <ListToolbar>
        <ToolbarButton
          icon={<IconRefresh size={16} stroke={2} />}
          spinning={statusQuery.isFetching}
          onPress={() => statusQuery.refetch()}
        >
          刷新
        </ToolbarButton>
      </ListToolbar>
      <FormShell onSubmit={onSubmit}>
        {/* Surface：官方表单容器形态（bg-surface 抬升一档），控件用 secondary 变体适配表面背景 */}
        <Surface className="p-4 sm:p-5">
          <Fieldset className="flex flex-col gap-4">
            <Fieldset.Legend>域名与证书画像</Fieldset.Legend>
            <TextForm
              label="伪装域名"
              placeholder="如 relay.example.com"
              variant="secondary"
              value={editingValue}
              onChange={(v) => setDomain(v)}
            />
            <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
              <TextForm
                label="CA 通用名称"
                placeholder="如 Example Service CA"
                variant="secondary"
                value={editingProfile.ca_common_name}
                onChange={(v) => setProfile({ ca_common_name: v })}
              />
              <TextForm
                label="CA 组织（O）"
                placeholder="如 example.com，留空省略"
                variant="secondary"
                value={editingProfile.ca_organization}
                onChange={(v) => setProfile({ ca_organization: v })}
              />
              <NumberForm
                label="CA 有效期（天）"
                placeholder="如 3650"
                hint="366–7300"
                variant="secondary"
                value={editingProfile.ca_validity_days}
                onChange={(v) => setProfile({ ca_validity_days: v })}
              />
              <NumberForm
                label="叶证书有效期（天）"
                placeholder="如 365"
                hint="30–1825"
                variant="secondary"
                value={editingProfile.leaf_validity_days}
                onChange={(v) => setProfile({ leaf_validity_days: v })}
              />
            </div>
            <Fieldset.Actions className="justify-end">
              <SubmitButton isPending={saveMutation.isPending}>保存设置</SubmitButton>
            </Fieldset.Actions>
          </Fieldset>
        </Surface>
      </FormShell>

      {statusQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[480px]">
            <Table.Content aria-label="平台证书状态">
              <Table.Header>
                <Table.Column id="kind" isRowHeader>
                  证书
                </Table.Column>
                <Table.Column id="purpose">用途</Table.Column>
                <Table.Column id="not_after">有效期至</Table.Column>
              </Table.Header>
              <Table.Body
                items={[
                  { kind: "CA", purpose: "根证书（签发/验证服务端与客户端证书）", not_after: status?.ca_not_after },
                  {
                    kind: "服务端",
                    purpose: "出口 relay 监听证书（SAN = 伪装域名）",
                    not_after: status?.server_not_after,
                  },
                  { kind: "客户端", purpose: "入口拨号证书（mTLS 双向验证）", not_after: status?.client_not_after },
                ]}
                renderEmptyState={() => (
                  <p className="text-muted p-4 text-sm">尚未生成证书——启用第一个 TLS 隧道时自动生成</p>
                )}
              >
                {(row) => (
                  <Table.Row id={row.kind}>
                    <Table.Cell>
                      <span className="font-medium">{row.kind}</span>
                    </Table.Cell>
                    <Table.Cell>{row.purpose}</Table.Cell>
                    <Table.Cell>
                      {row.not_after ? (
                        <DataText>{formatDate(row.not_after)}</DataText>
                      ) : (
                        <span className="text-muted">未生成</span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table>
        </Table.ScrollContainer>
      )}
      <p className="text-muted text-xs">
        叶证书剩余 30 天内由每日巡检自动续期；CA 剩余 90
        天内整套重签。证书与私钥仅通过节点配置通道下发，不会出现在本页面或审计日志中。
      </p>
    </PageShell>
  );
}

export default function SettingsPage({ kind }: { kind: SettingsKind }) {
  if (kind === "tls") {
    return <TlsSettingsSection />;
  }
  const section = SECTIONS[kind];
  return (
    <PageShell>
      <PageHeader title={section.title} description={section.description} />
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10">
        <IconSettings size={28} stroke={2} className="text-muted" />
        <p className="text-sm text-muted">该模块开发中，暂未开放配置</p>
        <ul className="mt-2 list-disc pl-5 text-xs leading-6 text-muted">
          {section.planned.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </PageShell>
  );
}
