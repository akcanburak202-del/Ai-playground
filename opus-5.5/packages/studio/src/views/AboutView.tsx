import { STATS } from '../lib/stats';
import { fmtInt } from '../lib/format';

const LAYERS: { name: string; files: string; what: string; sub?: string }[] = [
  { name: 'SQL front end', files: 'sql/lexer · parser · ast', what: 'Hand-written tokenizer and recursive-descent parser with SQLite operator precedence and character-accurate error positions.', sub: 'sql' },
  {
    name: 'Binder',
    files: 'plan/binder',
    what: 'Resolves names through nested scopes, infers static types, rewrites aggregates and window functions, and marks correlated subqueries.',
    sub: 'binder',
  },
  {
    name: 'Planner',
    files: 'plan/planner',
    what: 'Cost-based: predicate pushdown, rowid / index / index-only access paths, dynamic-programming join order, hash and index nested-loop joins, sort elimination, Top-N.',
    sub: 'planner',
  },
  {
    name: 'Executor',
    files: 'exec/*',
    what: 'Volcano iterators with expressions compiled to closures: aggregates, window frames, recursive CTEs, set operations, upsert, RETURNING, EXPLAIN ANALYZE.',
    sub: 'exec',
  },
  {
    name: 'B+tree',
    files: 'storage/btree · page · codec',
    what: 'Table trees keyed by rowid and index trees keyed by tuples; byte-budgeted splits, merges and redistribution, overflow chains, bidirectional cursors.',
    sub: 'btree',
  },
  { name: 'Pager + WAL', files: 'storage/pager', what: 'Page cache with second-chance eviction, checksummed write-ahead log, atomic commit, statement rollback, checkpoints and crash recovery.', sub: 'pager' },
  { name: 'File', files: 'storage/file · node', what: 'Two files per database (main + WAL): real files under Node.js, growable byte arrays in the browser.', sub: 'file' },
];

export function AboutView() {
  const loc = STATS.loc;
  const sub = new Map(loc.subsystems.map((s) => [s.name, s]));
  const fuzz = STATS.fuzz;
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>About OpusDB</h1>
          <p>
            A relational database written from scratch in TypeScript for this benchmark repository: a storage engine, a SQL engine, a network server that speaks the PostgreSQL protocol, and this Studio. The
            engine you are querying runs entirely inside this page.
          </p>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <span className="label">engine</span>
          <span className="value">{fmtInt(loc.engine)}</span>
          <span className="sub">lines of TypeScript, 0 dependencies</span>
        </div>
        <div className="stat">
          <span className="label">server</span>
          <span className="value">{fmtInt(loc.server)}</span>
          <span className="sub">lines: HTTP, WebSocket, pgwire</span>
        </div>
        <div className="stat">
          <span className="label">tests</span>
          <span className="value">{fmtInt(STATS.tests.engine + STATS.tests.server)}</span>
          <span className="sub">{fmtInt(loc.engineTests + loc.serverTests)} lines incl. fuzzer and crash test</span>
        </div>
        {fuzz && (
          <div className="stat">
            <span className="label">fuzzed against SQLite</span>
            <span className="value">{fmtInt(fuzz.compared)}</span>
            <span className="sub">{(fuzz.agreement * 100).toFixed(fuzz.agreement === 1 ? 0 : 3)}% identical results</span>
          </div>
        )}
      </div>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>How a query travels through the engine</h2>
          </div>
          <div className="panel-body arch">
            {LAYERS.map((l) => {
              const s = l.sub ? sub.get(l.sub) : undefined;
              return (
                <div className="arch-row" key={l.name}>
                  <div className="arch-tag">
                    <div>
                      <div className="label">{l.files}</div>
                      {s && (
                        <div className="muted num" style={{ fontSize: 12 }}>
                          {fmtInt(s.lines)} lines
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="arch-layer">
                    <b>{l.name}</b>
                    <span>{l.what}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="panel">
            <div className="panel-head">
              <h2>Run it yourself</h2>
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p className="muted" style={{ margin: 0 }}>
                Node.js 22.18 or newer runs the TypeScript sources directly; there is no build step for the engine or server.
              </p>
              <code className="codeblock">{`cd opus-5.5 && npm install
npm test                      # engine + server test suites
npm run fuzz -- --seeds 50    # differential fuzzing vs SQLite
npm run bench                 # OpusDB vs SQLite benchmark
npm run build                 # build this Studio
npm run server -- --demo      # HTTP :8080, PostgreSQL :5433
psql -h 127.0.0.1 -p 5433     # connect with any Postgres client`}</code>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2>Guarantees and limits</h2>
            </div>
            <div className="panel-body prose" style={{ fontSize: 13 }}>
              <p>
                <b style={{ color: 'var(--ink)' }}>Durable and atomic.</b> A commit is a checksummed run of WAL frames ending in a commit marker. A crash test kills a writer with SIGKILL mid-stream; every
                acknowledged transaction survives and partial ones vanish. A torn WAL tail is detected by its checksum and ignored.
              </p>
              <p>
                <b style={{ color: 'var(--ink)' }}>Serializable.</b> One writer or explicit transaction at a time; other sessions wait for the lock. Statements are atomic inside a transaction too.
              </p>
              <p>
                <b style={{ color: 'var(--ink)' }}>Not yet.</b> Foreign keys are parsed but not enforced, AUTOINCREMENT reuses freed rowids like plain rowids, and index keys are limited to about a
                quarter of a page.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
