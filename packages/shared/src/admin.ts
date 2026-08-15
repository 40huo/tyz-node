import { z } from "zod";
import { type RelayNode, RelayRuleStatus } from "./entities";
import type { GostStatsSample } from "./schemas";
import { chainTypeSchema, limiterConfigSchema, relayRuleStatusSchema, transportSchema } from "./schemas";

// ---- Admin auth ----

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// ---- Node CRUD ----

const tlsConfigInputSchema = z.object({
  commonName: z.string().optional(),
  organization: z.string().optional(),
});

export const createNodeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  address: z.string().min(1),
  display_address: z.string().optional(),
  version: z.string().optional(),
  level: z.number().int().nonnegative().default(0),
  is_public: z.boolean().default(false),
  ports: z
    .string()
    .regex(/^\d+-\d+$/, "ports must look like '10000-20000'")
    .default("10000-20000"),
  traffic_limit: z.number().int().nonnegative().default(0),
  enlarge_scale: z.number().int().nonnegative().default(1),
  custom_cfg: z.unknown().optional(),
  tls_config: tlsConfigInputSchema.optional(),
});
export const updateNodeSchema = createNodeSchema.partial();
export type CreateNodeInput = z.infer<typeof createNodeSchema>;
export type UpdateNodeInput = z.infer<typeof updateNodeSchema>;

/** Node as seen by the admin panel: entity fields + config version + token hint. */
export interface NodeWithMeta extends RelayNode {
  config_version: number | null;
  token_hint: string;
}

/** Returned once on node creation / token rotation. */
export interface NodeToken {
  id: number;
  token: string;
}

// ---- Tunnel CRUD ----

export const createTunnelSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  ingress_display_address: z.string().optional(),
});
export const updateTunnelSchema = createTunnelSchema.partial();
export type CreateTunnelInput = z.infer<typeof createTunnelSchema>;
export type UpdateTunnelInput = z.infer<typeof updateTunnelSchema>;

// ---- Chain CRUD ----

export const createChainSchema = z.object({
  tunnel_id: z.number().int().positive(),
  node_id: z.number().int().positive(),
  chain_type: chainTypeSchema,
  transport: transportSchema,
  index: z.number().int().nonnegative(),
  strategy: z.string().default("round"),
  port: z.number().int().nonnegative().default(0),
});
export const updateChainSchema = createChainSchema.partial();
export type CreateChainInput = z.infer<typeof createChainSchema>;
export type UpdateChainInput = z.infer<typeof updateChainSchema>;

// ---- Relay rule CRUD ----

export const createRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  listen_port: z.number().int().positive(),
  tunnel_id: z.number().int().positive().nullable().optional(),
  targets: z.string().min(1),
  status: relayRuleStatusSchema.default(RelayRuleStatus.CREATED),
  limit: limiterConfigSchema.nullable().optional(),
});
export const updateRuleSchema = createRuleSchema.partial();
export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

// ---- Stats ----

export interface NodeStatsRow {
  id: number;
  service: string;
  stats: GostStatsSample;
  reported_at: string;
}
