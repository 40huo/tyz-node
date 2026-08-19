import { Chip, Table } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { emptyState, Mono, PageHeader, PageShell, TableLoading } from "../ui";

const ACTION_COLOR: Record<string, "default" | "accent" | "success" | "warning" | "danger"> = {
  create: "success",
  update: "accent",
  delete: "danger",
  subscribe: "accent",
  restart: "warning",
  rotate: "warning",
};

function actionColor(action: string) {
  const kind = Object.keys(ACTION_COLOR).find((k) => action.includes(k));
  return ACTION_COLOR[kind ?? ""] ?? "default";
}

export default function AuditPage() {
  const auditQuery = useQuery({ queryKey: ["audit"], queryFn: () => api.listAudit(200) });
  const rows = auditQuery.data?.rows ?? [];

  return (
    <PageShell>
      <PageHeader title="操作审计" description="管理端写操作留痕（保留 180 天）；敏感值只记录操作本身" />
      {auditQuery.isLoading ? (
        <TableLoading />
      ) : (
        <Table.ScrollContainer>
          <Table className="min-w-[720px]">
            <Table.Content aria-label="操作审计">
              <Table.Header>
                <Table.Column id="ts" defaultWidth={170}>
                  时间
                </Table.Column>
                <Table.Column id="actor" defaultWidth={100}>
                  操作者
                </Table.Column>
                <Table.Column id="action" defaultWidth={120}>
                  动作
                </Table.Column>
                <Table.Column id="target" defaultWidth={130}>
                  对象
                </Table.Column>
                <Table.Column id="detail">详情</Table.Column>
              </Table.Header>
              <Table.Body items={rows} renderEmptyState={emptyState("暂无记录")}>
                {(r) => (
                  <Table.Row id={r.id}>
                    <Table.Cell>
                      <Mono>{r.ts.replace("T", " ").slice(0, 19)}</Mono>
                    </Table.Cell>
                    <Table.Cell>{r.actor}</Table.Cell>
                    <Table.Cell>
                      <Chip color={actionColor(r.action)} variant="soft" size="sm">
                        <Chip.Label>{r.action}</Chip.Label>
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      {r.target_type ? (
                        <Mono>
                          {r.target_type} #{r.target_id}
                        </Mono>
                      ) : (
                        "-"
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <span className="text-muted">{r.detail || "-"}</span>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table>
        </Table.ScrollContainer>
      )}
    </PageShell>
  );
}
