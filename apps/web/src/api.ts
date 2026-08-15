import type {
  Chain,
  CreateChainInput,
  CreateNodeInput,
  CreateRuleInput,
  CreateTunnelInput,
  NodeStatsRow,
  NodeWithMeta,
  RelayRule,
  Tunnel,
  UpdateChainInput,
  UpdateNodeInput,
  UpdateRuleInput,
  UpdateTunnelInput,
} from "@tyz/shared";

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
  nodeStats: (id: number, limit = 100) =>
    request<{ rows: NodeStatsRow[] }>(`/api/admin/nodes/${id}/stats?limit=${limit}`),

  listTunnels: () => request<{ tunnels: Tunnel[] }>("/api/admin/tunnels"),
  createTunnel: (input: CreateTunnelInput) => request<{ tunnel: Tunnel }>("/api/admin/tunnels", jsonBody(input)),
  updateTunnel: (id: number, input: UpdateTunnelInput) =>
    request<{ tunnel: Tunnel }>(`/api/admin/tunnels/${id}`, {
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

  listRules: () => request<{ rules: RelayRule[] }>("/api/admin/rules"),
  createRule: (input: CreateRuleInput) => request<{ rule: RelayRule }>("/api/admin/rules", jsonBody(input)),
  updateRule: (id: number, input: UpdateRuleInput) =>
    request<{ rule: RelayRule }>(`/api/admin/rules/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteRule: (id: number) => request<{ ok: true }>(`/api/admin/rules/${id}`, { method: "DELETE" }),
};
