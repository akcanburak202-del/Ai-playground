import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Database, OpusError } from '../src/index.ts';
import type { Value } from '../src/index.ts';

function rows(db: Database, sql: string, params?: Value[]): Value[][] {
  return db.query(sql, params).rows;
}

function seed(): Database {
  const db = new Database();
  db.exec(`
    CREATE TABLE dept (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE emp (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      dept_id INTEGER REFERENCES dept(id),
      salary REAL CHECK (salary >= 0),
      manager_id INTEGER,
      hired TEXT DEFAULT '2020-01-01'
    );
    INSERT INTO dept (name) VALUES ('eng'), ('sales'), ('ops');
    INSERT INTO emp (name, dept_id, salary, manager_id, hired) VALUES
      ('ada', 1, 150, NULL, '2015-03-01'),
      ('bob', 1, 120, 1, '2018-07-15'),
      ('cyd', 2, 90, 1, '2019-01-10'),
      ('dee', 2, 95, 3, '2021-11-30'),
      ('eve', 1, 130, 2, '2022-02-02'),
      ('fay', NULL, 60, NULL, '2023-05-05');
  `);
  return db;
}

describe('queries', () => {
  test('filters, projections and ordering', () => {
    const db = seed();
    assert.deepEqual(rows(db, 'SELECT name FROM emp WHERE salary > 100 ORDER BY salary DESC'), [['ada'], ['eve'], ['bob']]);
    assert.deepEqual(rows(db, 'SELECT name, salary * 2 AS double FROM emp WHERE name LIKE ? ORDER BY double', ['%e%']), [
      ['dee', 190],
      ['eve', 260],
    ]);
    assert.deepEqual(rows(db, 'SELECT count(*) FROM emp WHERE dept_id IS NULL'), [[1]]);
    assert.deepEqual(rows(db, 'SELECT name FROM emp ORDER BY dept_id NULLS LAST, name LIMIT 2 OFFSET 4'), [['dee'], ['fay']]);
  });

  test('joins of every kind', () => {
    const db = seed();
    assert.deepEqual(rows(db, 'SELECT e.name, d.name FROM emp e JOIN dept d ON d.id = e.dept_id WHERE d.name = ? ORDER BY 1', ['sales']), [
      ['cyd', 'sales'],
      ['dee', 'sales'],
    ]);
    assert.deepEqual(rows(db, 'SELECT d.name, count(e.id) FROM dept d LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.name ORDER BY 1'), [
      ['eng', 3],
      ['ops', 0],
      ['sales', 2],
    ]);
    assert.deepEqual(rows(db, 'SELECT e.name, d.name FROM dept d RIGHT JOIN emp e ON e.dept_id = d.id WHERE d.id IS NULL'), [['fay', null]]);
    assert.equal(rows(db, 'SELECT * FROM emp e FULL JOIN dept d ON d.id = e.dept_id').length, 7);
    assert.deepEqual(rows(db, 'SELECT m.name, count(*) FROM emp e JOIN emp m ON m.id = e.manager_id GROUP BY m.name ORDER BY 2 DESC, 1'), [
      ['ada', 2],
      ['bob', 1],
      ['cyd', 1],
    ]);
    // NATURAL JOIN compares every column; rows with a NULL column never match themselves
    assert.deepEqual(rows(db, 'SELECT count(*) FROM emp NATURAL JOIN emp'), [[4]]);
    assert.deepEqual(rows(db, 'SELECT e.name FROM emp e JOIN dept d USING (id) ORDER BY 1'), [['ada'], ['bob'], ['cyd']]);
  });

  test('aggregates, HAVING, DISTINCT and FILTER', () => {
    const db = seed();
    assert.deepEqual(rows(db, 'SELECT dept_id, sum(salary), round(avg(salary), 2), min(name), max(name) FROM emp GROUP BY dept_id HAVING count(*) > 1 ORDER BY 1'), [
      [1, 400, 133.33, 'ada', 'eve'],
      [2, 185, 92.5, 'cyd', 'dee'],
    ]);
    assert.deepEqual(rows(db, 'SELECT count(DISTINCT dept_id), count(dept_id), count(*) FROM emp'), [[2, 5, 6]]);
    assert.deepEqual(rows(db, 'SELECT count(*) FILTER (WHERE salary > 100), string_agg(name, \'|\' ORDER BY name DESC) FROM emp'), [[3, 'fay|eve|dee|cyd|bob|ada']]);
    assert.deepEqual(rows(db, 'SELECT sum(salary) FROM emp WHERE 1 = 0'), [[null]]);
    assert.deepEqual(rows(db, 'SELECT DISTINCT dept_id FROM emp ORDER BY dept_id DESC'), [[2], [1], [null]]);
  });

  test('subqueries: scalar, IN, EXISTS, correlated, derived tables', () => {
    const db = seed();
    assert.deepEqual(rows(db, 'SELECT name FROM emp WHERE salary > (SELECT avg(salary) FROM emp) ORDER BY 1'), [['ada'], ['bob'], ['eve']]);
    assert.deepEqual(rows(db, "SELECT name FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE name <> 'eng') ORDER BY 1"), [['cyd'], ['dee']]);
    assert.deepEqual(rows(db, 'SELECT d.name FROM dept d WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id)'), [['ops']]);
    assert.deepEqual(rows(db, 'SELECT name, (SELECT count(*) FROM emp r WHERE r.manager_id = e.id) FROM emp e WHERE e.manager_id IS NULL ORDER BY 1'), [
      ['ada', 2],
      ['fay', 0],
    ]);
    assert.deepEqual(rows(db, 'SELECT top.name FROM (SELECT name, salary FROM emp ORDER BY salary DESC LIMIT 2) AS top ORDER BY top.salary'), [['eve'], ['ada']]);
    assert.deepEqual(rows(db, 'SELECT dept_id, (SELECT max(salary) FROM emp i WHERE i.dept_id = o.dept_id) FROM emp o GROUP BY dept_id ORDER BY 1'), [
      [null, null],
      [1, 150],
      [2, 95],
    ]);
  });

  test('set operations', () => {
    const db = seed();
    assert.deepEqual(rows(db, 'SELECT dept_id FROM emp UNION SELECT id FROM dept ORDER BY 1'), [[null], [1], [2], [3]]);
    assert.equal(rows(db, 'SELECT dept_id FROM emp UNION ALL SELECT id FROM dept').length, 9);
    assert.deepEqual(rows(db, 'SELECT id FROM dept INTERSECT SELECT dept_id FROM emp ORDER BY 1'), [[1], [2]]);
    assert.deepEqual(rows(db, 'SELECT id FROM dept EXCEPT SELECT dept_id FROM emp'), [[3]]);
  });

  test('CTEs, recursion and the Mandelbrot set', () => {
    const db = seed();
    assert.deepEqual(
      rows(
        db,
        `WITH RECURSIVE chain(id, name, depth) AS (
           SELECT id, name, 0 FROM emp WHERE manager_id IS NULL AND dept_id IS NOT NULL
           UNION ALL
           SELECT e.id, e.name, c.depth + 1 FROM emp e JOIN chain c ON e.manager_id = c.id
         ) SELECT name, depth FROM chain ORDER BY depth, name`,
      ),
      [
        ['ada', 0],
        ['bob', 1],
        ['cyd', 1],
        ['dee', 2],
        ['eve', 2],
      ],
    );
    assert.deepEqual(rows(db, 'WITH RECURSIVE f(n, a, b) AS (SELECT 1, 0, 1 UNION ALL SELECT n + 1, b, a + b FROM f) SELECT a FROM f LIMIT 10').flat(), [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
    const art = rows(
      db,
      `WITH RECURSIVE
        xaxis(x) AS (VALUES(-2.0) UNION ALL SELECT x + 0.05 FROM xaxis WHERE x < 1.2),
        yaxis(y) AS (VALUES(-1.0) UNION ALL SELECT y + 0.1 FROM yaxis WHERE y < 1.0),
        m(iter, cx, cy, x, y) AS (
          SELECT 0, x, y, 0.0, 0.0 FROM xaxis, yaxis
          UNION ALL
          SELECT iter + 1, cx, cy, x * x - y * y + cx, 2.0 * x * y + cy FROM m WHERE (x * x + y * y) < 4.0 AND iter < 28
        ),
        m2(iter, cx, cy) AS (SELECT max(iter), cx, cy FROM m GROUP BY cx, cy),
        a(cy, t) AS (SELECT cy, string_agg(substr(' .+*#', 1 + min(iter / 7, 4), 1), '' ORDER BY cx) FROM m2 GROUP BY cy)
      SELECT string_agg(rtrim(t), char(10) ORDER BY cy) FROM a`,
    )[0][0] as string;
    // the classic query from the SQLite documentation, rendered by SQLite itself
    const reference = new DatabaseSync(':memory:')
      .prepare(
        `WITH RECURSIVE
          xaxis(x) AS (VALUES(-2.0) UNION ALL SELECT x+0.05 FROM xaxis WHERE x<1.2),
          yaxis(y) AS (VALUES(-1.0) UNION ALL SELECT y+0.1 FROM yaxis WHERE y<1.0),
          m(iter, cx, cy, x, y) AS (SELECT 0, x, y, 0.0, 0.0 FROM xaxis, yaxis
            UNION ALL SELECT iter+1, cx, cy, x*x-y*y + cx, 2.0*x*y + cy FROM m WHERE (x*x + y*y) < 4.0 AND iter<28),
          m2(iter, cx, cy) AS (SELECT max(iter), cx, cy FROM m GROUP BY cx, cy),
          a(t) AS (SELECT group_concat(substr(' .+*#', 1+min(iter/7,4), 1), '') FROM m2 GROUP BY cy)
        SELECT group_concat(rtrim(t), x'0a') AS v FROM a`,
      )
      .get() as { v: string };
    assert.equal(art, reference.v);
    assert.ok(art.split('\n')[10].includes('#####'));
  });

  test('window functions', () => {
    const db = seed();
    assert.deepEqual(
      rows(db, 'SELECT name, rank() OVER w, dense_rank() OVER w, row_number() OVER w FROM emp WINDOW w AS (ORDER BY dept_id) ORDER BY name'),
      [
        ['ada', 2, 2, 2],
        ['bob', 2, 2, 3],
        ['cyd', 5, 3, 5],
        ['dee', 5, 3, 6],
        ['eve', 2, 2, 4],
        ['fay', 1, 1, 1],
      ].map((r, i) => (i === 0 ? r : r)).map((r) => r),
    );
    assert.deepEqual(
      rows(db, 'SELECT name, sum(salary) OVER (PARTITION BY dept_id ORDER BY salary ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), lag(name) OVER (ORDER BY id), lead(name, 2, \'-\') OVER (ORDER BY id) FROM emp WHERE dept_id = 1 ORDER BY id'),
      [
        ['ada', 280, null, 'eve'],
        ['bob', 120, 'ada', '-'],
        ['eve', 250, 'bob', '-'],
      ],
    );
    assert.deepEqual(rows(db, 'SELECT ntile(3) OVER (ORDER BY id), percent_rank() OVER (ORDER BY id), cume_dist() OVER (ORDER BY id) FROM emp ORDER BY id LIMIT 2'), [
      [1, 0, 1 / 6],
      [1, 0.2, 2 / 6],
    ]);
    assert.deepEqual(rows(db, 'SELECT dept_id, sum(salary), sum(sum(salary)) OVER () FROM emp GROUP BY dept_id ORDER BY 1'), [
      [null, 60, 645],
      [1, 400, 645],
      [2, 185, 645],
    ]);
  });

  test('scalar functions and SQLite-compatible semantics', () => {
    const db = new Database();
    const [r] = rows(
      db,
      `SELECT 7 / 2, 7.0 / 2, -7 % 3, 5 / 0, 'a' || 1 || 2.5, 1.0 || '', substr('hello', -3, 2), instr('hello', 'l'),
              replace('aXbX', 'X', '-'), trim('  x  '), upper('abc'), length('héllo'), round(2.5), round(-2.5), abs(-3),
              coalesce(NULL, NULL, 3), nullif(4, 4), iif(1 > 0, 'y', 'n'), typeof(1), typeof(1.5), typeof('x'), typeof(NULL),
              CAST('12abc' AS INTEGER), CAST(3.9 AS INTEGER), 'ABC' LIKE 'a%', 'ABC' GLOB 'a*', printf('%05.1f|%-3s|%d', 3.14159, 'x', 42),
              date('2024-01-31', '+1 month'), strftime('%Y/%m/%d %H', '2024-03-05 17:30:00'), max(1, 5, 3), min('b', 'a')`,
    );
    assert.deepEqual(r, [3, 3.5, -1, null, 'a12.5', '1.0', 'll', 3, 'a-b-', 'x', 'ABC', 5, 3, -3, 3, 3, null, 'y', 'integer', 'real', 'text', 'null', 12, 3, true, false, '003.1|x  |42', '2024-03-02', '2024/03/05 17', 5, 'a']);
  });

  test('parameters: positional, numbered and named', () => {
    const db = seed();
    assert.deepEqual(rows(db, 'SELECT ?1 + ?2, ?1', [2, 3]), [[5, 2]]);
    assert.deepEqual(db.query('SELECT name FROM emp WHERE dept_id = :d AND salary > :s ORDER BY name', { d: 1, s: 125 }).rows, [['ada'], ['eve']]);
    const stmt = db.prepare('SELECT count(*) FROM emp WHERE dept_id = ?');
    assert.deepEqual([1, 2, 3].map((d) => stmt.get([d])![0]), [3, 2, 0]);
  });
});

describe('modifications', () => {
  test('INSERT ... SELECT, RETURNING, defaults and rowids', () => {
    const db = seed();
    const r = db.query("INSERT INTO emp (name, salary) VALUES ('gus', 10) RETURNING id, hired, dept_id");
    assert.deepEqual(r.rows, [[7, '2020-01-01', null]]);
    assert.equal(r.lastInsertRowid, 7);
    db.exec('CREATE TABLE rich AS SELECT name, salary FROM emp WHERE salary >= 120');
    assert.deepEqual(rows(db, 'SELECT * FROM rich ORDER BY salary'), [
      ['bob', 120],
      ['eve', 130],
      ['ada', 150],
    ]);
    db.exec('INSERT INTO rich SELECT name || \'2\', salary + 1 FROM rich');
    assert.deepEqual(rows(db, 'SELECT count(*), max(salary) FROM rich'), [[6, 151]]);
  });

  test('UPDATE with expressions, FROM and RETURNING', () => {
    const db = seed();
    const r = db.query('UPDATE emp SET salary = salary * 1.1 WHERE dept_id = 2 RETURNING name, salary');
    assert.deepEqual(r.rows, [
      ['cyd', 99.00000000000001],
      ['dee', 104.50000000000001],
    ]);
    db.exec("UPDATE emp SET name = upper(emp.name) FROM dept d WHERE d.id = emp.dept_id AND d.name = 'eng'");
    assert.deepEqual(rows(db, 'SELECT name FROM emp WHERE dept_id = 1 ORDER BY id'), [['ADA'], ['BOB'], ['EVE']]);
  });

  test('DELETE with subquery and truncate', () => {
    const db = seed();
    assert.equal(db.query("DELETE FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE name = 'sales')").rowsAffected, 2);
    assert.equal(db.query('DELETE FROM emp').rowsAffected, 4);
    assert.deepEqual(rows(db, 'SELECT count(*) FROM emp'), [[0]]);
    db.exec("INSERT INTO emp (name) VALUES ('new')");
    assert.deepEqual(rows(db, 'SELECT id FROM emp'), [[1]]);
    assert.deepEqual(db.inspect.integrityCheck(), []);
  });

  test('constraints: NOT NULL, UNIQUE, CHECK, PRIMARY KEY and types', () => {
    const db = seed();
    const code = (sql: string) => {
      try {
        db.exec(sql);
        return 'ok';
      } catch (e) {
        return (e as OpusError).code;
      }
    };
    assert.equal(code("INSERT INTO emp (name, salary) VALUES ('x', -1)"), '23514');
    assert.equal(code('INSERT INTO emp (salary) VALUES (1)'), '23502');
    assert.equal(code("INSERT INTO dept (name) VALUES ('eng')"), '23505');
    assert.equal(code("INSERT INTO emp (id, name) VALUES (1, 'dup')"), '23505');
    assert.equal(code("UPDATE dept SET name = 'eng' WHERE id = 2"), '23505');
    assert.equal(code("INSERT INTO emp (name, salary) VALUES ('x', 'lots')"), '42804');
    assert.equal(code("INSERT INTO emp (name, salary) VALUES ('x', '12.5')"), 'ok');
    assert.equal(code("SELECT name + 1 FROM emp"), '42804');
    assert.equal(code('SELECT dept_id, name FROM emp GROUP BY dept_id'), '42803');
    // a failed multi-row statement leaves no partial effects
    assert.equal(code("INSERT INTO dept (name) VALUES ('a1'), ('a2'), ('eng')"), '23505');
    assert.deepEqual(rows(db, "SELECT count(*) FROM dept WHERE name LIKE 'a%'"), [[0]]);
  });

  test('upsert and conflict clauses', () => {
    const db = new Database();
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER, n INTEGER DEFAULT 0)');
    db.exec("INSERT INTO kv VALUES ('a', 1, 0)");
    db.exec("INSERT INTO kv (k, v) VALUES ('a', 5) ON CONFLICT (k) DO UPDATE SET v = kv.v + excluded.v, n = kv.n + 1");
    assert.deepEqual(rows(db, 'SELECT * FROM kv'), [['a', 6, 1]]);
    db.exec("INSERT INTO kv (k, v) VALUES ('a', 9) ON CONFLICT DO NOTHING");
    db.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('a', 42)");
    db.exec("INSERT OR IGNORE INTO kv (k, v) VALUES ('a', 0), ('b', 2)");
    assert.deepEqual(rows(db, 'SELECT k, v, n FROM kv ORDER BY k'), [
      ['a', 42, 0],
      ['b', 2, 0],
    ]);
  });

  test('transactions: commit, rollback, statement atomicity, errors', () => {
    const db = seed();
    db.exec("BEGIN; INSERT INTO dept (name) VALUES ('hr'); UPDATE emp SET salary = 0; ROLLBACK");
    assert.deepEqual(rows(db, 'SELECT count(*), sum(salary) FROM emp JOIN dept ON dept.id = emp.dept_id'), [[5, 585]]);
    db.exec('BEGIN');
    db.exec("INSERT INTO dept (name) VALUES ('hr')");
    assert.throws(() => db.exec("INSERT INTO dept (name) VALUES ('legal'), ('hr')"), /UNIQUE/);
    db.exec("INSERT INTO dept (name) VALUES ('legal')");
    db.exec('COMMIT');
    assert.deepEqual(rows(db, 'SELECT name FROM dept ORDER BY id'), [['eng'], ['sales'], ['ops'], ['hr'], ['legal']]);
    assert.throws(() => db.exec('COMMIT'), /no transaction/);
    // DDL is transactional too
    db.exec('BEGIN; CREATE TABLE tmp (x INTEGER); INSERT INTO tmp VALUES (1); ROLLBACK');
    assert.throws(() => db.exec('SELECT * FROM tmp'), /no such table/);
    assert.deepEqual(db.inspect.integrityCheck(), []);
  });

  test('sessions are isolated by a database lock', () => {
    const db = seed();
    const s1 = db.session();
    const s2 = db.session();
    s1.exec("BEGIN; INSERT INTO dept (name) VALUES ('x')");
    assert.throws(() => s2.exec('SELECT * FROM dept'), /locked/);
    s1.exec('COMMIT');
    assert.equal(s2.query('SELECT count(*) FROM dept').rows[0][0], 4);
  });
});

describe('schema', () => {
  test('views, ALTER TABLE, DROP and IF [NOT] EXISTS', () => {
    const db = seed();
    db.exec('CREATE VIEW payroll (dept, total) AS SELECT d.name, sum(e.salary) FROM emp e JOIN dept d ON d.id = e.dept_id GROUP BY d.name');
    assert.deepEqual(rows(db, 'SELECT * FROM payroll WHERE total > 200'), [['eng', 400]]);
    db.exec("ALTER TABLE emp ADD COLUMN level INTEGER DEFAULT 1");
    assert.deepEqual(rows(db, 'SELECT DISTINCT level FROM emp'), [[1]]);
    db.exec('ALTER TABLE emp RENAME COLUMN salary TO pay');
    assert.deepEqual(rows(db, 'SELECT max(pay) FROM emp'), [[150]]);
    db.exec('ALTER TABLE dept RENAME TO departments');
    assert.deepEqual(rows(db, 'SELECT count(*) FROM departments'), [[3]]);
    db.exec('CREATE TABLE IF NOT EXISTS departments (x INTEGER)');
    db.exec('DROP VIEW payroll; DROP TABLE IF EXISTS nope');
    db.exec('CREATE INDEX emp_pay ON emp (pay)');
    db.exec('DROP INDEX emp_pay');
    assert.deepEqual(db.inspect.integrityCheck(), []);
    const schema = db.inspect.schema();
    assert.deepEqual(schema.tables.map((t) => t.name).sort(), ['departments', 'emp']);
  });

  test('indexes are used by the planner', () => {
    const db = new Database();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, c REAL)');
    const ins = db.prepare('INSERT INTO t (a, b, c) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) ins.run([i % 500, 'k' + (i % 37), i / 7]);
    db.exec('COMMIT');
    db.exec('CREATE INDEX t_a ON t (a); CREATE INDEX t_bc ON t (b, c)');
    const plan = (sql: string) => db.query('EXPLAIN ' + sql).rows.map((r) => r[0]).join('\n');
    assert.match(plan('SELECT * FROM t WHERE id = 42'), /Rowid Lookup/);
    assert.match(plan('SELECT * FROM t WHERE id BETWEEN 10 AND 20'), /Rowid Range Scan/);
    assert.match(plan('SELECT * FROM t WHERE a = 7'), /Index Scan[\s\S]*using t_a/);
    assert.match(plan("SELECT c FROM t WHERE b = 'k3' AND c > 100"), /Index Only Scan[\s\S]*t_bc/);
    assert.match(plan('SELECT * FROM t ORDER BY a DESC LIMIT 5'), /t_a on t \(reverse\)[\s\S]*Order: satisfied/);
    assert.match(plan('SELECT * FROM t WHERE a IN (1, 2, 3)'), /a IN \(1, 2, 3\)/);
    assert.match(plan('SELECT * FROM t ORDER BY c LIMIT 3'), /Top-N Sort/);
    // results agree with a full scan
    const viaIndex = rows(db, 'SELECT id FROM t WHERE a BETWEEN 10 AND 12 ORDER BY id');
    const viaScan = rows(db, 'SELECT id FROM t WHERE a + 0 BETWEEN 10 AND 12 ORDER BY id');
    assert.deepEqual(viaIndex, viaScan);
    assert.equal(viaIndex.length, 30);
  });

  test('join planning picks index nested loops and hash joins', () => {
    const db = new Database();
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, k INTEGER, v TEXT); CREATE TABLE small (id INTEGER PRIMARY KEY, k INTEGER)');
    db.exec('BEGIN');
    const a = db.prepare('INSERT INTO big (k, v) VALUES (?, ?)');
    for (let i = 0; i < 3000; i++) a.run([i % 100, 'v' + i]);
    const b = db.prepare('INSERT INTO small (k) VALUES (?)');
    for (let i = 0; i < 20; i++) b.run([i]);
    db.exec('COMMIT');
    const plan = (sql: string) => db.query('EXPLAIN ' + sql).rows.map((r) => r[0]).join('\n');
    assert.match(plan('SELECT * FROM small s JOIN big b ON b.id = s.k'), /Index Nested Loop[\s\S]*Rowid Lookup/);
    assert.match(plan('SELECT * FROM small s JOIN big b ON b.k = s.k'), /Hash Join/);
    db.exec('CREATE INDEX big_k ON big (k)');
    assert.match(plan('SELECT * FROM small s JOIN big b ON b.k = s.k'), /Index Nested Loop[\s\S]*big_k/);
    assert.equal(rows(db, 'SELECT count(*) FROM small s JOIN big b ON b.k = s.k')[0][0], 600);
  });

  test('EXPLAIN ANALYZE reports actual row counts', () => {
    const db = seed();
    const r = db.query('EXPLAIN ANALYZE SELECT d.name, count(*) FROM emp e JOIN dept d ON d.id = e.dept_id GROUP BY d.name');
    assert.ok(r.plan?.actual);
    assert.equal(r.plan!.actual!.rows, 2);
    assert.ok(r.rows.some((l) => /actual rows=/.test(String(l[0]))));
  });
});

describe('errors', () => {
  test('syntax errors carry positions', () => {
    const db = new Database();
    try {
      db.exec('SELECT 1;\nSELECT * FORM t');
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof OpusError);
      assert.equal(e.code, '42601');
      assert.equal(e.position, 19);
    }
  });

  test('semantic errors', () => {
    const db = seed();
    assert.throws(() => db.exec('SELECT nope FROM emp'), /no such column: nope/);
    assert.throws(() => db.exec('SELECT * FROM nope'), /no such table: nope/);
    assert.throws(() => db.exec('SELECT id FROM emp JOIN dept ON 1 = 1'), /ambiguous column name: id/);
    assert.throws(() => db.exec('SELECT count(*) FROM emp WHERE count(*) > 1'), /not allowed in WHERE/);
    assert.throws(() => db.exec('SELECT row_number() FROM emp'), /window function/);
    assert.throws(() => db.exec('SELECT nosuchfn(1)'), /no such function/);
    assert.throws(() => db.exec('SELECT 1 UNION SELECT 1, 2'), /same number of result columns/);
  });
});
