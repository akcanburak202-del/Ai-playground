import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFile } from '../src/node.ts';

const WORKER = new URL('./fixtures/crash-worker.ts', import.meta.url).pathname;

/** Starts a writer process, lets it commit for a while, then kills it with SIGKILL. */
function runAndKill(path: string, ms: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', WORKER, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    let lastCommitted = 0;
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const l of lines) if (l.startsWith('committed ')) lastCommitted = Number(l.slice(10));
    });
    child.on('error', reject);
    child.on('exit', () => resolve(lastCommitted));
    setTimeout(() => child.kill('SIGKILL'), ms);
  });
}

test('committed transactions survive SIGKILL; partial ones vanish', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opusdb-crash-'));
  try {
    const path = join(dir, 'crash.opusdb');
    let expectedAtLeast = 0;
    for (let round = 0; round < 4; round++) {
      const acked = await runAndKill(path, 400 + round * 150);
      expectedAtLeast = Math.max(expectedAtLeast, acked);
      const db = openFile(path);
      // every batch is 50 rows inserted in one transaction: never a partial batch
      const [[batches, rows, maxBatch]] = db.query('SELECT count(DISTINCT batch), count(*), max(batch) FROM log').rows as number[][];
      assert.equal(rows, batches * 50, 'a transaction was partially applied');
      assert.ok((maxBatch ?? 0) >= expectedAtLeast, `batch ${expectedAtLeast} was acknowledged but lost (have ${maxBatch})`);
      assert.deepEqual(db.inspect.integrityCheck(), []);
      expectedAtLeast = maxBatch ?? 0;
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn WAL tail is detected and discarded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opusdb-torn-'));
  try {
    const path = join(dir, 'torn.opusdb');
    let db = openFile(path, { synchronous: 'full', checkpointFrames: 1_000_000 });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO t (v) SELECT 'first ' || value FROM generate_series(1, 100)");
    const walAfterFirst = statSync(path + '-wal').size;
    db.exec("INSERT INTO t (v) SELECT 'second ' || value FROM generate_series(1, 100)");
    const walFull = statSync(path + '-wal').size;
    // simulate power loss while the second commit was being written: abandon the process state
    // without a checkpoint, then cut the WAL in the middle of the second transaction's frames
    truncateSync(path + '-wal', walAfterFirst + Math.floor((walFull - walAfterFirst) / 2));
    db = openFile(path);
    assert.deepEqual(db.query('SELECT count(*) FROM t').rows, [[100]]);
    assert.deepEqual(db.inspect.integrityCheck(), []);
    db.exec("INSERT INTO t (v) VALUES ('after recovery')");
    db.close();
    db = openFile(path);
    assert.deepEqual(db.query('SELECT count(*), max(v) FROM t').rows, [[101, 'first 99']]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('data persists across close/reopen with checkpoints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opusdb-persist-'));
  try {
    const path = join(dir, 'p.opusdb');
    let db = openFile(path, { checkpointFrames: 50 });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT); CREATE INDEX t_a ON t (a)');
    const ins = db.prepare('INSERT INTO t (a, b) VALUES (?, ?)');
    for (let i = 0; i < 2000; i++) ins.run([i % 97, 'x'.repeat(i % 300)]);
    db.close();
    db = openFile(path);
    let sumA = 0;
    let sumLen = 0;
    for (let i = 0; i < 2000; i++) {
      sumA += i % 97;
      sumLen += i % 300;
    }
    assert.deepEqual(db.query('SELECT count(*), sum(a), sum(length(b)) FROM t').rows, [[2000, sumA, sumLen]]);
    assert.deepEqual(db.query('SELECT count(*) FROM t WHERE a = 5').rows, [[21]]);
    assert.deepEqual(db.inspect.integrityCheck(), []);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
