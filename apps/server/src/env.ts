export interface Bindings {
  DB: D1Database;
  /** Static assets (the built admin web app). */
  ASSETS: Fetcher;
  /** Per-node Durable Object that holds agent WebSocket push connections. */
  CONFIG_PUSH: DurableObjectNamespace;
  /** Admin login username (secret). */
  ADMIN_USERNAME: string;
  /** sha256(TOKEN_SALT + "admin:" + password), hex. Generate with scripts/hash-password.ts. */
  ADMIN_PASSWORD_SHA256: string;
  /** HMAC key for admin session cookies (secret). */
  SESSION_SECRET: string;
  /** Salt mixed into node token hashes and the admin password hash (secret). */
  TOKEN_SALT: string;
}

export type Variables = {
  node: { id: number; name: string };
};
