/**
 * Domain entity types shared between the control-plane server and node agents.
 * These mirror the D1 (SQLite) schema in apps/server/migrations.
 */

export enum ChainType {
  IN = "in",
  CHAIN = "chain",
  OUT = "out",
}

export enum Transport {
  RAW = "raw",
  WS = "ws",
  TLS = "tls",
  GRPC = "grpc",
  WSS = "wss",
  MTLS = "mtls",
  MWSS = "mwss",
}

export enum RelayRuleStatus {
  CREATED = "created",
  PAUSED = "paused",
  RUNNING = "running",
  ERROR = "error",
}

export enum UserStatus {
  ACTIVE = "active",
  DISABLED = "disabled",
}

export interface RelayNode {
  id: number;
  name: string;
  description?: string;
  address: string;
  display_address?: string;
  level: number;
  is_public: boolean;
  version?: string;
  egress_traffic: number;
  ingress_traffic: number;
  traffic_limit: number;
  enlarge_scale: number;
  /** Traffic billing multiplier: charged bytes = round(real × rate). */
  rate: number;
  ports: string; // e.g., "10000-20000"
  custom_cfg?: unknown; // JSON object
  created_at: string;
  updated_at: string;
}

export interface Tunnel {
  id: number;
  name: string;
  description?: string;
  ingress_display_address?: string; // Optional entry address for IN chain
  created_at: string;
  updated_at: string;
}

export interface Chain {
  id: number;
  tunnel_id: number;
  node_id: number;
  chain_type: ChainType;
  transport: Transport;
  index: number; // Order in the chain
  strategy: string; // Load balancing strategy, e.g., "round"
  port: number; // Listening port (0 if auto-allocated)
  created_at: string;
  updated_at: string;
}

export interface RelayRule {
  id: number;
  name: string;
  description?: string;
  listen_port: number;
  tunnel_id?: number;
  /** Owning tenant; absent for admin-managed rules (no quota enforcement). */
  user_id?: number;
  targets: string; // Target address, e.g., "example.com:80"
  status: RelayRuleStatus;
  limit?: LimiterConfig; // JSON object for limiter configuration
  /** Traffic allowance computed by the control plane at push time. */
  quota?: RuleQuota;
  upload_traffic: number;
  download_traffic: number;
  created_at: string;
  updated_at: string;
}

/**
 * Traffic quota shared by every rule of one owner (GOST quota objects with
 * the same name share a single counter). `limit_bytes` is the REMAINING
 * allowance at computation time; the agent-side quota counts from its own
 * zero at push time, so the gate is pre-push usage (server ledger) +
 * post-push usage (agent counter). `expires_at` omitted = permanent package.
 */
export interface RuleQuota {
  name: string; // quota object name, e.g. quota-user-1
  limit_bytes: number;
  starts_at: string; // subscription activation time, RFC3339
  expires_at?: string; // RFC3339; empty for permanent packages
}

/**
 * Purchasable plan. `traffic_bytes` 0 = unlimited traffic; `period_days` 0 =
 * permanent (never expires); `node_ids`/`tunnel_ids` null = unrestricted
 * access; `max_rules` 0 = unlimited rules.
 */
export interface Package {
  id: number;
  name: string;
  note?: string;
  traffic_bytes: number;
  period_days: number;
  node_ids: number[] | null;
  tunnel_ids: number[] | null;
  max_rules: number;
  created_at: string;
  updated_at: string;
}

/** Tenant owning relay rules; quota and access rights come from the subscription. */
export interface User {
  id: number;
  name: string;
  note?: string;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

/**
 * A user's active subscription (one per user). Switching/renewing a package
 * replaces the row with a fresh `activated_at` — the usage window restarts, so
 * historically used traffic is cleared (换购清零) on both the ledger and the
 * agent-side quota counter (whose restore only matches an identical window).
 * `package_name`/`traffic_bytes` are SNAPSHOTS frozen at subscribe time so
 * history stays interpretable after the package is renamed/edited.
 */
export interface UserSubscription {
  id: number;
  user_id: number;
  package_id: number;
  package_name: string;
  traffic_bytes: number;
  activated_at: string;
  expires_at: string | null; // null = permanent package
  created_at: string;
  updated_at: string;
}

// Limiter configuration types
export interface LimiterConfig {
  traffic?: TrafficLimiter;
  request?: RequestLimiter;
  connection?: ConnectionLimiter;
}

export interface TrafficLimiter {
  service_in?: number; // Service-level incoming traffic limit (bytes/s)
  service_out?: number; // Service-level outgoing traffic limit (bytes/s)
  conn_in?: number; // Connection-level incoming traffic limit (bytes/s)
  conn_out?: number; // Connection-level outgoing traffic limit (bytes/s)
  ips?: Array<{
    ip: string;
    in: number; // Incoming traffic limit for this IP (bytes/s)
    out: number; // Outgoing traffic limit for this IP (bytes/s)
  }>;
}

export interface RequestLimiter {
  service_rate?: number; // Service-level request rate limit (req/s)
  ips?: Array<{
    ip: string;
    rate: number; // Request rate limit for this IP (req/s)
  }>;
}

export interface ConnectionLimiter {
  service_limit?: number; // Service-level connection limit
  ips?: Array<{
    ip: string;
    limit: number; // Connection limit for this IP
  }>;
}

// TLS configuration attached to a node
export interface TlsConfig {
  commonName?: string;
  organization?: string;
}

// Complete node configuration delivered to agents
export interface NodeConfigData {
  node: RelayNode;
  /** Node records for every node the chains reference (incl. the recipient),
   * so agents resolve each hop's dial address from its own node record.
   * Optional: payloads without it fall back to `node` (legacy snapshots). */
  nodes?: RelayNode[];
  rules: RelayRule[];
  tunnels: Tunnel[];
  chains: Chain[];
  tls?: TlsConfig;
}
