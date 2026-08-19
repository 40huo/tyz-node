import { Card } from "@heroui/react";
import { IconSettings } from "@tabler/icons-react";

/** 系统设置各二级页面的内容均尚未有后端支撑，先以规划说明占位。 */
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
} as const;

export type SettingsKind = keyof typeof SECTIONS;

export default function SettingsPage({ kind }: { kind: SettingsKind }) {
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
