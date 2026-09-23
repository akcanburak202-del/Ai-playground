/**
 * Micro-benchmarks: OpusDB vs SQLite (node:sqlite, a C library) on the same
 * workloads. Both run in-memory unless --file is given.
 *
 *   node bench/run.ts [--rows 100000] [--file] [--json out.json]
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/index.ts';
import { openFile } from '../src/node.ts';

const args = process.argv.slice(2);
const argNum = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const ROWS = argNum('rows', 100_000);
const FILE = args.includes('--file');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Engine {
  name: string;
  exec(sql: string): void;
  prepare(sql: string): { run(p: unknown[]): void; all(p: unknown[]): unknown[] };
  close(): void;
}

function opusEngine(path?: string): Engine {
  const db = path ? openFile(path, { synchronous: 'normal' }) : new Database();
  return {
    name: 'OpusDB',
    exec: (sql) => void db.exec(sql),
    prepare(sql) {
      const st = db.prepare(sql);
      return { run: (p) => void st.run(p as never), all: (p) => st.all(p as never) };
    },
    close: () => db.close(),
  };
}

function sqliteEngine(path?: string): Engine {
  const db = new DatabaseSync(path ?? ':memory:');
  if (path) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
  return {
    name: 'SQLite',
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const st = db.prepare(sql);
      return { run: (p) => void st.run(...(p as never[])), all: (p) => st.all(...(p as never[])) };
    },
    close: () => db.close(),
  };
}

interface Case {
  name: string;
  ops: number;
  unit: string;
  run: (e: Engine) => void;
  setup?: (e: Engine) => void;
}

const R = rng(42);
const customers = Math.max(100, Math.floor(ROWS / 50));
const cities = ['Istanbul', 'Ankara', 'Izmir', 'Berlin', 'Paris', 'Tokyo', 'Lima', 'Oslo', 'Cairo', 'Seoul'];
const orders = Array.from({ length: ROWS }, (_, i) => [i + 1, 1 + Math.floor(R() * customers), Math.round(R() * 100000) / 100, ['new', 'paid', 'shipped', 'returned'][Math.floor(R() * 4)], `2025-${String(1 + Math.floor(R() * 12)).padStart(2, '0')}-${String(1 + Math.floor(R() * 28)).padStart(2, '0')}`]);
const lookups = Array.from({ length: 50_000 }, () => 1 + Math.floor(R() * ROWS));

const cases: Case[] = [
  {
    name: `Bulk insert ${ROWS.toLocaleString('en-US')} rows (1 transaction)`,
    ops: ROWS,
    unit: 'rows',
    run: (e) => {
      e.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, status TEXT, day TEXT)');
      const st = e.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)');
      e.exec('BEGIN');
      for (const o of orders) st.run(o);
      e.exec('COMMIT');
    },
  },
  {
    name: 'Create index on customer_id',
    ops: ROWS,
    unit: 'rows',
    run: (e) => e.exec('CREATE INDEX orders_customer ON orders (customer_id)'),
  },
  {
    name: 'Point lookup by primary key',
    ops: lookups.length,
    unit: 'queries',
    run: (e) => {
      const st = e.prepare('SELECT * FROM orders WHERE id = ?');
      for (const id of lookups) st.all([id]);
    },
  },
  {
    name: 'Secondary index lookup',
    ops: 20_000,
    unit: 'queries',
    run: (e) => {
      const st = e.prepare('SELECT count(*), sum(amount) FROM orders WHERE customer_id = ?');
      for (let i = 0; i < 20_000; i++) st.all([1 + (i * 7919) % customers]);
    },
  },
  {
    name: 'Range scan (rowid BETWEEN, ~100 rows each)',
    ops: 5_000,
    unit: 'queries',
    run: (e) => {
      const st = e.prepare('SELECT sum(amount) FROM orders WHERE id BETWEEN ? AND ?');
      for (let i = 0; i < 5_000; i++) {
        const a = 1 + ((i * 104729) % (ROWS - 100));
        st.all([a, a + 99]);
      }
    },
  },
  {
    name: 'Full scan + GROUP BY (x10)',
    ops: ROWS * 10,
    unit: 'rows',
    run: (e) => {
      const st = e.prepare('SELECT status, count(*), avg(amount), max(day) FROM orders GROUP BY status');
      for (let i = 0; i < 10; i++) st.all([]);
    },
  },
  {
    name: 'ORDER BY amount DESC LIMIT 10 (x10)',
    ops: ROWS * 10,
    unit: 'rows',
    run: (e) => {
      const st = e.prepare('SELECT id, amount FROM orders ORDER BY amount DESC LIMIT 10');
      for (let i = 0; i < 10; i++) st.all([]);
    },
  },
  {
    name: 'Join + aggregate (orders x customers)',
    ops: ROWS,
    unit: 'rows',
    setup: (e) => {
      e.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT)');
      const st = e.prepare('INSERT INTO customers VALUES (?, ?, ?)');
      e.exec('BEGIN');
      for (let i = 1; i <= customers; i++) st.run([i, `customer ${i}`, cities[i % cities.length]]);
      e.exec('COMMIT');
    },
    run: (e) => {
      e.prepare("SELECT c.city, count(*), round(sum(o.amount), 2) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'paid' GROUP BY c.city ORDER BY 3 DESC").all([]);
    },
  },
  {
    name: 'UPDATE via index (5,000 statements)',
    ops: 5_000,
    unit: 'statements',
    run: (e) => {
      const st = e.prepare('UPDATE orders SET amount = amount + 1 WHERE id = ?');
      e.exec('BEGIN');
      for (let i = 0; i < 5_000; i++) st.run([lookups[i]]);
      e.exec('COMMIT');
    },
  },
  {
    name: 'Autocommit inserts (2,000 transactions)',
    ops: 2_000,
    unit: 'txns',
    run: (e) => {
      e.exec('CREATE TABLE log (id INTEGER PRIMARY KEY, msg TEXT)');
      const st = e.prepare('INSERT INTO log (msg) VALUES (?)');
      for (let i = 0; i < 2_000; i++) st.run([`event ${i}`]);
    },
  },
];

interface Result {
  case: string;
  unit: string;
  opus: { ms: number; perSec: number };
  sqlite: { ms: number; perSec: number };
  ratio: number;
}

const dir = FILE ? mkdtempSync(join(tmpdir(), 'opusdb-bench-')) : undefined;
const engines: Engine[] = [opusEngine(dir && join(dir, 'bench.opusdb')), sqliteEngine(dir && join(dir, 'bench.sqlite'))];
const results: Result[] = [];
for (const c of cases) {
  const times: number[] = [];
  for (const e of engines) {
    c.setup?.(e);
    const t0 = performance.now();
    c.run(e);
    times.push(performance.now() - t0);
  }
  const [o, s] = times;
  results.push({
    case: c.name,
    unit: c.unit,
    opus: { ms: Math.round(o * 10) / 10, perSec: Math.round((c.ops / o) * 1000) },
    sqlite: { ms: Math.round(s * 10) / 10, perSec: Math.round((c.ops / s) * 1000) },
    ratio: Math.round((o / s) * 100) / 100,
  });
}
for (const e of engines) e.close();
if (dir) rmSync(dir, { recursive: true, force: true });

const fmt = (n: number) => n.toLocaleString('en-US');
console.log(`\nOpusDB vs SQLite ${process.versions.sqlite ?? ''} — ${FILE ? 'file-backed (WAL)' : 'in-memory'}, ${fmt(ROWS)} rows, Node ${process.version}\n`);
console.log('| Workload | OpusDB | SQLite | OpusDB time / SQLite time |');
console.log('|---|---:|---:|---:|');
for (const r of results) {
  console.log(`| ${r.case} | ${fmt(r.opus.perSec)} ${r.unit}/s (${r.opus.ms} ms) | ${fmt(r.sqlite.perSec)} ${r.unit}/s (${r.sqlite.ms} ms) | ${r.ratio}× |`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ rows: ROWS, file: FILE, node: process.version, sqlite: process.versions.sqlite, results }, null, 2));
