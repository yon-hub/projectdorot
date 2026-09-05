import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

export function dbPath() {
  const p = process.env.IGT_DB || join(ROOT, "data", "igt.db");
  return p.startsWith("/") ? p : join(ROOT, p);
}

let _db;
export function openDb(path = dbPath()) {
  if (_db) return _db;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  _db = db;
  return db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = undefined; }
}

// Small helpers ---------------------------------------------------------
export function one(db, sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}
export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}
export function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function getMeta(db, key) {
  return one(db, "SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
}
export function setMeta(db, key, value) {
  run(db, "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value));
}
export function entityTable(entityType) {
  if (entityType === "operator") return "operators";
  if (entityType === "sponsor") return "sponsors";
  throw new Error(`unknown entity type ${entityType}`);
}
export function getEntity(db, entityType, id) {
  return one(db, `SELECT * FROM ${entityTable(entityType)} WHERE id = ?`, id);
}
