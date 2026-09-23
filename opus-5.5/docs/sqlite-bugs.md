# SQLite 3.51.2 bugs found by the OpusDB fuzzer

The differential fuzzer (`packages/engine/test/fuzz`) runs every generated query on OpusDB and on
SQLite 3.51.2 (the copy bundled with Node.js 22.22.2 as `node:sqlite`). When the two disagree it asks
SQLite a second time in a form that should give the same answer: once on a copy of the database
without secondary indexes, and, for `ORDER BY … LIMIT … OFFSET` queries, by fetching SQLite's full
ordered result and applying the limit itself. If SQLite contradicts itself and OpusDB matches the
consistent answer, the case is counted as a SQLite inconsistency instead of an OpusDB bug.

In a 200-schema campaign (72,000 queries) this happened 12 times. The cases reduced by hand come down to
the two bugs below.
Both reproduce through `node:sqlite` with nothing but the statements shown.

## 1. `NOT IN` ignores NULLs when the subquery reads a descending index

```sql
CREATE TABLE a(x INTEGER);
INSERT INTO a VALUES (1), (2), (NULL);
CREATE TABLE b(y INTEGER);
INSERT INTO b VALUES (1), (NULL);

SELECT x FROM a WHERE x NOT IN (SELECT y FROM b);   -- correct: no rows
CREATE INDEX b_y_desc ON b(y DESC);
SELECT x FROM a WHERE x NOT IN (SELECT y FROM b);   -- SQLite 3.51.2 returns 2
SELECT 2 NOT IN (SELECT y FROM b);                  -- SQLite 3.51.2 returns 1, should be NULL
```

`2 NOT IN (1, NULL)` is `NOT (2 = 1 OR 2 = NULL)` = `NOT NULL` = `NULL`, so no row qualifies. Without the
descending index, and with an ascending one, SQLite answers correctly.

## 2. A correlated `EXISTS` makes `LIMIT … OFFSET` drop the OFFSET

```sql
CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER);
INSERT INTO t VALUES (1,1), (2,1), (3,1), (4,1), (5,1), (6,1);

SELECT x.id FROM t x
WHERE EXISTS (SELECT 1 FROM t z WHERE z.a >= x.a)
ORDER BY 1 LIMIT 2 OFFSET 2;
-- correct: 3, 4
-- SQLite 3.51.2: 1, 2
```

The `EXISTS` is true for every row, so the query means `SELECT id FROM t ORDER BY 1 LIMIT 2 OFFSET 2`,
which SQLite answers correctly when written that way. The OFFSET is also dropped without the `ORDER BY`,
when the query is wrapped in a derived table, and on a database with no secondary indexes. OpusDB returns
3, 4 in every form.
