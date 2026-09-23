import { useState } from 'react';
import { Database } from '@opusdb/engine';
import { BarChart, RatioChart } from '../components/Charts';
import { STATS } from '../lib/stats';
import type { BenchFile } from '../lib/stats';
import { fmtCompact, fmtInt, fmtMs } from '../lib/format';

interface LocalResult {
  name: string;
  ops: number;
  unit: string;
  ms: number;
}

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

/** The same workloads as bench/run.ts, run by the engine inside this page. */
function workloads(rows: number): { name: string; unit: string; ops: number; run: (db: Database) => void }[] {
  const r = rng(7);
  const customers = Math.max(100, Math.floor(rows / 50));
  const lookups = Array.from({ length: 10_000 }, () => 1 + Math.floor(r() * rows));
  return [
    {
      name: `Insert ${fmtInt(rows)} rows in one transaction`,
      unit: 'rows',
      ops: rows,
      run: (db) => {
        db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, status TEXT)');
        const st = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)');
        db.exec('BEGIN');
        for (let i = 1; i <= rows; i++) st.run([i, 1 + Math.floor(r() * customers), Math.round(r() * 100000) / 100, ['new', 'paid', 'shipped', 'returned'][i % 4]]);
        db.exec('COMMIT');
      },
    },
    { name: 'Build an index on customer_id', unit: 'rows', ops: rows, run: (db) => void db.exec('CREATE INDEX orders_customer ON orders (customer_id)') },
    {
      name: 'Point lookups by primary key',
      unit: 'queries',
      ops: lookups.length,
      run: (db) => {
        const st = db.prepare('SELECT * FROM orders WHERE id = ?');
        for (const id of lookups) st.all([id]);
      },
    },
    {
      name: 'Secondary index lookups',
      unit: 'queries',
      ops: 2_000,
      run: (db) => {
        const st = db.prepare('SELECT count(*), sum(amount) FROM orders WHERE customer_id = ?');
        for (let i = 0; i < 2_000; i++) st.all([1 + ((i * 7919) % customers)]);
      },
    },
    {
      name: 'Full scan + GROUP BY (x5)',
      unit: 'rows',
      ops: rows * 5,
      run: (db) => {
        const st = db.prepare('SELECT status, count(*), avg(amount) FROM orders GROUP BY status');
        for (let i = 0; i < 5; i++) st.all([]);
      },
    },
    {
      name: 'ORDER BY amount DESC LIMIT 10 (x5)',
      unit: 'rows',
      ops: rows * 5,
      run: (db) => {
        const st = db.prepare('SELECT id, amount FROM orders ORDER BY amount DESC LIMIT 10');
        for (let i = 0; i < 5; i++) st.all([]);
      },
    },
    {
      name: 'Hash join + aggregate',
      unit: 'rows',
      ops: rows,
      run: (db) => {
        db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, city TEXT)');
        const st = db.prepare('INSERT INTO customers VALUES (?, ?)');
        db.exec('BEGIN');
        for (let i = 1; i <= customers; i++) st.run([i, ['Istanbul', 'Berlin', 'Tokyo', 'Lima', 'Oslo'][i % 5]]);
        db.exec('COMMIT');
        db.query('SELECT c.city, count(*), sum(o.amount) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.city');
      },
    },
  ];
}

function nodeRows(b: BenchFile) {
  return b.results.map((r) => ({
    label: r.case,
    ratio: r.ratio,
    detail: [
      { name: 'OpusDB', value: `${fmtMs(r.opus.ms)} · ${fmtCompact(r.opus.perSec)} ${r.unit}/s` },
      { name: 'SQLite', value: `${fmtMs(r.sqlite.ms)} · ${fmtCompact(r.sqlite.perSec)} ${r.unit}/s` },
      { name: 'ratio', value: `${r.ratio}× the time` },
    ],
  }));
}

export function BenchView() {
  const [size, setSize] = useState(20_000);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<LocalResult[]>([]);
  const [mode, setMode] = useState<'memory' | 'file'>('memory');
  const node = mode === 'memory' ? STATS.benchMemory : STATS.benchFile;
  const fuzz = STATS.fuzz;

  const run = async () => {
    setRunning(true);
    setResults([]);
    setProgress(0);
    const db = new Database();
    const list = workloads(size);
    const out: LocalResult[] = [];
    for (let i = 0; i < list.length; i++) {
      await new Promise((r) => setTimeout(r, 30));
      const w = list[i];
      const t0 = performance.now();
      w.run(db);
      out.push({ name: w.name, ops: w.ops, unit: w.unit, ms: performance.now() - t0 });
      setResults([...out]);
      setProgress((i + 1) / list.length);
    }
    db.close();
    setRunning(false);
  };

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Benchmarks</h1>
          <p>How fast is a database written in TypeScript? Run the workloads in this tab, compare against SQLite measured under Node.js, and check correctness with the differential fuzzer.</p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head" style={{ flexWrap: 'wrap' }}>
          <h2>Run it in your browser</h2>
          <select className="input" value={size} onChange={(e) => setSize(Number(e.target.value))} disabled={running} id="bench-size" aria-label="Table size">
            {[5_000, 20_000, 50_000, 100_000].map((n) => (
              <option key={n} value={n}>
                {fmtInt(n)} rows
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={() => void run()} disabled={running}>
            {running ? 'Running…' : results.length ? 'Run again' : 'Run benchmark'}
          </button>
          {running && (
            <span className="progress" aria-label="progress">
              <i style={{ width: `${progress * 100}%` }} />
            </span>
          )}
        </div>
        <div className="panel-body">
          {results.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Seven workloads on a fresh in-memory database: bulk insert, index build, point and index lookups, a full scan with GROUP BY, a Top-N sort and a hash join. Each takes well under a second at 20,000 rows.
            </p>
          ) : (
            <BarChart
              rows={results.map((r) => ({
                label: r.name,
                value: r.ms,
                text: fmtMs(r.ms),
                sub: `${fmtCompact((r.ops / r.ms) * 1000)} ${r.unit}/s`,
              }))}
            />
          )}
          {results.length > 0 && (
            <p className="muted" style={{ margin: '12px 0 0', fontSize: 12 }}>
              Elapsed time per workload in this tab; hover a value for its throughput.
            </p>
          )}
        </div>
      </section>

      {node && (
        <section className="panel">
          <div className="panel-head" style={{ flexWrap: 'wrap' }}>
            <h2>OpusDB vs SQLite {node.sqlite}</h2>
            <div className="tabs" style={{ border: 0, padding: 0 }} role="tablist">
              {(['memory', 'file'] as const).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
                  {m === 'memory' ? 'In memory' : 'On disk (WAL)'}
                </button>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              {fmtInt(node.rows)} rows · Node {node.node}
            </span>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <RatioChart rows={nodeRows(node)} />
            <p className="muted" style={{ margin: 0, fontSize: 12.5, maxWidth: '80ch' }}>
              SQLite is decades-tuned C; OpusDB is {fmtInt(STATS.loc.engine)} lines of TypeScript with no dependencies. Primary-key lookups come out ahead because every SQLite call crosses the JavaScript/C boundary.
              On disk both engines write every commit to a WAL, which makes single-row transactions nearly even.
            </p>
            <details>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>
                Show the numbers as a table
              </summary>
              <div className="scroll-x" style={{ marginTop: 8 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Workload</th>
                      <th className="n">OpusDB</th>
                      <th className="n">SQLite</th>
                      <th className="n">Time ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {node.results.map((r) => (
                      <tr key={r.case}>
                        <td>{r.case}</td>
                        <td className="n">
                          {fmtMs(r.opus.ms)} · {fmtCompact(r.opus.perSec)}/s
                        </td>
                        <td className="n">
                          {fmtMs(r.sqlite.ms)} · {fmtCompact(r.sqlite.perSec)}/s
                        </td>
                        <td className="n">{r.ratio}×</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </section>
      )}

      {fuzz && (
        <section className="panel">
          <div className="panel-head">
            <h2>Correctness: differential fuzzing against SQLite</h2>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="stat-row">
              <div className="stat">
                <span className="label">queries compared</span>
                <span className="value">{fmtInt(fuzz.compared)}</span>
                <span className="sub">over {fmtInt(fuzz.seeds)} random schemas</span>
              </div>
              <div className="stat">
                <span className="label">same answer as SQLite</span>
                <span className="value">{(fuzz.agreement * 100).toFixed(fuzz.agreement === 1 ? 0 : 3)}%</span>
                <span className="sub">
                  {fmtInt(fuzz.agreed)} of {fmtInt(fuzz.compared)}
                </span>
              </div>
              <div className="stat">
                <span className="label">result rows checked</span>
                <span className="value">{fmtCompact(fuzz.rowsCompared)}</span>
                <span className="sub">in {Math.round(fuzz.seconds)} s</span>
              </div>
              <div className="stat">
                <span className="label">SQLite self-contradictions</span>
                <span className="value">{fmtInt(fuzz.sqliteInconsistencies ?? 0)}</span>
                <span className="sub">where OpusDB had the right answer</span>
              </div>
            </div>
            <div className="prose" style={{ maxWidth: '84ch' }}>
              <p>
                The fuzzer generates random tables, data, indexes, queries and updates, runs them on both engines and compares every row. Queries SQLite would also reject are skipped. Along the way it
                caught two bugs in SQLite 3.51.2 itself: <code>NOT IN</code> ignores NULLs when the subquery reads a descending index, and a correlated <code>EXISTS</code> with{' '}
                <code>ORDER BY … LIMIT … OFFSET</code> drops the OFFSET. In those cases SQLite contradicts its own index-free or un-limited answer, and OpusDB matches the consistent one.
              </p>
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                SQL features exercised
              </div>
              <div className="feature-grid">
                {Object.entries(fuzz.features)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <div key={k}>
                      <span>{k.replace(/-/g, ' ')}</span>
                      <span>{fmtInt(v)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
