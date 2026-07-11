import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Match db.ts: Render's *external* URL (used locally) needs SSL; the internal
// hostname does not. Without this, drizzle-kit hangs connecting to Render.
const url = process.env.DATABASE_URL!;
const needsSsl = url.includes("render.com");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  },
});
