import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "../db";
import * as schema from "./schema";

// Drizzle instance built on top of the shared pg Pool (see ../db.ts). Import
// `db` and `schema` from here for all typed queries.
export const db = drizzle(pool, { schema });
export { schema };
