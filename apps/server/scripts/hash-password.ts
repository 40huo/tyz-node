/**
 * Generate the ADMIN_PASSWORD_SHA256 secret value:
 *   bun run scripts/hash-password.ts <TOKEN_SALT> <password>
 */
const [salt, password] = process.argv.slice(2);
if (!salt || !password) {
  console.error("Usage: bun run scripts/hash-password.ts <TOKEN_SALT> <password>");
  process.exit(1);
}
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:admin:${password}`));
console.log([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
