import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./client";
import { pool } from "../db";

// Apply pending migrations using drizzle-orm's migrator (not the drizzle-kit
// CLI, which swallows errors and mishandles the SSL connection to Render).
// Runs the same pool/SSL config as the app, so it "just works" locally and in
// deploy. Use via `npm run db:migrate`.
async function main() {
  await migrate(db, { migrationsFolder: "./migrations" });
  console.log("Migrations applied.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
