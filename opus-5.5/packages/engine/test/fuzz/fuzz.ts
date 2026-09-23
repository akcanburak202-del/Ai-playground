/**
 * Differential fuzzer: generates random schemas, data, queries and DML,
 * runs them on OpusDB and on SQLite (node:sqlite) and compares the results.
 *
 * The generator only produces statements whose meaning is identical in both
 * engines (well-typed comparisons, total orders where row order matters,
 * no order-dependent aggregates), so any difference is a bug in OpusDB.
 */
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/index.ts';
import type { Value } from '../../src/index.ts';

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ty = 'int' | 'real' | 'text';
interface Col {
  name: string;
  ty: Ty;
}
interface Table {
  name: string;
  cols: Col[]; // includes id
}
interface Ref {
  expr: string;
  ty: Ty;
}

export interface FuzzOptions {
  seed: number;
  queries: number;
  dml?: number;
  onMismatch?: (m: Mismatch) => void;
}

export interface Mismatch {
  seed: number;
  sql: string;
  opus: string;
  sqlite: string;
  setup: string[];
}

export interface FuzzStats {
  queries: number;
  agreed: number;
  /** Queries where SQLite with indexes disagreed with SQLite without indexes (a SQLite bug) and OpusDB matched the index-free answer. */
  sqliteBugs: Mismatch[];
  bothErrored: number;
  mismatches: Mismatch[];
  rowsCompared: number;
  features: Record<string, number>;
}

const TEXTS = ["'a'", "'b'", "'ab'", "'B'", "'abc'", "''", "'x y'", "'Abc'", "'b%'", "'zz'", "'a_c'"];
const LIKE_PATTERNS = ["'a%'", "'%b'", "'_'", "'%'", "'A_c'", "'%b%'", "'ab'", "'%'"];

class Gen {
  readonly r: () => number;
  tables: Table[] = [];
  features: Record<string, number> = {};
  constructor(seed: number) {
    this.r = rng(seed);
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.r() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.r() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)];
  }
  feat(name: string): void {
    this.features[name] = (this.features[name] ?? 0) + 1;
  }

  literal(ty: Ty): string {
    if (this.chance(0.08)) return 'NULL';
    switch (ty) {
      case 'int':
        return String(this.int(-5, 20));
      case 'real':
        return (this.int(-8, 20) / 4).toFixed(2);
      case 'text':
        return this.pick(TEXTS);
    }
  }

  schema(): string[] {
    const n = this.int(2, 3);
    const out: string[] = [];
    for (let t = 0; t < n; t++) {
      const cols: Col[] = [{ name: 'id', ty: 'int' }];
      const k = this.int(2, 4);
      for (let c = 0; c < k; c++) cols.push({ name: `c${c}`, ty: this.pick(['int', 'int', 'real', 'text', 'text'] as Ty[]) });
      const table = { name: `t${t}`, cols };
      this.tables.push(table);
      const defs = cols.map((c) => (c.name === 'id' ? 'id INTEGER PRIMARY KEY' : `${c.name} ${c.ty === 'int' ? 'INTEGER' : c.ty === 'real' ? 'REAL' : 'TEXT'}`));
      out.push(`CREATE TABLE ${table.name} (${defs.join(', ')})`);
      const rows = this.int(8, 40);
      for (let i = 0; i < rows; i++) {
        const vals = cols.map((c) => (c.name === 'id' ? (this.chance(0.9) ? 'NULL' : String(this.int(100, 400))) : this.literal(c.ty)));
        out.push(`INSERT OR IGNORE INTO ${table.name} VALUES (${vals.join(', ')})`);
      }
      const nidx = this.int(0, 2);
      for (let i = 0; i < nidx; i++) {
        const cs = cols.filter((c) => c.name !== 'id');
        const a = this.pick(cs);
        const b = this.chance(0.4) ? this.pick(cs.filter((c) => c !== a)) : undefined;
        const desc = this.chance(0.2) ? ' DESC' : '';
        out.push(`CREATE INDEX ix_${table.name}_${i} ON ${table.name} (${a.name}${desc}${b ? ', ' + b.name : ''})`);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ expressions

  refsOf(scope: { alias: string; table: Table }[], ty: Ty): Ref[] {
    const out: Ref[] = [];
    for (const s of scope) for (const c of s.table.cols) if (c.ty === ty) out.push({ expr: `${s.alias}.${c.name}`, ty });
    return out;
  }

  expr(scope: { alias: string; table: Table }[], ty: Ty, depth: number): string {
    const refs = this.refsOf(scope, ty);
    if (depth <= 0 || this.chance(0.35)) {
      if (refs.length && this.chance(0.75)) return this.pick(refs).expr;
      return this.literal(ty);
    }
    const d = depth - 1;
    switch (ty) {
      case 'int': {
        const k = this.int(0, 8);
        if (k === 0) return `(${this.expr(scope, 'int', d)} ${this.pick(['+', '-', '*'])} ${this.expr(scope, 'int', d)})`;
        if (k === 1) return `(${this.expr(scope, 'int', d)} ${this.pick(['/', '%'])} ${this.expr(scope, 'int', d)})`;
        if (k === 2) return `abs(${this.expr(scope, 'int', d)})`;
        if (k === 3) return `length(${this.expr(scope, 'text', d)})`;
        if (k === 4) return `coalesce(${this.expr(scope, 'int', d)}, ${this.expr(scope, 'int', d)})`;
        if (k === 5) return `CASE WHEN ${this.bool(scope, d)} THEN ${this.expr(scope, 'int', d)} ELSE ${this.expr(scope, 'int', d)} END`;
        if (k === 6) return `(-${this.expr(scope, 'int', d)})`;
        if (k === 7) return `instr(${this.expr(scope, 'text', d)}, ${this.pick(TEXTS)})`;
        return `nullif(${this.expr(scope, 'int', d)}, ${this.literal('int')})`;
      }
      case 'real': {
        const k = this.int(0, 5);
        if (k === 0) return `(${this.expr(scope, 'real', d)} ${this.pick(['+', '-', '*'])} ${this.expr(scope, this.pick(['real', 'int'] as Ty[]), d)})`;
        if (k === 1) return `(${this.expr(scope, 'real', d)} / ${this.expr(scope, this.pick(['real', 'int'] as Ty[]), d)})`;
        if (k === 2) return `abs(${this.expr(scope, 'real', d)})`;
        if (k === 3) return `round(${this.expr(scope, 'real', d)}, ${this.int(0, 2)})`;
        if (k === 4) return `coalesce(${this.expr(scope, 'real', d)}, ${this.literal('real')})`;
        return `CASE WHEN ${this.bool(scope, d)} THEN ${this.expr(scope, 'real', d)} ELSE ${this.literal('real')} END`;
      }
      case 'text': {
        const k = this.int(0, 7);
        if (k === 0) return `upper(${this.expr(scope, 'text', d)})`;
        if (k === 1) return `lower(${this.expr(scope, 'text', d)})`;
        if (k === 2) return `substr(${this.expr(scope, 'text', d)}, ${this.int(-3, 3)}, ${this.int(-1, 3)})`;
        if (k === 3) return `(${this.expr(scope, 'text', d)} || ${this.expr(scope, this.pick(['text', 'text', 'int', 'real'] as Ty[]), d)})`;
        if (k === 4) return `trim(${this.expr(scope, 'text', d)})`;
        if (k === 5) return `replace(${this.expr(scope, 'text', d)}, ${this.pick(TEXTS)}, ${this.pick(TEXTS)})`;
        if (k === 6) return `coalesce(${this.expr(scope, 'text', d)}, ${this.literal('text')})`;
        return `CASE WHEN ${this.bool(scope, d)} THEN ${this.expr(scope, 'text', d)} ELSE ${this.literal('text')} END`;
      }
    }
  }

  bool(scope: { alias: string; table: Table }[], depth: number, allowSub = true): string {
    const d = depth - 1;
    const k = this.int(0, depth > 0 ? 11 : 6);
    const numTy = () => this.pick(['int', 'int', 'real'] as Ty[]);
    const cmp = () => this.pick(['=', '<>', '<', '<=', '>', '>=']);
    switch (k) {
      case 0:
      case 1:
      case 2: {
        const ty = this.pick(['int', 'real', 'text', 'int'] as Ty[]);
        const other: Ty = ty === 'text' ? 'text' : numTy();
        return `${this.expr(scope, ty, Math.max(0, d))} ${cmp()} ${this.expr(scope, other, Math.max(0, d))}`;
      }
      case 3:
        return `${this.expr(scope, this.pick(['int', 'real', 'text'] as Ty[]), Math.max(0, d))} IS ${this.chance(0.5) ? 'NOT ' : ''}NULL`;
      case 4: {
        const ty = numTy();
        return `${this.expr(scope, ty, Math.max(0, d))} ${this.chance(0.3) ? 'NOT ' : ''}BETWEEN ${this.literal(ty)} AND ${this.literal(ty)}`;
      }
      case 5: {
        const ty = this.pick(['int', 'text', 'real'] as Ty[]);
        const items = Array.from({ length: this.int(1, 4) }, () => this.literal(ty));
        return `${this.expr(scope, ty, Math.max(0, d))} ${this.chance(0.3) ? 'NOT ' : ''}IN (${items.join(', ')})`;
      }
      case 6:
        return `${this.expr(scope, 'text', Math.max(0, d))} ${this.chance(0.2) ? 'NOT ' : ''}LIKE ${this.pick(LIKE_PATTERNS)}`;
      case 7:
        return `(${this.bool(scope, d, allowSub)} AND ${this.bool(scope, d, allowSub)})`;
      case 8:
        return `(${this.bool(scope, d, allowSub)} OR ${this.bool(scope, d, allowSub)})`;
      case 9:
        return `NOT (${this.bool(scope, d, allowSub)})`;
      case 10: {
        if (!allowSub) return this.bool(scope, d, false);
        this.feat('subquery-exists');
        const t = this.pick(this.tables);
        const alias = `s${this.int(0, 99)}`;
        const inner = [{ alias, table: t }];
        const corr = this.correlation(scope, inner);
        return `${this.chance(0.3) ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${t.name} ${alias} WHERE ${corr}${this.chance(0.5) ? ' AND ' + this.bool(inner, 1, false) : ''})`;
      }
      default: {
        if (!allowSub) return this.bool(scope, d, false);
        this.feat('subquery-in');
        const t = this.pick(this.tables);
        const alias = `s${this.int(0, 99)}`;
        const inner = [{ alias, table: t }];
        const ty = this.pick(['int', 'text'] as Ty[]);
        const col = this.refsOf(inner, ty);
        if (!col.length) return this.bool(scope, d, false);
        const where = this.chance(0.5) ? ` WHERE ${this.chance(0.5) ? this.correlation(scope, inner) : this.bool(inner, 1, false)}` : '';
        return `${this.expr(scope, ty, 0)} ${this.chance(0.3) ? 'NOT ' : ''}IN (SELECT ${this.pick(col).expr} FROM ${t.name} ${alias}${where})`;
      }
    }
  }

  correlation(outer: { alias: string; table: Table }[], inner: { alias: string; table: Table }[]): string {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ty = this.pick(['int', 'text', 'real'] as Ty[]);
      const a = this.refsOf(outer, ty);
      const b = this.refsOf(inner, ty === 'real' ? this.pick(['real', 'int'] as Ty[]) : ty);
      if (a.length && b.length) return `${this.pick(b).expr} ${this.pick(['=', '=', '<', '>='])} ${this.pick(a).expr}`;
    }
    return this.bool(inner, 0, false);
  }

  // ------------------------------------------------------------------ queries

  from(): { sql: string; scope: { alias: string; table: Table }[] } {
    const n = this.pick([1, 1, 2, 2, 2, 3]);
    const scope: { alias: string; table: Table }[] = [];
    let sql = '';
    for (let i = 0; i < n; i++) {
      const t = this.pick(this.tables);
      const alias = 'abc'[i];
      const item = { alias, table: t };
      if (i === 0) sql = `${t.name} ${alias}`;
      else {
        const kind = this.pick(['JOIN', 'JOIN', 'LEFT JOIN', ',', 'CROSS JOIN']);
        if (kind === ',' || kind === 'CROSS JOIN') {
          sql += `${kind === ',' ? ',' : ' CROSS JOIN'} ${t.name} ${alias}`;
          this.feat('cross-join');
        } else {
          const on = this.correlation(scope, [item]) + (this.chance(0.3) ? ' AND ' + this.bool([...scope, item], 1, false) : '');
          sql += ` ${kind} ${t.name} ${alias} ON ${on}`;
          this.feat(kind === 'JOIN' ? 'inner-join' : 'left-join');
        }
      }
      scope.push(item);
    }
    return { sql, scope };
  }

  select(): { sql: string; ordered: boolean; base?: string; limit?: number; offset?: number } {
    const { sql: from, scope } = this.from();
    const where = this.chance(0.75) ? ` WHERE ${this.bool(scope, this.int(1, 3))}` : '';
    const mode = this.int(0, 9);
    if (mode <= 2) {
      // aggregate query
      this.feat('aggregate');
      const groups: Ref[] = [];
      const ng = this.int(0, 2);
      for (let i = 0; i < ng; i++) {
        const ty = this.pick(['int', 'text', 'real'] as Ty[]);
        groups.push({ expr: this.expr(scope, ty, this.int(0, 1)), ty });
      }
      const aggs: string[] = [];
      const na = this.int(1, 3);
      for (let i = 0; i < na; i++) {
        const k = this.int(0, 7);
        const num = () => this.expr(scope, this.pick(['int', 'real'] as Ty[]), 1);
        if (k === 0) aggs.push('count(*)');
        else if (k === 1) aggs.push(`count(${this.chance(0.3) ? 'DISTINCT ' : ''}${this.expr(scope, this.pick(['int', 'text'] as Ty[]), 1)})`);
        else if (k === 2) aggs.push(`sum(${this.expr(scope, 'int', 1)})`);
        else if (k === 3) aggs.push(`avg(${num()})`);
        else if (k === 4) aggs.push(`min(${this.expr(scope, this.pick(['int', 'text', 'real'] as Ty[]), 1)})`);
        else if (k === 5) aggs.push(`max(${this.expr(scope, this.pick(['int', 'text', 'real'] as Ty[]), 1)})`);
        else if (k === 6) aggs.push(`total(${num()})`);
        else aggs.push(`sum(${this.expr(scope, 'real', 1)})`);
      }
      const cols = [...groups.map((g) => g.expr), ...aggs];
      let sql = `SELECT ${cols.join(', ')} FROM ${from}${where}`;
      if (groups.length) sql += ` GROUP BY ${groups.map((g) => g.expr).join(', ')}`;
      if (groups.length && this.chance(0.3)) {
        this.feat('having');
        sql += ` HAVING count(*) ${this.pick(['>', '>=', '<'])} ${this.int(0, 3)}`;
      }
      if (this.chance(0.3)) {
        sql += ` ORDER BY ${cols.map((_, i) => i + 1).join(', ')} LIMIT ${this.int(1, 5)}`;
        return { sql, ordered: true };
      }
      return { sql, ordered: false };
    }
    if (mode === 3) {
      // compound
      this.feat('compound');
      const ty = this.pick(['int', 'text'] as Ty[]);
      const t2 = this.pick(this.tables);
      const inner = [{ alias: 'z', table: t2 }];
      const r2 = this.refsOf(inner, ty);
      const a = this.expr(scope, ty, 1);
      const b = r2.length ? this.pick(r2).expr : this.literal(ty);
      const op = this.pick(['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT']);
      return { sql: `SELECT ${a} FROM ${from}${where} ${op} SELECT ${b} FROM ${t2.name} z`, ordered: false };
    }
    if (mode === 4) {
      this.feat('window');
      const t = scope[0];
      const part = this.refsOf([t], this.pick(['int', 'text'] as Ty[]));
      const p = part.length && this.chance(0.7) ? `PARTITION BY ${this.pick(part).expr} ` : '';
      const fn = this.pick(['row_number()', 'rank()', 'dense_rank()', `sum(${this.expr([t], 'int', 0)})`, `count(*)`, `max(${this.expr([t], 'int', 0)})`]);
      const order = this.chance(0.5) ? `${t.alias}.id` : `${this.expr([t], 'int', 0)}, ${t.alias}.id`;
      return { sql: `SELECT ${t.alias}.id, ${fn} OVER (${p}ORDER BY ${order}) FROM ${t.table.name} ${t.alias}${where.includes('.') && scope.length === 1 ? where : ''}`, ordered: false };
    }
    // plain projection
    const n = this.int(1, 4);
    const cols: string[] = [];
    for (let i = 0; i < n; i++) cols.push(this.expr(scope, this.pick(['int', 'real', 'text'] as Ty[]), this.int(0, 2)));
    if (this.chance(0.15)) {
      this.feat('scalar-subquery');
      const t = this.pick(this.tables);
      const inner = [{ alias: 'q', table: t }];
      cols.push(`(SELECT count(*) FROM ${t.name} q WHERE ${this.correlation(scope, inner)})`);
    }
    const distinct = this.chance(0.2) ? 'DISTINCT ' : '';
    if (distinct) this.feat('distinct');
    let sql = `SELECT ${distinct}${cols.join(', ')} FROM ${from}${where}`;
    if (this.chance(0.35)) {
      this.feat('order-limit');
      const dirs = cols.map((_, i) => `${i + 1}${this.chance(0.4) ? ' DESC' : ''}`);
      const base = `${sql} ORDER BY ${dirs.join(', ')}`;
      const limit = this.int(1, 8);
      const offset = this.chance(0.3) ? this.int(1, 3) : 0;
      sql = `${base} LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ''}`;
      return { sql, ordered: true, base, limit, offset };
    }
    return { sql, ordered: false };
  }

  dml(): string {
    const t = this.pick(this.tables);
    const scope = [{ alias: t.name, table: t }];
    const k = this.int(0, 2);
    if (k === 0) {
      this.feat('insert');
      const vals = t.cols.map((c) => (c.name === 'id' ? 'NULL' : this.literal(c.ty)));
      return `INSERT INTO ${t.name} VALUES (${vals.join(', ')})`;
    }
    if (k === 1) {
      this.feat('update');
      const c = this.pick(t.cols.filter((x) => x.name !== 'id'));
      return `UPDATE ${t.name} SET ${c.name} = ${this.expr(scope, c.ty, 1)} WHERE ${this.bool(scope, 1, false)}`;
    }
    this.feat('delete');
    return `DELETE FROM ${t.name} WHERE ${this.bool(scope, 1, false)}`;
  }
}

// ------------------------------------------------------------------ comparison

function norm(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

function valueEq(a: unknown, b: unknown): boolean {
  a = norm(a);
  b = norm(b);
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return false;
}

function rowKey(r: unknown[]): string {
  return JSON.stringify(
    r.map((v) => {
      v = norm(v);
      return typeof v === 'number' ? Number(v.toPrecision(10)) : v;
    }),
  );
}

function sameRows(a: unknown[][], b: unknown[][], ordered: boolean): boolean {
  if (a.length !== b.length) return false;
  if (!ordered) {
    a = [...a].sort((x, y) => (rowKey(x) < rowKey(y) ? -1 : rowKey(x) > rowKey(y) ? 1 : 0));
    b = [...b].sort((x, y) => (rowKey(x) < rowKey(y) ? -1 : rowKey(x) > rowKey(y) ? 1 : 0));
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) if (!valueEq(a[i][j], b[i][j])) return false;
  }
  return true;
}

function preview(rows: unknown[][]): string {
  const s = JSON.stringify(rows.map((r) => r.map(norm)));
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

export function runFuzz(opts: FuzzOptions): FuzzStats {
  const g = new Gen(opts.seed);
  const setup = g.schema();
  const lite = new DatabaseSync(':memory:');
  // second SQLite instance without secondary indexes: a reference that avoids SQLite's own index code paths
  const plain = new DatabaseSync(':memory:');
  const opus = new Database();
  for (const s of setup) {
    lite.exec(s);
    opus.exec(s);
    if (!s.startsWith('CREATE INDEX')) plain.exec(s);
  }
  const liteRows = (db: DatabaseSync, sql: string): unknown[][] => {
    const stmt = db.prepare(sql);
    stmt.setReturnArrays(true);
    return stmt.all() as unknown as unknown[][];
  };
  const stats: FuzzStats = { queries: 0, agreed: 0, sqliteBugs: [], bothErrored: 0, mismatches: [], rowsCompared: 0, features: g.features };
  const history = [...setup];
  const mismatch = (sql: string, o: string, l: string) => {
    const m = { seed: opts.seed, sql, opus: o, sqlite: l, setup: [...history] };
    stats.mismatches.push(m);
    opts.onMismatch?.(m);
  };
  const dmlEvery = opts.dml ? Math.max(1, Math.floor(opts.queries / opts.dml)) : 0;
  for (let i = 0; i < opts.queries; i++) {
    if (dmlEvery && i % dmlEvery === dmlEvery - 1) {
      const sql = g.dml();
      let le: string | null = null;
      let oe: string | null = null;
      try {
        lite.exec(sql);
        plain.exec(sql);
      } catch (e) {
        le = (e as Error).message;
      }
      try {
        opus.exec(sql);
      } catch (e) {
        oe = (e as Error).message;
      }
      history.push(sql);
      if ((le === null) !== (oe === null)) mismatch(sql, oe ?? 'ok', le ?? 'ok');
      for (const t of g.tables) {
        const q = `SELECT * FROM ${t.name} ORDER BY id`;
        const a = opus.query(q).rows;
        const b = liteRows(lite, q);
        if (!sameRows(a, b, true)) mismatch(`${sql}  -- then ${q}`, preview(a), preview(b));
      }
      const problems = opus.inspect.integrityCheck();
      if (problems.length) mismatch(`integrity after ${sql}`, problems.join('; '), 'ok');
      continue;
    }
    const { sql, ordered, base, limit, offset } = g.select();
    stats.queries++;
    let a: Value[][] | null = null;
    let b: unknown[][] | null = null;
    let oe = '';
    let le = '';
    try {
      a = opus.query(sql).rows;
    } catch (e) {
      oe = (e as Error).message;
    }
    try {
      b = liteRows(lite, sql);
    } catch (e) {
      le = (e as Error).message;
    }
    if (a === null && b === null) {
      stats.bothErrored++;
      continue;
    }
    if (a === null || b === null) {
      mismatch(sql, a === null ? `ERROR ${oe}` : preview(a), b === null ? `ERROR ${le}` : preview(b));
      continue;
    }
    stats.rowsCompared += a.length;
    if (sameRows(a, b, ordered)) {
      stats.agreed++;
      continue;
    }
    let ref: unknown[][] | null = null;
    try {
      ref = liteRows(plain, sql);
    } catch {
      ref = null;
    }
    if (!(ref && sameRows(a, ref, ordered)) && base !== undefined) {
      // second oracle: SQLite's full ordered result, with LIMIT/OFFSET applied here
      try {
        const full = liteRows(plain, base).slice(offset ?? 0, (offset ?? 0) + (limit ?? 0));
        if (sameRows(a, full, true)) ref = full;
      } catch {
        // keep the first reference
      }
    }
    if (ref && sameRows(a, ref, ordered) && !sameRows(b, ref, ordered)) {
      stats.agreed++;
      stats.sqliteBugs.push({ seed: opts.seed, sql, opus: preview(a), sqlite: preview(b), setup: [...history] });
    } else mismatch(sql, preview(a), preview(b));
  }
  lite.close();
  plain.close();
  opus.close();
  return stats;
}
