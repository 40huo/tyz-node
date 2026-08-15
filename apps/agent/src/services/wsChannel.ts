import { logger } from "@/utils/logger";

// Keepalive: probe the connection between (and through) Cloudflare's idle timeouts.
// The edge closes WebSockets idle > 100s (Free/Pro), so the interval is clamped
// below that even if misconfigured. A missed pong is detected at the next tick.
const MAX_PING_INTERVAL_MS = 90_000;
// Reconnect backoff while in ws mode (fallback probes use a fixed interval).
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
// >= FAILURE_THRESHOLD connection failures within FAILURE_WINDOW_MS => poll fallback.
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;

export type ChannelMode = "ws" | "poll";

export interface WsChannelOptions {
  url: string;
  nodeToken: string;
  /** Interval between reconnect probes while in poll fallback. */
  probeIntervalMs: number;
  /** Heartbeat interval; the server auto-responds without waking its Durable Object. */
  pingIntervalMs: number;
}

export interface WsChannelEvents {
  /** A config_changed push arrived; the client should fetch the new config now. */
  onConfigChanged: () => void;
  /** Entered poll fallback after repeated WebSocket failures. */
  onFallback: () => void;
  /** WebSocket reconnected after a fallback period. */
  onRecovered: () => void;
}

/**
 * Config-push channel over a WebSocket to the control plane (GET /api/agent/ws).
 *
 * Prefers the long-lived connection; only the failure tracker and the poll
 * fallback policy live here — fetching/applying configs stays in
 * ControlPlaneClient, triggered via the onConfigChanged callback.
 *
 * Failure policy: 3 failures within a 60s sliding window demote the channel to
 * "poll" mode (the poll loop resumes its normal cadence). While demoted, one
 * probe attempt runs every probeIntervalMs; a successful handshake promotes the
 * channel back to "ws" mode.
 */
export class WsConfigChannel {
  mode: ChannelMode = "ws";
  connected = false;

  private readonly opts: WsChannelOptions;
  private readonly events: WsChannelEvents;

  private stopped = true;
  private ws?: WebSocket;
  private settled = false;
  private reconnectAttempt = 0;
  private failures: number[] = [];
  private pongOutstanding = false;
  private readonly pingIntervalMs: number;
  private reconnectTimer?: Timer;
  private pingTimer?: Timer;

  constructor(opts: WsChannelOptions, events: WsChannelEvents) {
    this.opts = opts;
    this.events = events;
    this.pingIntervalMs = Math.min(opts.pingIntervalMs, MAX_PING_INTERVAL_MS);
  }

  /** True when the WebSocket is connected and the poll loop can idle. */
  get preferWs(): boolean {
    return this.mode === "ws" && this.connected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    logger.info("Starting config push channel", { url: this.opts.url });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, "agent shutdown");
      } catch {
        // already closed
      }
      this.ws = undefined;
    }
    this.connected = false;
    logger.info("Config push channel stopped");
  }

  private connect(): void {
    if (this.stopped) return;

    this.settled = false;
    this.pongOutstanding = false;
    const ws = new WebSocket(this.opts.url, {
      headers: { Authorization: `Bearer ${this.opts.nodeToken}` },
    });
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) return;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      if (this.mode === "poll") {
        this.mode = "ws";
        this.failures = [];
        logger.info("Config push channel recovered, resuming ws mode");
        this.events.onRecovered();
      } else {
        logger.info("Config push channel connected");
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || this.stopped) return;
      const data = typeof event.data === "string" ? event.data : "";
      if (data === "pong") {
        this.pongOutstanding = false;
        return;
      }
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(data) as { type?: string };
      } catch {
        return;
      }
      if (parsed.type === "config_changed") {
        logger.debug("Config change push received");
        this.events.onConfigChanged();
      }
    };

    const onEnded = (reason: string) => {
      if (this.ws !== ws || this.settled) return;
      this.settled = true;
      this.connected = false;
      this.clearTimers();
      if (this.stopped) return;
      this.recordFailure(reason);
      this.scheduleReconnect();
    };

    ws.onclose = (event: CloseEvent) => onEnded(`close ${event.code}`);
    ws.onerror = () => onEnded("error");
  }

  private recordFailure(reason: string): void {
    const now = Date.now();
    this.failures.push(now);
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    logger.warn("Config push channel connection lost", {
      reason,
      failuresInWindow: this.failures.length,
      mode: this.mode,
    });

    if (this.mode === "ws" && this.failures.length >= FAILURE_THRESHOLD) {
      this.mode = "poll";
      this.failures = [];
      logger.warn("Config push channel flapping, falling back to http polling", {
        probeInMs: this.opts.probeIntervalMs,
      });
      this.events.onFallback();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    let delayMs: number;
    if (this.mode === "poll") {
      // Demoted: single probe per interval, no exponential growth.
      delayMs = this.opts.probeIntervalMs;
    } else {
      delayMs = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
      this.reconnectAttempt++;
    }
    logger.info("Reconnecting config push channel", { delayMs, mode: this.mode });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || this.stopped) return;
      if (this.pongOutstanding) {
        logger.warn("Pong timeout on config push channel, closing connection");
        try {
          ws.close(4000, "pong timeout");
        } catch {
          // already closed
        }
        return;
      }
      this.pongOutstanding = true;
      ws.send("ping");
    }, this.pingIntervalMs);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.pongOutstanding = false;
  }
}
