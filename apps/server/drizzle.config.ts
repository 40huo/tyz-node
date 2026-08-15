import { defineConfig } from "drizzle-kit";

/**
 * Schema-change workflow (existing migrations stay in migrations/, applied by
 * wrangler — drizzle-kit is only the generator):
 *
 *   bunx drizzle-kit generate   # writes SQL to ./drizzle after schema.ts edits
 *   # copy the generated .sql into migrations/000N_name.sql, then:
 *   bunx wrangler d1 migrations apply DB --local
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
