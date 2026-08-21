import { Button } from "@heroui/react";
import { IconCompass } from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { PageHeader, PageShell } from "../ui";

/** 兜底 404：保持在主布局内，提供明确的返回路径而不是空白内容区。 */
export default function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <PageShell>
      <PageHeader title="页面不存在" description="链接可能已过期，或地址输入有误" />
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-16">
        <IconCompass size={30} stroke={1.7} className="text-muted" />
        <p className="text-sm text-muted">要找的页面不在这里，可以回到控制台继续管理节点与隧道</p>
        <Button variant="secondary" onPress={() => navigate("/")}>
          返回控制台
        </Button>
      </div>
    </PageShell>
  );
}
