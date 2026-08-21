import { ChainType, ForwardMode } from "@tyz/shared";

/** Chip 语义色（HeroUI color 枚举的子集，全站状态展示统一走这里）。 */
export type Tone = "default" | "accent" | "success" | "warning" | "danger";

export interface LabelInfo {
  label: string;
  tone: Tone;
}

const withFallback =
  (map: Record<string, LabelInfo>) =>
  (key: string | null | undefined): LabelInfo =>
    map[key ?? ""] ?? { label: key ?? "-", tone: "default" };

/** 规则状态（relay_rules.status）。 */
export const ruleStatusLabel = withFallback({
  created: { label: "已创建", tone: "default" },
  paused: { label: "已暂停", tone: "warning" },
  running: { label: "运行中", tone: "success" },
  error: { label: "错误", tone: "danger" },
});

/** 服务健康状态（service_health.state，agent 上报）。 */
export const serviceStateLabel = withFallback({
  ready: { label: "就绪", tone: "success" },
  running: { label: "运行中", tone: "accent" },
  failed: { label: "失败", tone: "danger" },
  closed: { label: "已关闭", tone: "default" },
  apply_failed: { label: "下发失败", tone: "danger" },
  unknown: { label: "未知", tone: "default" },
});

/** 链路类型（chains.chain_type）。 */
export const chainTypeLabel = withFallback({
  [ChainType.IN]: { label: "入口", tone: "success" },
  [ChainType.CHAIN]: { label: "中继", tone: "accent" },
  [ChainType.OUT]: { label: "出口", tone: "danger" },
});

/** 用户状态（users.status）。 */
export const userStatusLabel = withFallback({
  active: { label: "正常", tone: "success" },
  disabled: { label: "已禁用", tone: "default" },
});

/** 配额硬停原因（QuotaDecision.reason）——规则列表与用户详情共用。 */
export const quotaStopReasonLabel = withFallback({
  user_disabled: { label: "用户已禁用", tone: "danger" },
  no_subscription: { label: "无有效订阅", tone: "warning" },
  expired: { label: "订阅已过期", tone: "warning" },
  exhausted: { label: "流量已耗尽", tone: "danger" },
});

/** 隧道转发模式。 */
export const forwardModeLabel = withFallback({
  [ForwardMode.RELAY]: { label: "relay 复用", tone: "default" },
  [ForwardMode.RAW]: { label: "裸转发", tone: "accent" },
});

/** 审计动作（`entity.verb` 或独立动作名）→ 中文 + 语义色。 */
const AUDIT_VERBS: Record<string, LabelInfo> = {
  create: { label: "创建", tone: "success" },
  update: { label: "更新", tone: "accent" },
  delete: { label: "删除", tone: "danger" },
  restart: { label: "重启", tone: "warning" },
  rotate_token: { label: "轮换令牌", tone: "warning" },
};

const AUDIT_ENTITIES: Record<string, string> = {
  node: "节点",
  tunnel: "隧道",
  chain: "链路",
  rule: "规则",
  user: "用户",
  package: "套餐",
};

/** 不符合 entity.verb 组合习惯的完整动作名单独定义。 */
const AUDIT_ACTION_OVERRIDES: Record<string, LabelInfo> = {
  subscribe: { label: "订阅套餐", tone: "accent" },
  "settings.tls_domain": { label: "TLS 域名设置", tone: "accent" },
};

export function auditActionLabel(action: string): LabelInfo {
  const override = AUDIT_ACTION_OVERRIDES[action];
  if (override) return override;
  const [entity, verb] = action.split(".");
  const info = verb !== undefined ? AUDIT_VERBS[verb] : undefined;
  const entityLabel = entity !== undefined ? (AUDIT_ENTITIES[entity] ?? entity) : undefined;
  if (info && entityLabel) return { label: `${entityLabel}${info.label}`, tone: info.tone };
  return { label: action, tone: "default" };
}
