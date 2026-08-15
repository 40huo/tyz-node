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
  targets: string; // Target address, e.g., "example.com:80"
  status: RelayRuleStatus;
  limit?: LimiterConfig; // JSON object for limiter configuration
  upload_traffic: number;
  download_traffic: number;
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
