export interface Bindings {
  DB: D1Database;
  /** Static assets (the built admin web app). */
  ASSETS: Fetcher;
  /** Per-node Durable Object that holds agent WebSocket push connections. */
  CONFIG_PUSH: DurableObjectNamespace;
  /**
   * HMAC key for admin session cookies (secret). Optional — when unset the random
   * secret that /setup generates and stores in app_settings is used instead.
   */
  SESSION_SECRET?: string;
}

export type Variables = {
  node: { id: number; name: string };
  /** Admin username from the verified session cookie (set by adminAuth). */
  adminName: string;
};
