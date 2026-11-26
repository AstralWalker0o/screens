// Test doubles for Cloudflare D1 (on node:sqlite, with the real migrations applied) and R2 (in memory).
// Only what the code under test uses. Binding `undefined` throws, like D1 does.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Val = string | number | null | Uint8Array;

function norm(v: unknown): Val {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as Val;
}
const plain = <T,>(r: unknown): T => (r == null ? (null as T) : ({ ...(r as object) } as T));

class Stmt {
  constructor(private db: DatabaseSync, readonly sql: string, private args: Val[] = []) {}
  bind(...a: unknown[]) { return new Stmt(this.db, this.sql, a.map(norm)); }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const r = this.db.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
    if (!r) return null;
    return (col ? r[col] : plain(r)) as T;
  }
  async all<T = Record<string, unknown>>() {
    return { results: (this.db.prepare(this.sql).all(...this.args) as unknown[]).map((r) => plain<T>(r)), success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  runSync() { this.db.prepare(this.sql).run(...this.args); }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try { for (const s of stmts) s.runSync(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return stmts.map(() => ({ success: true }));
    },
    async exec(sql: string) { db.exec(sql); return { count: 1 }; },
  };
  return { d1: d1 as unknown as D1Database, raw: db };
}

export function makeR2() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    objects,
    async put(key: string, value: unknown) {
      let b: Uint8Array;
      if (value instanceof Uint8Array) b = value;
      else if (value instanceof ArrayBuffer) b = new Uint8Array(value);
      else if (value instanceof ReadableStream) b = new Uint8Array(await new Response(value).arrayBuffer());
      else b = new TextEncoder().encode(String(value));
      objects.set(key, b);
      return { key, size: b.length };
    },
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      const b = objects.get(key);
      if (!b) return null;
      const s = opts?.range ? b.subarray(opts.range.offset, opts.range.offset + opts.range.length) : b;
      return { size: b.length, arrayBuffer: async () => s.slice().buffer, body: new Response(s.slice()).body };
    },
    async head(key: string) { const b = objects.get(key); return b ? { size: b.length } : null; },
    async delete(key: string) { objects.delete(key); },
  };
  return bucket as unknown as R2Bucket & { objects: Map<string, Uint8Array> };
}

export function makeEnv(over: Record<string, unknown> = {}) {
  const { d1, raw } = makeD1();
  const files = makeR2();
  const env = { DB: d1, FILES: files, SIGNING_SECRET: 'test-secret', SECRETS_KEY: '', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DOT_BASE_DOMAIN: '', ...over };
  return { env: env as any, sql: raw, files };
}
