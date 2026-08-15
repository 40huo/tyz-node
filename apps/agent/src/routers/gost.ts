import type { GostStatsSample, NodeConfigData } from "@tyz/shared";
import { Hono } from "hono";
import { ControlPlaneClient } from "@/services/controlPlane";
import { generateGostConfig } from "@/services/gost/builder";
import { GostClient } from "@/services/gost/client";
import { loadConfig } from "@/utils/config";
import { logger } from "@/utils/logger";

// Load configuration
const config = loadConfig();

// Build API URL for internal communication
const apiUrl = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;

const gostClient = new GostClient(config.gostApiUrl, config.gostApiAuth);
const controlPlane = new ControlPlaneClient({
  baseUrl: config.controlPlaneUrl,
  nodeToken: config.nodeToken,
  apiUrl,
  pollIntervalMs: config.pollIntervalMs,
  statsFlushIntervalMs: config.statsFlushIntervalMs,
  wsEnabled: config.wsEnabled,
  wsProbeIntervalMs: config.wsProbeIntervalMs,
  wsPingIntervalMs: config.wsPingIntervalMs,
});

const gostRouter = new Hono();

// Config update endpoint - converts control-plane config to GOST format and applies it
gostRouter.post("/config/update", async (c) => {
  try {
    const configData: NodeConfigData = await c.req.json();

    // Validate config data structure
    if (!configData.node || !configData.rules) {
      return c.json({ ok: false, error: "Invalid config data: missing node or rules" }, 400);
    }

    logger.info("Processing config update via API", {
      nodeId: configData.node.id,
      rulesCount: configData.rules.length,
      tunnelsCount: configData.tunnels?.length || 0,
      chainsCount: configData.chains?.length || 0,
    });

    // Generate GOST configuration from control-plane data
    const gostConfig = generateGostConfig(configData);

    logger.debug("GOST config generated", {
      servicesCount: gostConfig.services?.length || 0,
      chainsCount: gostConfig.chains?.length || 0,
      limitersCount:
        (gostConfig.limiters?.length || 0) + (gostConfig.rlimiters?.length || 0) + (gostConfig.climiters?.length || 0),
    });

    // Apply GOST configuration
    await gostClient.updateConfig(gostConfig);

    logger.info("GOST config applied successfully via API");
    return c.json({ ok: true });
  } catch (error) {
    logger.error("Error updating config via API", { error });
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// GOST Observer endpoint - receives event envelopes from GOST and buffers
// stats events for batched upload to the control plane
gostRouter.post("/observer", async (c) => {
  try {
    const raw = await c.req.text();
    logger.debug("Raw observer payload", { raw });

    const payload = JSON.parse(raw) as {
      events?: Array<{
        kind: string;
        service: string;
        client?: string;
        type: string;
        stats?: {
          totalConns: number;
          currentConns: number;
          inputBytes: number;
          outputBytes: number;
          totalErrs: number;
        };
      }>;
    };

    for (const event of payload.events ?? []) {
      if (event.type !== "stats" || !event.stats) {
        continue;
      }
      const sample: GostStatsSample = {
        service: event.service,
        client: event.client,
        ...event.stats,
      };
      logger.debug("Stats event received", sample);
      controlPlane.queueStats(sample);
    }

    return c.json({ ok: true });
  } catch (error) {
    logger.error("Error processing observer stats", { error });
    return c.json({ ok: false });
  }
});

export { controlPlane };
export default gostRouter;
