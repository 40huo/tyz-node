import { z } from "zod";
import { ChainType, ForwardMode, RelayRuleStatus, Transport, UserStatus } from "./entities";

export const chainTypeSchema = z.nativeEnum(ChainType);
export const transportSchema = z.nativeEnum(Transport);
export const forwardModeSchema = z.nativeEnum(ForwardMode);
export const relayRuleStatusSchema = z.nativeEnum(RelayRuleStatus);
export const userStatusSchema = z.nativeEnum(UserStatus);

const ipTrafficLimitSchema = z.object({
  ip: z.string(),
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
});

export const trafficLimiterSchema = z.object({
  service_in: z.number().nonnegative().optional(),
  service_out: z.number().nonnegative().optional(),
  conn_in: z.number().nonnegative().optional(),
  conn_out: z.number().nonnegative().optional(),
  ips: z.array(ipTrafficLimitSchema).optional(),
});

export const requestLimiterSchema = z.object({
  service_rate: z.number().nonnegative().optional(),
  ips: z
    .object({
      ip: z.string(),
      rate: z.number().nonnegative(),
    })
    .array()
    .optional(),
});

export const connectionLimiterSchema = z.object({
  service_limit: z.number().int().nonnegative().optional(),
  ips: z
    .object({
      ip: z.string(),
      limit: z.number().int().nonnegative(),
    })
    .array()
    .optional(),
});

export const limiterConfigSchema = z
  .object({
    traffic: trafficLimiterSchema.optional(),
    request: requestLimiterSchema.optional(),
    connection: connectionLimiterSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "limit must not be empty" });

export const tlsConfigSchema = z.object({
  commonName: z.string().optional(),
  organization: z.string().optional(),
});

export const tlsMaterialSchema = z.object({
  sni: z.string().min(1),
  ca_cert: z.string().min(1),
  server_cert: z.string().min(1),
  server_key: z.string().min(1),
  client_cert: z.string().min(1),
  client_key: z.string().min(1),
});

// ---- Agent-facing payloads (config delivered to a node) ----

export const relayNodePayloadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  address: z.string(),
  display_address: z.string().optional(),
  level: z.number().int(),
  is_public: z.boolean(),
  version: z.string().optional(),
  egress_traffic: z.number().nonnegative(),
  ingress_traffic: z.number().nonnegative(),
  traffic_limit: z.number().nonnegative(),
  enlarge_scale: z.number().nonnegative(),
  rate: z.number().min(0.1).max(100).default(1),
  ports: z.string().regex(/^\d+-\d+$/, "ports must look like '10000-20000'"),
  custom_cfg: z.unknown().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

// The agent payload carries relay_auth_user/relay_auth_pass on top of the
// admin-visible Tunnel entity (the builder needs them for the relay protocol
// AuthConfig). New fields are optional: legacy cached payloads lack them.
export const tunnelSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  ingress_display_address: z.string().optional(),
  forward_mode: forwardModeSchema.optional(),
  tls_enabled: z.boolean().optional(),
  relay_auth_user: z.string().optional(),
  relay_auth_pass: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const chainSchema = z.object({
  id: z.number().int(),
  tunnel_id: z.number().int(),
  node_id: z.number().int(),
  chain_type: chainTypeSchema,
  transport: transportSchema,
  index: z.number().int().nonnegative(),
  strategy: z.string(),
  port: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const relayRuleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  listen_port: z.number().int().positive(),
  tunnel_id: z.number().int().positive().optional(),
  user_id: z.number().int().positive().optional(),
  /** Present when the rule targets a stored endpoint; the Go side ignores it (targets is authoritative). */
  endpoint_id: z.number().int().positive().optional(),
  targets: z.string(),
  status: relayRuleStatusSchema,
  exit_port: z.number().int().min(0).max(65535).optional(),
  limit: limiterConfigSchema.nullable().optional(),
  quota: z
    .object({
      name: z.string().min(1),
      limit_bytes: z.number().int().positive(),
      starts_at: z.string(),
      expires_at: z.string().optional(),
    })
    .optional(),
  upload_traffic: z.number().nonnegative(),
  download_traffic: z.number().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const nodeConfigDataSchema = z.object({
  node: relayNodePayloadSchema,
  nodes: z.array(relayNodePayloadSchema).optional(),
  rules: z.array(relayRuleSchema),
  tunnels: z.array(tunnelSchema),
  chains: z.array(chainSchema),
  tls: tlsConfigSchema.optional(),
  tls_material: tlsMaterialSchema.optional(),
});

// ---- Agent stats reporting ----
//
// GOST v3 observers POST an envelope {"events":[...]} where each event is a
// status change or (with enableStats on the service) a periodic stats report.
// We only forward stats events to the control plane, flattened into samples.

const gostStatsSampleSchema = z.object({
  service: z.string(),
  client: z.string().optional(), // handler-level (per-client) stats only
  totalConns: z.number().int().nonnegative(),
  currentConns: z.number().int().nonnegative(),
  inputBytes: z.number().nonnegative(),
  outputBytes: z.number().nonnegative(),
  totalErrs: z.number().int().nonnegative(),
});

// The agent additionally reports the runtime state of every managed GOST
// service with each stats flush (x/service.State: running|ready|failed|closed).

const serviceHealthSampleSchema = z.object({
  service: z.string(),
  state: z.string(),
  error: z.string().optional(),
});

export const agentStatsBatchSchema = z
  .object({
    samples: z.array(gostStatsSampleSchema).default([]),
    health: z.array(serviceHealthSampleSchema).default([]),
  })
  .refine((v) => v.samples.length > 0 || v.health.length > 0, {
    message: "batch must carry samples or health",
  });

export type GostStatsSample = z.infer<typeof gostStatsSampleSchema>;
export type ServiceHealthSample = z.infer<typeof serviceHealthSampleSchema>;
export type AgentStatsBatch = z.infer<typeof agentStatsBatchSchema>;
