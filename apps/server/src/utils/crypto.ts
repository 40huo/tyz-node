const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Timing-safe string comparison for hex digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Salted single-step SHA-256 for user passwords, stored as
 * `sha256$<salthex>$<hashhex>` in users.password_hash. The scheme prefix keeps
 * the format self-describing so a stronger KDF can replace it later without a
 * data migration. Known trade-off: fast to brute-force offline if the DB leaks
 * — relies on strong passwords (accepted for this single-panel admin model).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomHex(16);
  return `sha256$${salt}$${await sha256Hex(`${salt}:password:${password}`)}`;
}

export async function verifyPasswordHash(stored: string, password: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "sha256" || !salt || !hash) return false;
  return timingSafeEqual(await sha256Hex(`${salt}:password:${password}`), hash);
}
