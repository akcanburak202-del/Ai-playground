# OpusDB: self-report for the model comparison

This folder is Claude Opus 5.5's entry in the playground. The brief was open: "build something that shows
what you can do, visually and on the backend". The entry is a relational database built from nothing: storage
engine, SQL engine, network server and a visual Studio. This file records what was built, how it was
checked and how fast it is, so it can be compared with other entries.

> **Türkçe özet:** Yaklaşık 11.300 satırlık bağımlılıksız bir veritabanı motoru, 890 satırlık bir sunucu
> (HTTP, WebSocket, PostgreSQL protokolü) ve 4.500 satırlık bir Studio yazıldı. 37 test ve bir fuzzer var:
> 72.000 rastgele sorgunun, iki motorun da kabul ettiği 70.650'sinde sonuçlar SQLite ile **birebir aynı
> (%100)**. SIGKILL ile çökme testi ve yırtık WAL testi geçiyor. Performansta PK nokta sorgularında
> SQLite'tan hızlı (0,57–0,75×), diğer iş yüklerinde 1,3–8× daha yavaş. Fuzzer SQLite 3.51.2'de iki hata
> buldu ([docs/sqlite-bugs.md](docs/sqlite-bugs.md)).

## What was built

| Part | Size | Highlights |
|---|---:|---|
| `packages/engine` | 11,318 lines, 0 dependencies | SQL parser, binder, cost-based planner, volcano executor, B+tree, pager with WAL and crash recovery |
| `packages/server` | 887 lines, 0 runtime dependencies | HTTP/JSON API, WebSocket sessions (RFC 6455 written from scratch), PostgreSQL protocol v3 |
| `packages/studio` | 4,498 lines (React + Vite) | SQL editor on the engine's own lexer, plan viewer, animated B+tree lab, page map, benchmarks |
| Tests | 1,365 lines, 37 tests | B+tree model tests, SQL feature tests, SIGKILL crash test, torn-WAL test, protocol tests, fuzzer |

Engine lines by layer: SQL front end 1,726 · binder 1,535 · planner 1,208 · executor 3,317 · B+tree and
page formats 1,829 · pager + WAL 490 · files 127 · catalog, sessions and inspector 1,576. Lines are
non-blank, non-comment lines counted by `packages/studio/scripts/gen-stats.ts`.

The Studio is published as a live page (the engine runs inside it):
https://claude.ai/artifact/M6GqoZULfdHVtRJ3RegaSj

## Correctness

**Differential fuzzing against SQLite.** `npm run fuzz` generates random schemas (2–3 tables, typed columns,
random secondary indexes including descending and composite ones), random data with NULLs and duplicates,
and random queries: inner, left and cross joins, correlated `EXISTS` / `IN` / scalar subqueries,
aggregates with `HAVING`, window functions, `UNION` / `INTERSECT` / `EXCEPT`, `DISTINCT`, `ORDER BY` with
`LIMIT` / `OFFSET`, plus `INSERT` / `UPDATE` / `DELETE` after which whole tables are compared and OpusDB's
integrity check is run. The generator only produces statements whose meaning is the same in both engines.

| Campaign (`--seeds 200 --queries 400 --dml 40`) | Result |
|---|---:|
| Queries generated | 72,000 |
| Queries both engines accepted and compared | 70,650 |
| Identical results | **70,650 (100%)** |
| Result rows compared | 3,795,330 |
| SQLite contradicting itself, OpusDB consistent | 12 |
| Run time | 151 s |

Earlier runs of the same fuzzer found real OpusDB bugs, which were fixed before the numbers above:
`GROUP BY` on constant expressions, grouped expressions matched inside larger expressions, a
materialised join inside a recursive CTE caching the working table, and missing type affinity for
parameters. The 12 SQLite inconsistencies are two bugs in SQLite 3.51.2 itself, written up with minimal
reproductions in [docs/sqlite-bugs.md](docs/sqlite-bugs.md).

**Durability.** `test/crash.test.ts` starts a writer process that commits 50-row batches in a loop,
kills it with SIGKILL four times at different moments, reopens the file each time and checks that every
acknowledged batch is present, no batch is partial, and the full integrity check passes. A second test
cuts the WAL in the middle of a transaction's frames and checks that recovery keeps the previous commit
and discards the torn one.

**Other checks.** The B+tree tests drive random inserts and deletes (with overflow payloads) against a model
map in both byte-budget and teaching mode, verifying every structural invariant after each batch. The SQL
tests cover every documented feature, constraint errors, transaction and statement atomicity, planner
choices, and render the Mandelbrot set with a recursive CTE, comparing it character for character with
SQLite's output. The server tests use real clients: `psql` and `node-postgres` (extended protocol).

## Performance

`npm run bench` runs the same workloads on OpusDB and on SQLite 3.51.2 through `node:sqlite`
(Node 22.22.2, 100,000 rows). The ratio is OpusDB time divided by SQLite time; below 1 means OpusDB was
faster.

| Workload | OpusDB (memory) | SQLite (memory) | Ratio | Ratio on disk (WAL) |
|---|---:|---:|---:|---:|
| Bulk insert 100,000 rows in one transaction | 390 ms | 143 ms | 2.72× | 2.62× |
| Create an index on 100,000 rows | 308 ms | 37 ms | 8.39× | 5.70× |
| 50,000 point lookups by primary key | 115 ms | 153 ms | **0.75×** | **0.57×** |
| 20,000 secondary index lookups (~50 rows each) | 1,310 ms | 438 ms | 2.99× | 1.60× |
| 5,000 rowid range scans (~100 rows each) | 143 ms | 62 ms | 2.33× | 2.36× |
| Full scan + GROUP BY, 10 times | 518 ms | 393 ms | 1.32× | 1.31× |
| `ORDER BY … LIMIT 10` over 100,000 rows, 10 times | 168 ms | 52 ms | 3.24× | 3.12× |
| Join + aggregate | 65 ms | 17 ms | 3.83× | 3.54× |
| 5,000 single-row `UPDATE`s in one transaction | 66 ms | 13 ms | 4.93× | 5.48× |
| 2,000 autocommit inserts | 57 ms | 3.8 ms | 14.9× | **1.46×** |

How to read this: SQLite is C code tuned for more than twenty years, so the useful question is where a
TypeScript engine gets close. Point lookups beat SQLite most likely because each `node:sqlite` call crosses the
JavaScript/C boundary, while OpusDB's prepared statements reuse their compiled plan. Scans with
aggregation are within about 30%. Single-row transactions are 15× slower in memory only because SQLite's
in-memory mode skips journaling while OpusDB still writes its WAL; on disk, where both engines write a WAL,
the gap is 1.46×. Index builds and write-heavy workloads are where the remaining distance is. Raw results
are in `docs/bench-memory.json` and `docs/bench-file.json`.

The first version of the engine was 4–18× slower on most workloads. Profiling then led to: decoding rows
without `DataView` and skipping columns a query never reads; statement undo by page clone instead of
re-encoding; writing the header page to the WAL only when it changed; inlined checksums; a numeric fast
path for rowid search; sorted bulk index builds; allocation-free Top-N rejection; and index-derived
distinct-value estimates that fixed a bad join order.

## Studio

The Studio runs the engine in the page with a generated demo shop (600 customers, 5,000 orders, 11,000
order lines, an org chart). Its views:

- **Query:** editor highlighted by the engine's lexer, completion from the live schema, error underlines at
  the engine's reported character position, virtualised results, the executed plan of every query with
  per-operator actual rows and time and a flag where the planner's estimate was off by 10× or more.
- **B+tree Lab:** a separate table whose tree splits at 3–8 keys per page. Inserts, deletes and searches
  run as SQL; splits, merges, redistributions and root changes come from engine events and animate; any
  page can be opened as a hex dump of its on-disk bytes.
- **Storage:** every page of the file on one grid, colored by owner and fill factor and marked when its
  newest copy is still in the WAL; checkpoint and integrity check buttons; the real B+tree of any table or
  index.
- **Bench:** the workloads above run in the browser, the Node.js comparison as a log-scale chart, and the
  fuzzing summary.

When the Studio is served by `npm run server`, it can switch to the server's database over WebSocket.

## Limits and honest gaps

- Foreign keys are parsed and stored but not enforced.
- Concurrency is one writer or explicit transaction at a time; there is no MVCC, so readers wait while
  another session holds an open transaction.
- `AUTOINCREMENT` does not keep a persistent sequence; index keys must fit in about a quarter of a page;
  `VACUUM` does not compact the file.
- Planner statistics come from `ANALYZE` or are estimated from indexes; without them, low-cardinality
  filters can still be misjudged (the Studio flags these in the plan view).

## Timeline

Work happened in one session on 23 September 2026. After the plan was approved: the engine with its tests
and fuzzer (about 45 minutes to the first commit), performance work (6 minutes), the server and protocols
(10 minutes), and the Studio (16 minutes), then documentation and the published page.

## Reproduce

```bash
cd opus-5.5 && npm install
npm test
npm run fuzz -- --seeds 200 --queries 400 --dml 40
npm run bench            # in memory
npm run bench -- --file  # on disk
```
