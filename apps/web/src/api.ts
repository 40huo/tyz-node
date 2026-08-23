import type {
  AdminRuleRow,
  AuditRow,
  Chain,
  ChangePasswordInput,
  CreateChainInput,
  CreateEndpointInput,
  CreateNodeInput,
  CreatePackageInput,
  CreateRuleInput,
  CreateTunnelInput,
  CreateUserInput,
  DashboardSummary,
  DashboardTrafficPoint,
  Endpoint,
  EndpointWithMeta,
  NodeStatsRow,
  NodeTokenResponse,
  NodeWithMeta,
  Package,
  QuotaDecision,
  RelayRule,
  RuleQuotaStatus,
  ServiceHealthRow,
  SetTlsProfileInput,
  SetupInput,
  SetupStatusResponse,
  TlsStatus,
  TunnelWithMeta,
  UpdateChainInput,
  UpdateEndpointInput,
  UpdateNodeInput,
  UpdatePackageInput,
  UpdateRuleInput,
  UpdateTunnelInput,
  UpdateUserInput,
  User,
  UserDetail,
  UserListItem,
  UserSubscription,
} from "@tyz/shared";

export type { AuditRow, QuotaDecision, RuleQuotaStatus, ServiceHealthRow, UserDetail, UserListItem };

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (response.status === 401) {
    if (!path.endsWith("/api/admin/login")) {
      onUnauthorized();
    }
    throw new Error("未登录或会话已过期");
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function jsonBody(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true; username: string }>("/api/admin/login", jsonBody({ username, password })),
  logout: () => request<{ ok: true }>("/api/admin/logout", { method: "POST" }),
  me: () => request<{ username: string }>("/api/admin/me"),
  changePassword: (input: ChangePasswordInput) =>
    request<{ ok: true }>("/api/admin/me/password", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  setupStatus: () => request<SetupStatusResponse>("/api/setup/status"),
  initSetup: (input: SetupInput) => request<{ ok: true; username: string }>("/api/setup", jsonBody(input)),

  listNodes: () => request<{ nodes: NodeWithMeta[] }>("/api/admin/nodes"),
  createNode: (input: CreateNodeInput) =>
    request<{ node: NodeWithMeta; token: string }>("/api/admin/nodes", jsonBody(input)),
  updateNode: (id: number, input: UpdateNodeInput) =>
    request<{ node: NodeWithMeta }>(`/api/admin/nodes/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteNode: (id: number) => request<{ ok: true }>(`/api/admin/nodes/${id}`, { method: "DELETE" }),
  recomputeNode: (id: number) => request<{ ok: true }>(`/api/admin/nodes/${id}/recompute`, { method: "POST" }),
  rotateNodeToken: (id: number) =>
    request<{ id: number; token: string }>(`/api/admin/nodes/${id}/rotate-token`, { method: "POST" }),
  nodeToken: (id: number) => request<NodeTokenResponse>(`/api/admin/nodes/${id}/token`),
  nodeStats: (id: number, limit = 100) =>
    request<{ rows: NodeStatsRow[] }>(`/api/admin/nodes/${id}/stats?limit=${limit}`),

  listTunnels: () => request<{ tunnels: TunnelWithMeta[] }>("/api/admin/tunnels"),
  createTunnel: (input: CreateTunnelInput) =>
    request<{ tunnel: TunnelWithMeta }>("/api/admin/tunnels", jsonBody(input)),
  updateTunnel: (id: number, input: UpdateTunnelInput) =>
    request<{ tunnel: TunnelWithMeta }>(`/api/admin/tunnels/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteTunnel: (id: number) => request<{ ok: true }>(`/api/admin/tunnels/${id}`, { method: "DELETE" }),

  tunnelChains: (tunnelId: number) => request<{ chains: Chain[] }>(`/api/admin/tunnels/${tunnelId}/chains`),
  createChain: (input: CreateChainInput) => request<{ chain: Chain }>("/api/admin/chains", jsonBody(input)),
  updateChain: (id: number, input: UpdateChainInput) =>
    request<{ chain: Chain }>(`/api/admin/chains/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteChain: (id: number) => request<{ ok: true }>(`/api/admin/chains/${id}`, { method: "DELETE" }),

  listRules: () => request<{ rules: AdminRuleRow[] }>("/api/admin/rules"),
  createRule: (input: CreateRuleInput) => request<{ rule: RelayRule }>("/api/admin/rules", jsonBody(input)),
  updateRule: (id: number, input: UpdateRuleInput) =>
    request<{ rule: RelayRule }>(`/api/admin/rules/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteRule: (id: number) => request<{ ok: true }>(`/api/admin/rules/${id}`, { method: "DELETE" }),
  restartRule: (id: number) =>
    request<{ ok: true; nodes: number }>(`/api/admin/rules/${id}/restart`, { method: "POST" }),
  resetRuleTraffic: (id: number) => request<{ ok: true }>(`/api/admin/rules/${id}/reset-traffic`, { method: "POST" }),

  listEndpoints: () => request<{ endpoints: EndpointWithMeta[] }>("/api/admin/endpoints"),
  createEndpoint: (input: CreateEndpointInput) =>
    request<{ endpoint: Endpoint }>("/api/admin/endpoints", jsonBody(input)),
  updateEndpoint: (id: number, input: UpdateEndpointInput) =>
    request<{ endpoint: Endpoint }>(`/api/admin/endpoints/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteEndpoint: (id: number) => request<{ ok: true }>(`/api/admin/endpoints/${id}`, { method: "DELETE" }),

  listUsers: () => request<{ users: UserListItem[] }>("/api/admin/users"),
  createUser: (input: CreateUserInput) => request<{ user: User }>("/api/admin/users", jsonBody(input)),
  updateUser: (id: number, input: UpdateUserInput) =>
    request<{ user: User }>(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteUser: (id: number) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  userDetail: (id: number) => request<UserDetail>(`/api/admin/users/${id}`),
  subscribeUser: (id: number, packageId: number) =>
    request<{ subscription: UserSubscription }>(
      `/api/admin/users/${id}/subscribe`,
      jsonBody({ package_id: packageId }),
    ),

  listPackages: () => request<{ packages: Package[] }>("/api/admin/packages"),
  createPackage: (input: CreatePackageInput) => request<{ package: Package }>("/api/admin/packages", jsonBody(input)),
  updatePackage: (id: number, input: UpdatePackageInput) =>
    request<{ package: Package }>(`/api/admin/packages/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deletePackage: (id: number) => request<{ ok: true }>(`/api/admin/packages/${id}`, { method: "DELETE" }),

  nodeHealth: (id: number) => request<{ rows: ServiceHealthRow[] }>(`/api/admin/nodes/${id}/health`),
  nodeMetrics: (id: number, hours = 24) =>
    request<{
      rows: {
        node_id: number;
        service: string;
        hour_ts: string;
        samples: number;
        conn_sum: number;
        conn_max: number;
      }[];
    }>(`/api/admin/nodes/${id}/metrics?hours=${hours}`),
  listAudit: (limit = 100) => request<{ rows: AuditRow[] }>(`/api/admin/audit?limit=${limit}`),

  dashboardSummary: () => request<DashboardSummary>("/api/admin/dashboard/summary"),
  dashboardTraffic: (hours = 24) =>
    request<{ hours: number; rows: DashboardTrafficPoint[] }>(`/api/admin/dashboard/traffic?hours=${hours}`),

  tlsStatus: () => request<TlsStatus>("/api/admin/tls/status"),
  setTlsDomain: (domain: string) =>
    request<{ ok: true; domain: string; changed: boolean; issued: boolean }>("/api/admin/settings/tls-domain", {
      method: "PUT",
      body: JSON.stringify({ domain }),
    }),
  setTlsProfile: (input: SetTlsProfileInput) =>
    request<{ ok: true; regenerated: "all" | "leaves" | "issued" | "none" }>("/api/admin/settings/tls-profile", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
};
