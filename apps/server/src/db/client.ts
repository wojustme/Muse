import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  connectionLimit: 10,
});

export const db = drizzle(pool, { schema, mode: "default" });

export { schema };
