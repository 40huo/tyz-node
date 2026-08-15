/**
 * Load and validate environment configuration
 */
interface Config {
  // Server
  port: number;
  host: string;

  // GOST
  gostApiUrl: string;
  gostApiAuth?: string;

  // Control plane
  controlPlaneUrl: string;
  nodeToken: string;
  pollIntervalMs: number;
  statsFlushIntervalMs: number;
  wsEnabled: boolean;
  wsProbeIntervalMs: number;
  wsPingIntervalMs: number;
}

export function loadConfig(): Config {
  const requiredEnvVars = ["CONTROL_PLANE_URL", "NODE_TOKEN"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  return {
    port: parseInt(process.env.PORT || "18090", 10),
    host: process.env.HOST || "127.0.0.1",

    gostApiUrl: process.env.GOST_API_URL || "http://localhost:18080",
    gostApiAuth: process.env.GOST_API_AUTH,

    controlPlaneUrl: process.env.CONTROL_PLANE_URL!.replace(/\/$/, ""),
    nodeToken: process.env.NODE_TOKEN!,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "10000", 10),
    statsFlushIntervalMs: parseInt(process.env.STATS_FLUSH_INTERVAL_MS || "60000", 10),
    wsEnabled: (process.env.WS_ENABLED || "true").toLowerCase() !== "false",
    wsProbeIntervalMs: parseInt(process.env.WS_PROBE_INTERVAL_MS || "60000", 10),
    wsPingIntervalMs: parseInt(process.env.WS_PING_INTERVAL_MS || "60000", 10),
  };
}
