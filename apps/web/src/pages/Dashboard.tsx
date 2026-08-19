import { Card } from "@heroui/react";
import { IconArrowsExchange, IconNetwork, IconServer, IconUsers } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { PageHeader, PageShell } from "../ui";

function StatCard({
  to,
  icon,
  label,
  value,
  hint,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  value?: number;
  hint?: string;
}) {
  return (
    <Link to={to} className="group block">
      <Card className="transition-colors group-hover:border-accent">
        <Card.Content className="flex items-center gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
            {icon}
          </div>
          <div className="min-w-0">
            <p className="text-sm text-muted">{label}</p>
            <p className="text-2xl font-semibold leading-tight tabular-nums">{value === undefined ? "…" : value}</p>
            {hint && <p className="text-xs text-muted">{hint}</p>}
          </div>
        </Card.Content>
      </Card>
    </Link>
  );
}

export default function DashboardPage() {
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
  const tunnelsQuery = useQuery({ queryKey: ["tunnels"], queryFn: api.listTunnels });
  const rulesQuery = useQuery({ queryKey: ["rules"], queryFn: api.listRules });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: api.listUsers });

  const nodes = nodesQuery.data?.nodes;
  const tunnels = tunnelsQuery.data?.tunnels;
  const rules = rulesQuery.data?.rules;
  const users = usersQuery.data?.users;

  return (
    <PageShell>
      <PageHeader title="控制台" description="平台资源总览，点击卡片进入对应管理页" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          to="/users"
          icon={<IconUsers size={22} stroke={1.7} />}
          label="用户数量"
          value={users?.length}
          hint={users ? `${users.filter((u) => u.status === "active").length} 个启用` : undefined}
        />
        <StatCard
          to="/rules"
          icon={<IconArrowsExchange size={22} stroke={1.7} />}
          label="规则数量"
          value={rules?.length}
          hint={rules ? `${rules.filter((r) => r.status === "running").length} 条运行中` : undefined}
        />
        <StatCard
          to="/nodes"
          icon={<IconServer size={22} stroke={1.7} />}
          label="节点数量"
          value={nodes?.length}
          hint={nodes ? `${nodes.filter((n) => n.is_public).length} 个公开` : undefined}
        />
        <StatCard
          to="/tunnels"
          icon={<IconNetwork size={22} stroke={1.7} />}
          label="隧道数量"
          value={tunnels?.length}
          hint={tunnels && rules ? `${rules.filter((r) => r.tunnel_id).length} 条规则挂载` : undefined}
        />
      </div>
    </PageShell>
  );
}
