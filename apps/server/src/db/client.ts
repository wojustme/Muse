import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "../config/env.js";
import { CREATE_TABLES_SQL } from "./schema.js";
import * as schema from "./schema.js";

// 第一阶段用本地 SQLite，桌面端本地优先。
const sqlite = new Database(env.DATABASE_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// 启动时确保表存在。表结构稳定后可切换到 drizzle-kit migration。
export function initDatabase() {
  sqlite.exec(CREATE_TABLES_SQL);
}

export { schema };
