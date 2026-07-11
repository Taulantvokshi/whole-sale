import { Pool } from "pg";
import { config } from "./config";

// A single shared connection pool for the app. On Render, point DATABASE_URL at
// the *internal* database URL (no SSL needed). Locally we use the *external*
// URL, which Render requires be reached over SSL.
const connectionString = config.databaseUrl;

// External Render hostnames contain ".render.com" and need SSL; the internal
// hostname (dpg-...-a) does not.
const needsSsl = connectionString.includes("render.com");

export const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});
