import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

/** Typed Drizzle wrapper over the D1 binding; cheap to construct per request. */
export type Database = ReturnType<typeof createDb>;
