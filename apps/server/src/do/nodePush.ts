import type { Bindings } from "../env";

/**
 * Per-node Durable Object holding the agent WebSocket connections for one node.
 *
 * Uses the WebSocket Hibernation API: accepted sockets are managed by the
 * runtime (no persistent timers/memory while idle), and `state.getWebSockets()`
 * returns the live sockets even after the DO was evicted between messages.
 *
 * Protocol (server -> agent):
 *   {"type":"hello"}              on connect
 *   {"type":"config_changed"}     broadcast after an admin write recomputed this node
 *   {"type":"restart_service",
 *    "service":"service-5"}       broadcast by the manual rule-restart endpoint;
 *                                 the agent rebuilds that one service from its
 *                                 last applied config (dropping live connections)
 * Protocol (agent -> server):
 *   "ping"  ->  "pong"            keepalive, answered by the runtime at the edge
 *                                 via setWebSocketAutoResponse — the hibernated DO
 *                                 is never woken for heartbeats
 */
export class NodePushDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Bindings,
  ) {
    // Answer "ping" with "pong" without waking this object: zero duration cost
    // for heartbeats, and outbound messages are not billed as requests.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/notify" && request.method === "POST") {
      // The body may carry a custom message object (e.g. a restart_service
      // directive); an empty body defaults to the config_changed broadcast.
      const message = await request.json().catch(() => null);
      const payload =
        message && typeof message === "object" && "type" in message
          ? JSON.stringify(message)
          : JSON.stringify({ type: "config_changed" });
      let notified = 0;
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(payload);
          notified++;
        } catch {
          // Socket died before eviction caught up; the agent's heartbeat will
          // drive its own reconnect.
        }
      }
      return Response.json({ notified });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "hello" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // No webSocketMessage handler: "ping" is auto-responded by the runtime (see
  // constructor) and the agent sends nothing else today, so there is nothing to
  // do on incoming messages.

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
