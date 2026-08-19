import type { Bindings } from "../env";

/**
 * Tell the affected nodes' NodePushDO instances that their config snapshot was
 * recomputed. The DO broadcasts to any live agent WebSockets; agents then
 * re-fetch via GET /api/agent/config (which keeps the 304 dedup semantics).
 *
 * Fire-and-forget by design: a failing DO call (or an offline agent, which
 * simply has zero live sockets) must never fail the admin write.
 */
export async function notifyConfigChanged(env: Bindings, nodeIds: number[]): Promise<void> {
  await broadcastNodeMessage(env, nodeIds, { type: "config_changed" });
}

/** Broadcast an arbitrary message object to the nodes' live agent sockets. */
export async function broadcastNodeMessage(
  env: Bindings,
  nodeIds: number[],
  message: Record<string, unknown>,
): Promise<void> {
  if (nodeIds.length === 0) return;

  await Promise.allSettled(
    nodeIds.map(async (nodeId) => {
      const stub = env.CONFIG_PUSH.get(env.CONFIG_PUSH.idFromName(String(nodeId)));
      const response = await stub.fetch(
        new Request("https://do/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        }),
      );
      if (!response.ok) {
        throw new Error(`notify node ${nodeId} failed: ${response.status}`);
      }
    }),
  );
}
