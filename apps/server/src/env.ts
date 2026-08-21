export interface Bindings {
  DB: D1Database;
  /** Static assets (the built admin web app). */
  ASSETS: Fetcher;
  /** Per-node Durable Object that holds agent WebSocket push connections. */
  CONFIG_PUSH: DurableObjectNamespace;
  /** Admin login username (secret). */
  ADMIN_USERNAME: string;
  /** Admin login password, plaintext (secret). Preferred over ADMIN_PASSWORD_SHA256. */
  ADMIN_PASSWORD?: string;
  /** Legacy login: sha256(TOKEN_SALT + ":admin:" + password), hex. Only used when ADMIN_PASSWORD is unset. */
  ADMIN_PASSWORD_SHA256?: string;
  /** HMAC key for admin session cookies (secret). Optional — derived from the admin credential when unset. */
  SESSION_SECRET?: string;
  /**
   * Optional salt mixed into node token hashes (`sha256(salt:node:token)`); unset means
   * unsalted `sha256(node:token)`. Node tokens are high-entropy random strings, so an
   * unsalted hash is sufficient. Never change or unset this once nodes exist — it
   * invalidates every stored token hash.
   */
  TOKEN_SALT?: string;
}

export type Variables = {
  node: { id: number; name: string };
};
