import { Card, Table, toast } from "@heroui/react";
import { IconSettings } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { FormShell, fail, Mono, SubmitButton, TableLoading, TextForm } from "../ui";

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

/** 链路 TLS 设置：伪装域名（SNI / 证书 SAN）+ 平台证书状态。 */
function TlsSettingsSection() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ["tls-status"], queryFn: api.tlsStatus });
  const [domain, setDomain] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: (value: string) => api.setTlsDomain(value),
    onSuccess: (res) => {
      toast.success(`TLS 伪装域名已更新为 ${res.domain}（服务端证书已重签，节点将自动拉取）`);
      queryClient.invalidateQueries({ queryKey: ["tls-status"] });
      setDomain(null);
    },
    onError: fail,
  });

  const status = statusQuery.data;
  const currentValue = status?.domain ?? null;
  const editingValue = domain ?? currentValue ?? "";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = editingValue.trim();
    if (!trimmed) {
      toast.danger("请输入伪装域名，如 relay.example.com");
      return;
    }
    saveMutation.mutate(trimmed);
  };

  return (
    <Card>
      <Card.Header className="pb-2">
        <Card.Title>{SECTIONS.tls.title}</Card.Title>
        <Card.Description>{SECTIONS.tls.description}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <FormShell onSubmit={onSubmit} className="flex flex-col gap-3">
          <TextForm
            label="伪装域名"
            placeholder="如 relay.example.com"
            hint="全平台统一：入口拨号 SNI、出口证书 SAN 与 SNI 白名单都用它；修改后服务端证书自动重签"
            value={editingValue}
            onChange={(v) => setDomain(v)}
          />
          <div className="flex justify-end">
            <SubmitButton isPending={saveMutation.isPending}>保存域名</SubmitButton>
          </div>
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
                          <Mono>{formatDate(row.not_after)}</Mono>
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
      </Card.Content>
    </Card>
  );
}

export default function SettingsPage({ kind }: { kind: SettingsKind }) {
  if (kind === "tls") {
    return <TlsSettingsSection />;
  }
  const section = SECTIONS[kind];
  return (
    <Card>
      <Card.Header className="pb-2">
        <Card.Title>{section.title}</Card.Title>
        <Card.Description>{section.description}</Card.Description>
      </Card.Header>
      <Card.Content>
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10">
          <IconSettings size={28} stroke={1.7} className="text-muted" />
          <p className="text-sm text-muted">该模块开发中，暂未开放配置</p>
          <ul className="mt-2 list-disc pl-5 text-xs leading-6 text-muted">
            {section.planned.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </Card.Content>
    </Card>
  );
}
