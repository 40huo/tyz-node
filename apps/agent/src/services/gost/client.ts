import type { GostConfig } from "../../types/gost";
import { logger } from "../../utils/logger";

/** GOST API object kinds managed by updateConfig, ordered bottom-up for creation. */
const MANAGED_KINDS = ["limiters", "rlimiters", "climiters", "chains", "services"] as const;

type ManagedKind = (typeof MANAGED_KINDS)[number];

interface ApiListResponse {
  data?: { count?: number; list?: Array<{ name?: string }> | null };
}

export class GostClient {
  private baseUrl: string;
  private authHeader?: string;

  constructor(baseUrl: string, auth?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    if (auth) {
      this.authHeader = `Basic ${btoa(auth)}`;
    }
  }

  /**
   * Get current GOST configuration
   */
  async getConfig(): Promise<GostConfig> {
    try {
      const response = await fetch(`${this.baseUrl}/api/config`, {
        method: "GET",
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`GOST API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as GostConfig;
    } catch (error) {
      logger.error("Failed to get GOST config", { error });
      throw error;
    }
  }

  /**
   * Update GOST configuration through the per-object config API.
   *
   * GOST v3 semantics (verified against v3.2.6): POST /api/config persists the
   * in-memory config to disk and POST /api/config/reload re-reads the startup
   * file — neither applies a pushed config body. Dynamic configuration is done
   * via per-object CRUD under /api/config/{kind}[/{name}], which takes effect
   * immediately. We therefore diff the desired objects against the running
   * ones: delete removed, update changed (PUT restarts the object), create
   * new, and leave untouched objects alone.
   *
   * Note: the global TLS defaults section of the generated config has no API
   * counterpart; it belongs in the static on-disk gost.json of the node.
   */
  async updateConfig(config: GostConfig): Promise<void> {
    try {
      const desired: Record<ManagedKind, Map<string, unknown>> = {
        limiters: this.toNameMap(config.limiters),
        rlimiters: this.toNameMap(config.rlimiters),
        climiters: this.toNameMap(config.climiters),
        chains: this.toNameMap(config.chains),
        services: this.toNameMap(config.services),
      };

      // Delete phase: services first (top-down) so references disappear before
      // the objects they reference are removed.
      for (const kind of [...MANAGED_KINDS].reverse()) {
        const current = await this.listNames(kind);
        for (const name of current) {
          if (!desired[kind].has(name)) {
            await this.request("DELETE", `/api/config/${kind}/${encodeURIComponent(name)}`);
            logger.debug("GOST object deleted", { kind, name });
          }
        }
      }

      // Create/update phase: bottom-up so dependencies exist before use.
      for (const kind of MANAGED_KINDS) {
        const current = await this.listObjects(kind);
        for (const [name, object] of desired[kind]) {
          const existing = current.get(name);
          if (existing === undefined) {
            await this.request("POST", `/api/config/${kind}`, object);
            logger.debug("GOST object created", { kind, name });
          } else if (JSON.stringify(existing) !== JSON.stringify(object)) {
            await this.request("PUT", `/api/config/${kind}/${encodeURIComponent(name)}`, object);
            logger.debug("GOST object updated", { kind, name });
          }
        }
      }

      logger.info("GOST config synced successfully");
    } catch (error) {
      logger.error("Failed to update GOST config", { error });
      throw error;
    }
  }

  private toNameMap(objects: unknown[] | undefined): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const object of objects ?? []) {
      const name = (object as { name?: string }).name;
      if (name !== undefined) {
        map.set(name, object);
      }
    }
    return map;
  }

  private async listObjects(kind: ManagedKind): Promise<Map<string, unknown>> {
    const response = await this.request("GET", `/api/config/${kind}`);
    if (response.status === 404) {
      return new Map();
    }
    const body = (await response.json()) as ApiListResponse;
    const map = new Map<string, unknown>();
    for (const object of body.data?.list ?? []) {
      const name = (object as { name?: string }).name;
      if (name !== undefined) {
        map.set(name, object);
      }
    }
    return map;
  }

  private async listNames(kind: ManagedKind): Promise<string[]> {
    return [...(await this.listObjects(kind)).keys()];
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.getHeaders(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GOST API ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return response;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    return headers;
  }
}
