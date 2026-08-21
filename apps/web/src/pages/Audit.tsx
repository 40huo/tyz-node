import { ListBox, Select, Table } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import { auditActionLabel } from "../labels";
import {
  emptyState,
  FilterChips,
  ListToolbar,
  Mono,
  PageHeader,
  Pager,
  PageShell,
  SearchInput,
  StatusChip,
  TableError,
  TableLoading,
} from "../ui";

type ActionKind = "all" | "create" | "update" | "delete" | "ops";
type TimeRange = "all" | "today" | "7d" | "30d";

const ACTION_FILTERS: { value: ActionKind; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "create", label: "创建" },
  { value: "update", label: "更新" },
  { value: "delete", label: "删除" },
  { value: "ops", label: "运维" },
];

const TIME_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

function actionKind(action: string): Exclude<ActionKind, "all"> {
  const verb = action.split(".")[1] ?? action;
  if (verb === "create") return "create";
  if (verb === "update") return "update";
  if (verb === "delete") return "delete";
  return "ops";
}

function timeCutoff(range: TimeRange): number {
  if (range === "all") return 0;
  const now = Date.now();
  if (range === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  const days = range === "7d" ? 7 : 30;
  return now - days * 24 * 60 * 60 * 1000;
}

const PAGE_SIZE = 20;

export default function AuditPage() {
  const auditQuery = useQuery({ queryKey: ["audit"], queryFn: () => api.listAudit(200) });
  const [actionFilter, setActionFilter] = useState<ActionKind>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const rows = auditQuery.data?.rows ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = timeCutoff(timeRange);
    return rows.filter((r) => {
      if (actionFilter !== "all" && actionKind(r.action) !== actionFilter) return false;
      if (cutoff > 0 && Date.parse(r.ts) < cutoff) return false;
      if (!q) return true;
      return [r.actor, r.action, r.detail ?? "", r.target_type ?? ""].some((field) => field.toLowerCase().includes(q));
    });
  }, [rows, actionFilter, timeRange, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <PageShell>
      <PageHeader title="操作审计" description="管理端写操作留痕（保留 180 天）；敏感值只记录操作本身" />
      <ListToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="搜索操作者 / 详情" />
        <FilterChips options={ACTION_FILTERS} value={actionFilter} onChange={setActionFilter} />
        <Select
          aria-label="时间范围"
          value={timeRange}
          onChange={(v) => setTimeRange((v as TimeRange) ?? "all")}
          className="w-32"
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox selectionMode="single">
              {TIME_OPTIONS.map((option) => (
                <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </ListToolbar>
      {auditQuery.isError ? (
        <TableError onRetry={() => auditQuery.refetch()} />
      ) : auditQuery.isLoading ? (
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
                <Table.Column id="action" defaultWidth={140}>
                  动作
                </Table.Column>
                <Table.Column id="target" defaultWidth={130}>
                  对象
                </Table.Column>
                <Table.Column id="detail">详情</Table.Column>
              </Table.Header>
              <Table.Body
                items={pageRows}
                renderEmptyState={emptyState(
                  search || actionFilter !== "all" || timeRange !== "all" ? "没有匹配的记录" : "暂无记录",
                )}
              >
                {(r) => (
                  <Table.Row id={r.id}>
                    <Table.Cell>
                      <Mono>{r.ts.replace("T", " ").slice(0, 19)}</Mono>
                    </Table.Cell>
                    <Table.Cell>{r.actor}</Table.Cell>
                    <Table.Cell>
                      <StatusChip tone={auditActionLabel(r.action).tone} title={r.action}>
                        {auditActionLabel(r.action).label}
                      </StatusChip>
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
      <Pager page={safePage} pageCount={pageCount} onChange={setPage} />
    </PageShell>
  );
}
