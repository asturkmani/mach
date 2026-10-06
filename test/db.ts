import { readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

import { setDb } from "@/lib/db";

const schema = readFileSync(path.resolve(import.meta.dirname, "../db/schema.sql"), "utf8");

/** Points the app's database at a fresh in-memory Postgres with the real schema. */
export async function useTestDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(schema);
  setDb({ query: async (text, params) => (await pg.query(text, params)).rows as never });
  return pg;
}
