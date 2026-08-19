import { Card, Chip, Separator } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { PageHeader, PageShell } from "../ui";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export default function ProfilePage() {
  const meQuery = useQuery({ queryKey: ["me"], queryFn: api.me });
  const username = meQuery.data?.username;

  return (
    <PageShell>
      <PageHeader title="个人中心" description="当前登录账户信息" />
      <Card className="mx-auto w-full max-w-md">
        <Card.Content className="flex flex-col items-center gap-2 py-6">
          <div className="flex size-16 items-center justify-center rounded-full bg-accent text-2xl font-bold text-accent-foreground">
            {username ? username.charAt(0).toUpperCase() : "…"}
          </div>
          <p className="mt-1 text-lg font-semibold">{username ?? "…"}</p>
          <Chip color="accent" variant="soft" size="sm">
            <Chip.Label>管理员</Chip.Label>
          </Chip>
        </Card.Content>
        <Separator />
        <Card.Content className="flex flex-col gap-3 text-sm">
          <InfoRow label="用户名" value={username ?? "…"} />
          <InfoRow label="角色" value="管理员（单账户体系）" />
          <InfoRow label="认证方式" value="账号密码（服务端 secrets 配置）" />
          <InfoRow label="会话有效期" value="7 天（HttpOnly Cookie，退出后立即失效）" />
        </Card.Content>
      </Card>
    </PageShell>
  );
}
