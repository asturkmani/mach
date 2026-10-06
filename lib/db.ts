import "server-only";

import { neon } from "@neondatabase/serverless";

// The only thing the app needs from a database: run one SQL statement with
// $1, $2… parameters and get rows back. Production uses Neon's HTTP driver;
// tests swap in an in-memory Postgres (PGlite) with setDb().
export type Db = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Set DATABASE_URL to your Neon Postgres connection string (see README).");
    const sql = neon(url);
    db = { query: async (text, params) => (await sql.query(text, params)) as never };
  }
  return db;
}

export function setDb(next: Db | undefined): void {
  db = next;
}
