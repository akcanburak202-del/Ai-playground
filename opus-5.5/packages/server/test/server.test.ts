/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo, Server } from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { Database, loadDemo } from '@opusdb/engine';
import { startHttp } from '../src/http.ts';
import { closeAllPgConnections as closePg, startPgServer } from '../src/pgwire.ts';

let db: Database;
let http: Server;
let pgServer: Server;
let httpPort = 0;
let pgPort = 0;

before(async () => {
  db = new Database();
  loadDemo(db, { customers: 100, orders: 500 });
  http = await startHttp({ db, port: 0 });
  pgServer = await startPgServer({ db, port: 0 });
  httpPort = (http.address() as AddressInfo).port;
  pgPort = (pgServer.address() as AddressInfo).port;
});

after(() => {
  (http as unknown as { closeAllConnections(): void }).closeAllConnections();
  http.close();
  closePg();
  pgServer.close();
  db.close();
});

test('HTTP: query endpoint returns typed results and positioned errors', async () => {
  const ok = await fetch(`http://127.0.0.1:${httpPort}/api/query`, {
    method: 'POST',
    body: JSON.stringify({ sql: 'SELECT count(*) AS n, max(price) FROM products WHERE category = ?', params: ['Books'] }),
  }).then((r) => r.json() as Promise<any>);
  assert.equal(ok.results[0].columns[0].name, 'n');
  assert.equal(ok.results[0].columns[0].type, 'INTEGER');
  assert.ok(ok.results[0].rows[0][0] > 0);

  const bad = await fetch(`http://127.0.0.1:${httpPort}/api/query`, { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM nowhere' }) });
  assert.equal(bad.status, 400);
  const err = (await bad.json()) as any;
  assert.equal(err.error.code, '42P01');
  assert.equal(err.error.position, 14);

  const schema = await fetch(`http://127.0.0.1:${httpPort}/api/schema`).then((r) => r.json() as Promise<any>);
  assert.deepEqual(schema.tables.map((t: { name: string }) => t.name).sort(), ['customers', 'employees', 'order_items', 'orders', 'products']);
  const tree = await fetch(`http://127.0.0.1:${httpPort}/api/tree?name=orders`).then((r) => r.json() as Promise<any>);
  assert.ok(tree.nodes.length > 1);
});

test('WebSocket: sessions keep transactions across messages and receive commit events', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/api/ws`);
  const inbox: { id?: number; results?: { rows: unknown[][] }[]; error?: { message: string }; type?: string; inTransaction?: boolean }[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (m) => {
    inbox.push(JSON.parse(String(m.data)));
    waiters.splice(0).forEach((w) => w());
  };
  await new Promise<void>((r) => (ws.onopen = () => r()));
  const call = async (id: number, sql: string) => {
    ws.send(JSON.stringify({ id, sql }));
    for (;;) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  assert.equal((await call(1, 'BEGIN')).inTransaction, true);
  await call(2, "INSERT INTO products (name, category, price) VALUES ('WS Widget', 'Accessories', 9.99)");
  // another session cannot see (or touch) the uncommitted row: the HTTP request waits for the lock
  const pending = fetch(`http://127.0.0.1:${httpPort}/api/query`, { method: 'POST', body: JSON.stringify({ sql: "SELECT count(*) FROM products WHERE name = 'WS Widget'" }) }).then((r) => r.json() as Promise<any>);
  await new Promise((r) => setTimeout(r, 50));
  const commit = await call(3, 'COMMIT');
  assert.equal(commit.inTransaction, false);
  const seen = await pending;
  assert.deepEqual(seen.results[0].rows, [[1]]);
  // large message (> 64 KiB) exercises the 64-bit frame length path
  const big = 'x'.repeat(100_000);
  const echo = await call(4, `SELECT length('${big}')`);
  assert.deepEqual(echo.results![0].rows, [[100000]]);
  assert.ok(inbox.some((m) => m.type === 'event'));
  ws.close();
});

test('PostgreSQL wire protocol: node-postgres (extended protocol) round trip', async () => {
  const client = new pg.Client({ host: '127.0.0.1', port: pgPort, user: 'test', database: 'opus' });
  await client.connect();
  try {
    const r = await client.query('SELECT id, name, price FROM products WHERE price > $1 AND category = $2 ORDER BY price DESC LIMIT 3', [100, 'Displays']);
    assert.equal(r.rows.length, 3);
    assert.equal(r.fields[0].name, 'id');
    assert.ok(Number(r.rows[0].price) >= Number(r.rows[1].price));

    await client.query('CREATE TABLE pg_test (id INTEGER PRIMARY KEY, label TEXT, ok BOOLEAN)');
    const ins = await client.query('INSERT INTO pg_test (label, ok) VALUES ($1, $2), ($3, $4) RETURNING id', ['a', true, 'b', false]);
    assert.equal(ins.rowCount, 2);
    assert.deepEqual(ins.rows.map((x) => Number(x.id)), [1, 2]);
    const sel = await client.query({ text: 'SELECT label, ok FROM pg_test WHERE id = $1', values: [2], rowMode: 'array' });
    assert.deepEqual(sel.rows, [['b', false]]);

    await client.query('BEGIN');
    await client.query("INSERT INTO pg_test (label) VALUES ('rolled back')");
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT count(*) AS n FROM pg_test')).rows[0].n, '2');

    await assert.rejects(client.query('SELECT * FROM missing_table'), (e: Error & { code?: string; position?: string }) => {
      assert.equal(e.code, '42P01');
      assert.equal(e.position, '15');
      return true;
    });
    // the connection is still usable after an error
    assert.equal((await client.query('SELECT 40 + 2 AS answer')).rows[0].answer, '42');
  } finally {
    await client.end();
  }
});

test('PostgreSQL wire protocol: psql client', { skip: !hasPsql() }, async () => {
  // async: the server lives in this process, a blocking child call would deadlock it
  const { stdout } = await promisify(execFile)('psql', ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'x', '-d', 'x', '-At', '-c', 'SELECT count(*) FROM customers', '-c', "SELECT 'OpusDB ' || 'over psql'"], {
    encoding: 'utf8',
  });
  assert.deepEqual(stdout.trim().split('\n'), ['100', 'OpusDB over psql']);
});

function hasPsql(): boolean {
  try {
    execFileSync('psql', ['--version']);
    return true;
  } catch {
    return false;
  }
}
