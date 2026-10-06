// Applies db/schema.sql to DATABASE_URL. Usage: pnpm db:migrate
import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env.local (vercel env pull) first.");
  process.exit(1);
}

const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const statements = schema
  .replace(/--.*$/gm, "")
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter(Boolean);

const sql = neon(url);
for (const statement of statements) await sql.query(statement);
console.log(`Applied ${statements.length} statements.`);
