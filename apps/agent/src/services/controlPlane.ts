import type { AgentConfigResponse, GostStatsSample, NodeConfigData } from "@tyz/shared";
import { WsConfigChannel } from "@/services/wsChannel";
import { logger } from "@/utils/logger";

const MAX_BACKOFF_MS = 5 * 60 * 1000;
// Upper bound so a long control-plane outage cannot grow memory without limit.
const MAX_BUFFERED_STATS = 1000;
// While the WebSocket push channel is healthy, polling is only a safety net.
const SAFETY_POLL_INTERVAL_MS = 5 * 60 * 1000;

interface ControlPlaneOptions {
  baseUrl: string;
  nodeToken: string;
  /** Local API endpoint that applies config updates (own /gost/config/update). */
  apiUrl: string;
  pollIntervalMs: number;
  statsFlushIntervalMs: number;
  wsEnabled: boolean;
  /** WebSocket reconnect probe interval while in http-poll fallback. */
  wsProbeIntervalMs: number;
  /** WebSocket heartbeat interval (server auto-responds without waking). */
  wsPingIntervalMs: number;
}

/**
 * Talks to the Cloudflare control-plane worker:
 * - keeps a WebSocket push channel (GET /api/agent/ws): {"type":"config_changed"}
 *   pushes trigger an immediate config fetch; when the channel flaps, it falls
 *   back to plain HTTP polling until a probe reconnect succeeds;
 * - polls GET /api/agent/config?version=N (304 when unchanged) and forwards
 *   new configs to the local config-update endpoint;
 * - buffers GOST observer stats and uploads them in batches.
 */
export class ControlPlaneClient {
  private configVersion = 0;
  private statsBuffer: GostStatsSample[] = [];
  private pollBackoffMs = 0;
  private running = false;
  private wsChannel?: WsConfigChannel;
  private wakePending = false;
  private wakeResolve?: () => void;
  private flushTimer?: Timer;
  private loopStopped?: Promise<void>;

  constructor(private readonly opts: ControlPlaneOptions) {}

  async start(): Promise<void> {
    logger.info("Starting control plane client", {
      baseUrl: this.opts.baseUrl,
      pollIntervalMs: this.opts.pollIntervalMs,
      statsFlushIntervalMs: this.opts.statsFlushIntervalMs,
      wsEnabled: this.opts.wsEnabled,
    });

    this.running = true;

    if (this.opts.wsEnabled) {
      this.wsChannel = new WsConfigChannel(
        {
          url: wsUrl(this.opts.baseUrl, "/api/agent/ws"),
          nodeToken: this.opts.nodeToken,
          probeIntervalMs: this.opts.wsProbeIntervalMs,
          pingIntervalMs: this.opts.wsPingIntervalMs,
        },
        {
          onConfigChanged: () => this.wake(),
          onFallback: () => this.wake(),
          onRecovered: () => this.wake(),
        },
      );
      this.wsChannel.start();
    }

    this.loopStopped = this.pollLoop();

    this.flushTimer = setInterval(() => {
      this.flushStats().catch((error) => {
        logger.error("Stats flush failed", { error });
      });
    }, this.opts.statsFlushIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wsChannel?.stop();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    this.wake();
    await this.loopStopped;
    // Best-effort final upload of anything still buffered.
    await this.flushStats().catch((error) => {
      logger.error("Final stats flush failed", { error });
    });
    logger.info("Control plane client stopped");
  }

  /** Buffer a stats sample from the GOST observer for the next batched upload. */
  queueStats(stats: GostStatsSample): void {
    if (this.statsBuffer.length >= MAX_BUFFERED_STATS) {
      this.statsBuffer.shift();
    }
    this.statsBuffer.push(stats);
    logger.debug("Stats buffered", {
      service: stats.service,
      buffered: this.statsBuffer.length,
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      let delayMs = this.currentPollIntervalMs();
      try {
        await this.pollOnce();
        this.pollBackoffMs = 0;
      } catch (error) {
        if (this.pollBackoffMs === 0) {
          this.pollBackoffMs = this.opts.pollIntervalMs;
        } else {
          this.pollBackoffMs = Math.min(this.pollBackoffMs * 2, MAX_BACKOFF_MS);
        }
        delayMs = this.pollBackoffMs;
        logger.error("Control plane poll failed, backing off", {
          error,
          retryInMs: delayMs,
        });
      }
      // A push (or a channel mode change) may have arrived while we were busy;
      // consume it and poll again immediately instead of sleeping.
      if (this.wakePending) {
        this.wakePending = false;
        continue;
      }
      await this.sleepInterruptible(delayMs + jitter(delayMs));
      this.wakePending = false;
    }
  }

  /** Polling cadence: rare safety net while the push channel is healthy. */
  private currentPollIntervalMs(): number {
    return this.wsChannel?.preferWs ? SAFETY_POLL_INTERVAL_MS : this.opts.pollIntervalMs;
  }

  /** Wake the poll loop now; the flag keeps wakes that fire mid-poll from being lost. */
  private wake(): void {
    this.wakePending = true;
    this.wakeResolve?.();
    this.wakeResolve = undefined;
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = undefined;
        resolve();
      }, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async pollOnce(): Promise<void> {
    const response = await fetch(`${this.opts.baseUrl}/api/agent/config?version=${this.configVersion}`, {
      headers: { Authorization: `Bearer ${this.opts.nodeToken}` },
    });

    if (response.status === 304) {
      logger.debug("Config unchanged");
      return;
    }
    if (!response.ok) {
      throw new Error(`config poll failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as AgentConfigResponse;
    if (data.version <= this.configVersion) {
      return;
    }

    this.configVersion = data.version;
    await this.applyConfig(data.config);
  }

  private async applyConfig(config: NodeConfigData): Promise<void> {
    logger.info("Applying config update from control plane", {
      nodeId: config.node?.id,
      version: this.configVersion,
      rulesCount: config.rules?.length || 0,
      tunnelsCount: config.tunnels?.length || 0,
      chainsCount: config.chains?.length || 0,
    });

    const response = await fetch(`${this.opts.apiUrl}/gost/config/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(`config apply failed: ${response.status} ${errorData.error || response.statusText}`);
    }
    logger.info("Config update applied", { version: this.configVersion });
  }

  private async flushStats(): Promise<void> {
    if (this.statsBuffer.length === 0) {
      return;
    }

    const samples = this.statsBuffer;
    const response = await fetch(`${this.opts.baseUrl}/api/agent/stats`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.nodeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ samples }),
    });

    if (!response.ok) {
      throw new Error(`stats upload failed: ${response.status} ${response.statusText}`);
    }

    // Keep only samples queued while this request was in flight.
    this.statsBuffer = this.statsBuffer.slice(samples.length);
    logger.debug("Stats uploaded", { count: samples.length });
  }
}

function wsUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/^http/, "ws")}${path}`;
}

function jitter(baseMs: number): number {
  return Math.floor(Math.random() * Math.min(baseMs * 0.25, 5000));
}
