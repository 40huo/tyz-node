import { z } from "zod";
import { ChainType, RelayRuleStatus, Transport } from "./entities";

export const chainTypeSchema = z.nativeEnum(ChainType);
export const transportSchema = z.nativeEnum(Transport);
export const relayRuleStatusSchema = z.nativeEnum(RelayRuleStatus);

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
  ports: z.string().regex(/^\d+-\d+$/, "ports must look like '10000-20000'"),
  custom_cfg: z.unknown().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const tunnelSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  ingress_display_address: z.string().optional(),
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
  targets: z.string(),
  status: relayRuleStatusSchema,
  limit: limiterConfigSchema.nullable().optional(),
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

export const agentStatsBatchSchema = z.object({
  samples: z.array(gostStatsSampleSchema).min(1),
});

export type GostStatsSample = z.infer<typeof gostStatsSampleSchema>;
export type AgentStatsBatch = z.infer<typeof agentStatsBatchSchema>;
