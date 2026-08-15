/**
 * Standalone test of the WsConfigChannel fallback/recovery state machine.
 * No control plane needed: it runs a local Bun WebSocket server that is only
 * started AFTER the channel has fallen back to poll mode.
 *
 * Usage (inside apps/agent):
 *   bun run scripts/test-ws-channel.ts
 *
 * Timeline (reconnect backoff 1s/2s/4s..., probe interval 2s):
 *   t=0,1,3s   connect failures -> 3 within 60s window -> fallback to poll mode
 *   t=5s       local server starts
 *   t~5-7s     probe reconnects -> recovered, mode back to "ws"
 */
import { WsConfigChannel } from "@/services/wsChannel";
import { logger } from "@/utils/logger";

const PORT = 59123;
const PROBE_INTERVAL_MS = 2000;
const TOTAL_MS = 12_000;

const counts = { fallback: 0, recovered: 0, configChanged: 0 };
let server: ReturnType<typeof Bun.serve> | undefined;

const channel = new WsConfigChannel(
  {
    url: `ws://127.0.0.1:${PORT}/api/agent/ws`,
    nodeToken: "test",
    probeIntervalMs: PROBE_INTERVAL_MS,
    pingIntervalMs: 2000,
  },
  {
    onConfigChanged: () => counts.configChanged++,
    onFallback: () => {
      counts.fallback++;
      logger.info("[test] onFallback fired");
    },
    onRecovered: () => {
      counts.recovered++;
      logger.info("[test] onRecovered fired");
    },
  },
);

channel.start();

setTimeout(() => {
  server = Bun.serve({
    port: PORT,
    fetch(request, srv) {
      if (request.headers.get("upgrade") === "websocket") {
        // The returned response is irrelevant once the upgrade hijacks the socket.
        return srv.upgrade(request, { data: undefined })
          ? new Response(null, { status: 101 })
          : new Response("upgrade failed");
      }
      return new Response(null, { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "hello" }));
        // Push a change right after connect so onConfigChanged wiring is covered
        // without waiting for the channel's 30s heartbeat.
        setTimeout(() => ws.send(JSON.stringify({ type: "config_changed" })), 1000);
      },
      message(ws, message) {
        if (message === "ping") {
          ws.send("pong");
        }
      },
    },
  });
  logger.info("[test] server started (channel should recover on next probe)");
}, 5000);

setTimeout(() => {
  const pass =
    counts.fallback >= 1 &&
    counts.recovered >= 1 &&
    counts.configChanged >= 1 &&
    channel.mode === "ws" &&
    channel.connected;
  logger.info("[test] results", {
    counts,
    mode: channel.mode,
    connected: channel.connected,
    verdict: pass ? "PASS" : "FAIL",
  });
  channel.stop();
  server?.stop(true);
  process.exit(pass ? 0 : 1);
}, TOTAL_MS);
