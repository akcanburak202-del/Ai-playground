import type { Row, Value } from '../types.ts';
import { compareValues, ErrorCode, hashKey, OpusError, tupleKey } from '../types.ts';
import type { BTree, Cursor } from '../storage/btree.ts';
import type { IndexSchema } from '../catalog.ts';
import type { JoinKind, SortKey, WindowFuncSpec, AggSpec } from '../plan/bound.ts';
import type { ExecContext } from './context.ts';
import type { Compiled } from './expr.ts';
import { keyComparator, truth } from './expr.ts';
import { AGGREGATE_FUNCTIONS, toInteger, toNumber } from './functions.ts';
import type { AggState } from './functions.ts';
import type { TableAccess } from './table.ts';

/**
 * Volcano-style physical operators. Each operator produces rows through
 * next() and can be re-opened any number of times (the inner side of a
 * nested-loop join, correlated subqueries and prepared statements rely on it).
 */
export abstract class Operator {
  abstract readonly name: string;
  /** Column ids of the produced rows, in order. */
  layout: number[] = [];
  children: Operator[] = [];
  /** Planner estimates. */
  estRows = 0;
  cost = 0;
  /** Human readable details for EXPLAIN. */
  details: string[] = [];
  // runtime statistics (EXPLAIN ANALYZE)
  statRows = 0;
  statLoops = 0;
  statTime = 0;
  readonly ctx: ExecContext;

  constructor(ctx: ExecContext) {
    this.ctx = ctx;
  }

  abstract open(): void;
  abstract next(): Row | null;
  close(): void {
    for (const c of this.children) c.close();
  }
}

/** Wraps open()/next() of every operator in the tree with timing and row counters. */
export function instrument(op: Operator): void {
  const open = op.open.bind(op);
  const next = op.next.bind(op);
  op.open = () => {
    op.statLoops++;
    const t = performance.now();
    open();
    op.statTime += performance.now() - t;
  };
  op.next = () => {
    const t = performance.now();
    const r = next();
    op.statTime += performance.now() - t;
    if (r) op.statRows++;
    return r;
  };
  for (const c of op.children) instrument(c);
}

// ------------------------------------------------------------------ scans

export class SeqScan extends Operator {
  readonly name = 'Seq Scan';
  private readonly access: TableAccess;
  private readonly filter?: Compiled;
  private readonly reverse: boolean;
  private cursor!: Cursor;
  private ok = false;

  constructor(ctx: ExecContext, access: TableAccess, filter?: Compiled, reverse = false) {
    super(ctx);
    this.access = access;
    this.filter = filter;
    this.reverse = reverse;
  }
  open(): void {
    this.cursor = this.access.tree.cursor();
    this.ok = this.reverse ? this.cursor.last() : this.cursor.first();
  }
  next(): Row | null {
    const c = this.cursor;
    const filter = this.filter;
    const ctx = this.ctx;
    while (this.ok) {
      const row = this.access.decode(c.payload(), c.rowid());
      this.ok = this.reverse ? c.prev() : c.next();
      ctx.tick();
      ctx.rowsScanned++;
      if (!filter || truth(filter(row)) === true) return row;
    }
    return null;
  }
}

export interface Bound {
  fn: Compiled;
  incl: boolean;
}

/** Normalises a probe value for a rowid lookup; returns undefined when nothing can match. */
function rowidProbe(v: Value): number | undefined {
  if (v === null) return undefined;
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = toNumber(v)!;
  return /^\s*[+-]?\d+(\.0*)?\s*$/.test(v) && Number.isInteger(n) ? n : undefined;
}

/** Lookup by rowid (INTEGER PRIMARY KEY): point lookups or a key range. */
export class RowidScan extends Operator {
  readonly name: string;
  private readonly access: TableAccess;
  private readonly keys?: Compiled[];
  private readonly lo?: Bound;
  private readonly hi?: Bound;
  private readonly reverse: boolean;
  private readonly filter?: Compiled;
  private pending: number[] = [];
  private cursor?: Cursor;
  private ok = false;
  private hiVal: number | undefined;
  private loVal: number | undefined;

  constructor(ctx: ExecContext, access: TableAccess, spec: { keys?: Compiled[]; lo?: Bound; hi?: Bound; reverse?: boolean }, filter?: Compiled) {
    super(ctx);
    this.access = access;
    this.keys = spec.keys;
    this.lo = spec.lo;
    this.hi = spec.hi;
    this.reverse = !!spec.reverse;
    this.filter = filter;
    this.name = spec.keys ? 'Rowid Lookup' : 'Rowid Range Scan';
  }

  open(): void {
    if (this.keys) {
      const set = new Set<number>();
      for (const k of this.keys) {
        const v = rowidProbe(k([]));
        if (v !== undefined) set.add(v);
      }
      this.pending = [...set].sort((a, b) => (this.reverse ? b - a : a - b));
      return;
    }
    this.cursor = this.access.tree.cursor();
    this.ok = true;
    const bound = (b: Bound | undefined, isLow: boolean): number | undefined | null => {
      if (!b) return undefined;
      const v = b.fn([]);
      if (v === null) return null;
      let n = toNumber(v)!;
      // x > 2.5 on an integer key is x >= 3 ; x < 2.5 is x <= 2
      if (!Number.isInteger(n)) n = isLow ? Math.ceil(n) - (b.incl ? 0 : 0) : Math.floor(n);
      return n;
    };
    const lo = bound(this.lo, true);
    const hi = bound(this.hi, false);
    if (lo === null || hi === null) {
      this.ok = false;
      return;
    }
    const loFrac = this.lo && !Number.isInteger(toNumber(this.lo.fn([]))!);
    const hiFrac = this.hi && !Number.isInteger(toNumber(this.hi.fn([]))!);
    const loIncl = this.lo ? this.lo.incl || !!loFrac : true;
    const hiIncl = this.hi ? this.hi.incl || !!hiFrac : true;
    this.loVal = lo === undefined ? undefined : loIncl ? lo : lo + 1;
    this.hiVal = hi === undefined ? undefined : hiIncl ? hi : hi - 1;
    if (!this.reverse) this.ok = this.loVal === undefined ? this.cursor.first() : this.cursor.seek(this.loVal);
    else this.ok = this.hiVal === undefined ? this.cursor.last() : this.cursor.seekLast(this.hiVal);
  }

  next(): Row | null {
    const filter = this.filter;
    if (this.keys) {
      while (this.pending.length) {
        const id = this.pending.shift()!;
        const row = this.access.get(id);
        this.ctx.rowsScanned++;
        if (row && (!filter || truth(filter(row)) === true)) return row;
      }
      return null;
    }
    const c = this.cursor!;
    while (this.ok) {
      const rowid = c.rowid();
      if (!this.reverse ? this.hiVal !== undefined && rowid > this.hiVal : this.loVal !== undefined && rowid < this.loVal) {
        this.ok = false;
        return null;
      }
      const row = this.access.decode(c.payload(), rowid);
      this.ok = this.reverse ? c.prev() : c.next();
      this.ctx.tick();
      this.ctx.rowsScanned++;
      if (!filter || truth(filter(row)) === true) return row;
    }
    return null;
  }
}

export interface IndexScanSpec {
  eq: Compiled[];
  /** IN-list values for the column following the equality prefix. */
  inList?: Compiled[];
  lo?: Bound;
  hi?: Bound;
  reverse: boolean;
  covering: boolean;
  /** Affinity conversion applied to probe values for each index column. */
  affinity: ((v: Value) => Value)[];
}

export class IndexScan extends Operator {
  readonly name: string;
  private readonly access: TableAccess;
  readonly index: IndexSchema;
  private readonly itree: BTree;
  private readonly spec: IndexScanSpec;
  private readonly filter?: Compiled;
  private probes: Value[][] = [];
  private probeIdx = 0;
  private prefix: Value[] = [];
  private cursor!: Cursor;
  private ok = false;
  private loV: Value | undefined;
  private hiV: Value | undefined;
  private hasRange = false;

  constructor(ctx: ExecContext, access: TableAccess, index: IndexSchema, itree: BTree, spec: IndexScanSpec, filter?: Compiled) {
    super(ctx);
    this.access = access;
    this.index = index;
    this.itree = itree;
    this.spec = spec;
    this.filter = filter;
    this.name = spec.covering ? 'Index Only Scan' : 'Index Scan';
  }

  open(): void {
    const s = this.spec;
    this.probes = [];
    this.probeIdx = 0;
    this.ok = false;
    const eq: Value[] = [];
    for (let i = 0; i < s.eq.length; i++) {
      const v = s.affinity[i](s.eq[i]([]));
      if (v === null) return; // col = NULL never matches
      eq.push(v);
    }
    if (s.inList) {
      const k = s.eq.length;
      const seen = new Set<unknown>();
      const vals: Value[] = [];
      for (const f of s.inList) {
        const v = s.affinity[k](f([]));
        if (v === null) continue;
        const hk = hashKey(v);
        if (seen.has(hk)) continue;
        seen.add(hk);
        vals.push(v);
      }
      vals.sort((a, b) => (this.spec.reverse ? -compareValues(a, b) : compareValues(a, b)));
      for (const v of vals) this.probes.push([...eq, v]);
    } else this.probes.push(eq);
    this.hasRange = !!(s.lo || s.hi);
    if (s.lo) {
      const v = s.lo.fn([]);
      if (v === null) return;
      this.loV = s.affinity[s.eq.length](v);
    } else this.loV = undefined;
    if (s.hi) {
      const v = s.hi.fn([]);
      if (v === null) return;
      this.hiV = s.affinity[s.eq.length](v);
    } else this.hiV = undefined;
    this.cursor = this.itree.cursor();
    this.startProbe();
  }

  private startProbe(): void {
    while (this.probeIdx < this.probes.length) {
      const p = this.probes[this.probeIdx++];
      this.prefix = p;
      const c = this.cursor;
      const s = this.spec;
      if (!s.reverse) {
        if (this.loV !== undefined) this.ok = c.seek([...p, this.loV], !s.lo!.incl);
        else if (this.hasRange) this.ok = c.seek([...p, null], true);
        else this.ok = p.length ? c.seek(p) : c.first();
      } else {
        if (this.hiV !== undefined) this.ok = c.seekLast([...p, this.hiV], !s.hi!.incl);
        else this.ok = p.length ? c.seekLast(p) : c.last();
      }
      if (this.ok) return;
    }
    this.ok = false;
  }

  next(): Row | null {
    const c = this.cursor;
    const s = this.spec;
    const k = this.prefix.length;
    const filter = this.filter;
    while (this.ok) {
      const key = c.key() as Value[];
      let done = false;
      if (k && this.itree.cmpPrefix(key, this.prefix) !== 0) done = true;
      else if (this.hasRange) {
        const v = key[s.inList ? k - 1 : k];
        if (!s.reverse) {
          if (this.hiV !== undefined) {
            const cmp = compareValues(v, this.hiV);
            if (cmp > 0 || (cmp === 0 && !s.hi!.incl)) done = true;
          }
        } else {
          if (v === null) done = true;
          else if (this.loV !== undefined) {
            const cmp = compareValues(v, this.loV);
            if (cmp < 0 || (cmp === 0 && !s.lo!.incl)) done = true;
          }
        }
      }
      if (done) {
        this.startProbe();
        continue;
      }
      this.ok = s.reverse ? c.prev() : c.next();
      if (!this.ok) this.startProbe();
      this.ctx.tick();
      this.ctx.rowsScanned++;
      const rowid = key[key.length - 1] as number;
      let row: Row | undefined;
      if (s.covering) {
        const n = this.access.ncols;
        row = new Array<Value>(n + 1).fill(null);
        const cols = this.index.columns;
        for (let i = 0; i < cols.length; i++) row[cols[i]] = key[i];
        row[n] = rowid;
        if (this.access.rowidCol >= 0) row[this.access.rowidCol] = rowid;
      } else {
        row = this.access.get(rowid);
        if (!row) throw new OpusError(ErrorCode.corrupt, `index ${this.index.name} points to missing row ${rowid}`);
      }
      if (!filter || truth(filter(row)) === true) return row;
    }
    return null;
  }
}

// ------------------------------------------------------------------ simple relational operators

export class Filter extends Operator {
  readonly name = 'Filter';
  private readonly pred: Compiled;
  constructor(ctx: ExecContext, input: Operator, pred: Compiled) {
    super(ctx);
    this.children = [input];
    this.layout = input.layout;
    this.pred = pred;
  }
  open(): void {
    this.children[0].open();
  }
  next(): Row | null {
    const input = this.children[0];
    for (let r = input.next(); r; r = input.next()) if (truth(this.pred(r)) === true) return r;
    return null;
  }
}

export class Project extends Operator {
  readonly name = 'Project';
  private readonly exprs: Compiled[];
  constructor(ctx: ExecContext, input: Operator, exprs: Compiled[], layout: number[]) {
    super(ctx);
    this.children = [input];
    this.exprs = exprs;
    this.layout = layout;
  }
  open(): void {
    this.children[0].open();
  }
  next(): Row | null {
    const r = this.children[0].next();
    if (!r) return null;
    const ex = this.exprs;
    const out = new Array<Value>(ex.length);
    for (let i = 0; i < ex.length; i++) out[i] = ex[i](r);
    return out;
  }
}

export class Limit extends Operator {
  readonly name = 'Limit';
  private readonly limitFn?: Compiled;
  private readonly offsetFn?: Compiled;
  private remaining = 0;
  private skip = 0;
  constructor(ctx: ExecContext, input: Operator, limit?: Compiled, offset?: Compiled) {
    super(ctx);
    this.children = [input];
    this.layout = input.layout;
    this.limitFn = limit;
    this.offsetFn = offset;
  }
  open(): void {
    const l = this.limitFn ? toInteger(this.limitFn([])) : null;
    this.remaining = l === null || l < 0 ? Infinity : l;
    const o = this.offsetFn ? toInteger(this.offsetFn([])) : null;
    this.skip = o === null || o < 0 ? 0 : o;
    if (this.remaining > 0) this.children[0].open();
  }
  next(): Row | null {
    if (this.remaining <= 0) return null;
    const input = this.children[0];
    while (this.skip > 0) {
      if (!input.next()) return null;
      this.skip--;
    }
    const r = input.next();
    if (!r) return null;
    this.remaining--;
    return r;
  }
}

export class Values extends Operator {
  readonly name = 'Values';
  private readonly rows: Compiled[][];
  private i = 0;
  constructor(ctx: ExecContext, rows: Compiled[][], layout: number[]) {
    super(ctx);
    this.rows = rows;
    this.layout = layout;
  }
  open(): void {
    this.i = 0;
  }
  next(): Row | null {
    if (this.i >= this.rows.length) return null;
    const exprs = this.rows[this.i++];
    return exprs.map((f) => f([]));
  }
}

export class GenerateSeries extends Operator {
  readonly name = 'Function Scan';
  private readonly args: Compiled[];
  private cur = 0;
  private stop = 0;
  private step = 1;
  constructor(ctx: ExecContext, args: Compiled[], layout: number[]) {
    super(ctx);
    this.args = args;
    this.layout = layout;
    this.details.push('generate_series');
  }
  open(): void {
    const vals = this.args.map((f) => toNumber(f([])));
    if (vals.some((v) => v === null)) {
      this.cur = 1;
      this.stop = 0;
      this.step = 1;
      return;
    }
    if (vals.length === 1) {
      this.cur = 1;
      this.stop = vals[0]!;
    } else {
      this.cur = vals[0]!;
      this.stop = vals[1]!;
    }
    this.step = vals[2] ?? 1;
    if (this.step === 0) throw new OpusError(ErrorCode.invalidParameter, 'generate_series step cannot be zero');
  }
  next(): Row | null {
    if (this.step > 0 ? this.cur > this.stop : this.cur < this.stop) return null;
    const v = this.cur;
    this.cur += this.step;
    this.ctx.tick();
    return [v];
  }
}

export class Distinct extends Operator {
  readonly name = 'HashDistinct';
  private seen = new Set<string>();
  constructor(ctx: ExecContext, input: Operator) {
    super(ctx);
    this.children = [input];
    this.layout = input.layout;
  }
  open(): void {
    this.seen = new Set();
    this.children[0].open();
  }
  next(): Row | null {
    const input = this.children[0];
    for (let r = input.next(); r; r = input.next()) {
      const k = tupleKey(r);
      if (!this.seen.has(k)) {
        this.seen.add(k);
        return r;
      }
    }
    return null;
  }
}

/** Caches the rows of its (uncorrelated) input for the duration of one statement execution. */
export class Materialize extends Operator {
  readonly name = 'Materialize';
  private rows: Row[] | null = null;
  private execId = -1;
  private i = 0;
  constructor(ctx: ExecContext, input: Operator) {
    super(ctx);
    this.children = [input];
    this.layout = input.layout;
  }
  open(): void {
    if (!this.rows || this.execId !== this.ctx.execId) {
      const input = this.children[0];
      const rows: Row[] = [];
      input.open();
      for (let r = input.next(); r; r = input.next()) rows.push(r);
      input.close();
      this.rows = rows;
      this.execId = this.ctx.execId;
    }
    this.i = 0;
  }
  next(): Row | null {
    return this.i < this.rows!.length ? this.rows![this.i++] : null;
  }
  override close(): void {}
}

// ------------------------------------------------------------------ joins

function nullRow(n: number): Row {
  return new Array<Value>(n).fill(null);
}

export class NestedLoopJoin extends Operator {
  name: string;
  private readonly kind: JoinKind;
  private readonly cond?: Compiled;
  /** Outer columns published to ctx.outer for a parameterised inner side. */
  private readonly bindings: [number, number][];
  private cur: Row | null = null;
  private matched = false;
  private innerWidth = 0;
  // FULL JOIN support: materialised inner rows + matched flags
  private innerRows: Row[] | null = null;
  private innerMatched: Uint8Array | null = null;
  private innerPos = 0;
  private unmatchedPos = -1;

  constructor(ctx: ExecContext, outer: Operator, inner: Operator, kind: JoinKind, cond: Compiled | undefined, bindings: [number, number][]) {
    super(ctx);
    this.children = [outer, inner];
    this.kind = kind;
    this.cond = cond;
    this.bindings = bindings;
    this.layout = kind === 'semi' || kind === 'anti' ? outer.layout : [...outer.layout, ...inner.layout];
    this.innerWidth = inner.layout.length;
    this.name = kind === 'inner' ? 'Nested Loop' : `Nested Loop ${kind[0].toUpperCase()}${kind.slice(1)} Join`;
  }

  open(): void {
    this.children[0].open();
    this.cur = null;
    this.unmatchedPos = -1;
    if (this.kind === 'full') {
      const inner = this.children[1];
      this.innerRows = [];
      inner.open();
      for (let r = inner.next(); r; r = inner.next()) this.innerRows.push(r);
      this.innerMatched = new Uint8Array(this.innerRows.length);
    }
  }

  private nextInner(): Row | null {
    if (this.innerRows) return this.innerPos < this.innerRows.length ? this.innerRows[this.innerPos++] : null;
    return this.children[1].next();
  }

  next(): Row | null {
    const [outer, inner] = this.children;
    const kind = this.kind;
    for (;;) {
      if (this.unmatchedPos >= 0) {
        const rows = this.innerRows!;
        while (this.unmatchedPos < rows.length) {
          const i = this.unmatchedPos++;
          if (!this.innerMatched![i]) return nullRow(outer.layout.length).concat(rows[i]);
        }
        return null;
      }
      if (!this.cur) {
        this.cur = outer.next();
        if (!this.cur) {
          if (kind === 'full') {
            this.unmatchedPos = 0;
            continue;
          }
          return null;
        }
        for (const [id, pos] of this.bindings) this.ctx.outer[id] = this.cur[pos];
        this.matched = false;
        if (this.innerRows) this.innerPos = 0;
        else inner.open();
      }
      const o = this.cur;
      for (let r = this.nextInner(); r; r = this.nextInner()) {
        this.ctx.tick();
        const combined = o.concat(r);
        if (this.cond && truth(this.cond(combined)) !== true) continue;
        this.matched = true;
        if (kind === 'semi') {
          this.cur = null;
          return o;
        }
        if (kind === 'anti') break;
        if (kind === 'full') this.innerMatched![this.innerPos - 1] = 1;
        return combined;
      }
      this.cur = null;
      if (!this.matched) {
        if (kind === 'left' || kind === 'full') return o.concat(nullRow(this.innerWidth));
        if (kind === 'anti') return o;
      }
    }
  }
}

export class HashJoin extends Operator {
  readonly name: string;
  private readonly kind: JoinKind;
  private readonly probeKeys: Compiled[];
  private readonly buildKeys: Compiled[];
  private readonly residual?: Compiled;
  private table = new Map<unknown, number[]>();
  private buildRows: Row[] = [];
  private buildMatched: Uint8Array | null = null;
  private cur: Row | null = null;
  private bucket: number[] | null = null;
  private bucketPos = 0;
  private matched = false;
  private unmatchedPos = -1;

  constructor(ctx: ExecContext, probe: Operator, build: Operator, kind: JoinKind, probeKeys: Compiled[], buildKeys: Compiled[], residual?: Compiled) {
    super(ctx);
    this.children = [probe, build];
    this.kind = kind;
    this.probeKeys = probeKeys;
    this.buildKeys = buildKeys;
    this.residual = residual;
    this.layout = kind === 'semi' || kind === 'anti' ? probe.layout : [...probe.layout, ...build.layout];
    this.name = kind === 'inner' ? 'Hash Join' : `Hash ${kind[0].toUpperCase()}${kind.slice(1)} Join`;
  }

  private key(fns: Compiled[], row: Row): unknown {
    if (fns.length === 1) {
      const v = fns[0](row);
      return v === null ? undefined : hashKey(v);
    }
    const vals = fns.map((f) => f(row));
    if (vals.some((v) => v === null)) return undefined;
    return tupleKey(vals);
  }

  open(): void {
    const build = this.children[1];
    this.table = new Map();
    this.buildRows = [];
    build.open();
    for (let r = build.next(); r; r = build.next()) {
      this.ctx.tick();
      const idx = this.buildRows.length;
      this.buildRows.push(r);
      const k = this.key(this.buildKeys, r);
      if (k === undefined) continue;
      const b = this.table.get(k);
      if (b) b.push(idx);
      else this.table.set(k, [idx]);
    }
    build.close();
    this.buildMatched = this.kind === 'full' ? new Uint8Array(this.buildRows.length) : null;
    this.children[0].open();
    this.cur = null;
    this.bucket = null;
    this.unmatchedPos = -1;
  }

  next(): Row | null {
    const probe = this.children[0];
    const kind = this.kind;
    for (;;) {
      if (this.unmatchedPos >= 0) {
        while (this.unmatchedPos < this.buildRows.length) {
          const i = this.unmatchedPos++;
          if (!this.buildMatched![i]) return nullRow(probe.layout.length).concat(this.buildRows[i]);
        }
        return null;
      }
      if (!this.cur) {
        this.cur = probe.next();
        if (!this.cur) {
          if (kind === 'full') {
            this.unmatchedPos = 0;
            continue;
          }
          return null;
        }
        const k = this.key(this.probeKeys, this.cur);
        this.bucket = k === undefined ? null : (this.table.get(k) ?? null);
        this.bucketPos = 0;
        this.matched = false;
      }
      const o = this.cur;
      const bucket = this.bucket;
      if (bucket) {
        while (this.bucketPos < bucket.length) {
          const bi = bucket[this.bucketPos++];
          const combined = o.concat(this.buildRows[bi]);
          if (this.residual && truth(this.residual(combined)) !== true) continue;
          this.matched = true;
          if (kind === 'semi') {
            this.cur = null;
            return o;
          }
          if (kind === 'anti') break;
          if (this.buildMatched) this.buildMatched[bi] = 1;
          return combined;
        }
      }
      this.cur = null;
      if (!this.matched) {
        if (kind === 'left' || kind === 'full') return o.concat(nullRow(this.children[1].layout.length));
        if (kind === 'anti') return o;
      }
    }
  }
}

// ------------------------------------------------------------------ aggregation

export interface CompiledAgg {
  spec: AggSpec;
  args: Compiled[];
  filter?: Compiled;
  orderBy?: { keys: Compiled[]; cmp: (a: Value[], b: Value[]) => number };
}

class SortedAggState implements AggState {
  private readonly rows: { args: Value[]; key: Value[] }[] = [];
  private readonly make: () => AggState;
  private readonly cmp: (a: Value[], b: Value[]) => number;
  constructor(make: () => AggState, cmp: (a: Value[], b: Value[]) => number) {
    this.make = make;
    this.cmp = cmp;
  }
  step(args: Value[], key?: Value[]): void {
    this.rows.push({ args, key: key ?? [] });
  }
  final(): Value {
    this.rows.sort((a, b) => this.cmp(a.key, b.key));
    const s = this.make();
    for (const r of this.rows) s.step(r.args);
    return s.final();
  }
}

class DistinctAggState implements AggState {
  private readonly seen = new Set<string>();
  private readonly inner: AggState;
  constructor(inner: AggState) {
    this.inner = inner;
  }
  step(args: Value[]): void {
    if (args[0] === null) return;
    const k = tupleKey(args.slice(0, 1));
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.inner.step(args);
  }
  final(): Value {
    return this.inner.final();
  }
}

export function createAggState(a: CompiledAgg): AggState {
  const def = AGGREGATE_FUNCTIONS[a.spec.name];
  const types = a.spec.args.map((x) => x.type);
  let make = () => def.create(types);
  if (a.spec.distinct) {
    const base = make;
    make = () => new DistinctAggState(base());
  }
  if (a.orderBy) return new SortedAggState(make, a.orderBy.cmp);
  return make();
}

export function stepAgg(a: CompiledAgg, state: AggState, row: Row): void {
  if (a.filter && truth(a.filter(row)) !== true) return;
  const args = a.args.length === 1 ? [a.args[0](row)] : a.args.map((f) => f(row));
  if (a.orderBy) (state as SortedAggState).step(args, a.orderBy.keys.map((k) => k(row)));
  else state.step(args);
}

export class HashAggregate extends Operator {
  readonly name: string;
  private readonly groups: Compiled[];
  private readonly aggs: CompiledAgg[];
  private out: Row[] = [];
  private i = 0;

  constructor(ctx: ExecContext, input: Operator, groups: Compiled[], aggs: CompiledAgg[], layout: number[]) {
    super(ctx);
    this.children = [input];
    this.groups = groups;
    this.aggs = aggs;
    this.layout = layout;
    this.name = groups.length ? 'HashAggregate' : 'Aggregate';
  }

  open(): void {
    const input = this.children[0];
    const groups = this.groups;
    const aggs = this.aggs;
    const map = new Map<unknown, { vals: Value[]; states: AggState[] }>();
    input.open();
    const single = groups.length === 1;
    for (let r = input.next(); r; r = input.next()) {
      this.ctx.tick();
      let key: unknown;
      let vals: Value[];
      if (groups.length === 0) {
        key = 0;
        vals = [];
      } else if (single) {
        const v = groups[0](r);
        key = hashKey(v);
        vals = [v];
      } else {
        vals = groups.map((g) => g(r));
        key = tupleKey(vals);
      }
      let g = map.get(key);
      if (!g) {
        g = { vals, states: aggs.map(createAggState) };
        map.set(key, g);
      }
      for (let i = 0; i < aggs.length; i++) stepAgg(aggs[i], g.states[i], r);
    }
    input.close();
    if (groups.length === 0 && map.size === 0) map.set(0, { vals: [], states: aggs.map(createAggState) });
    this.out = [];
    for (const g of map.values()) this.out.push([...g.vals, ...g.states.map((s) => s.final())]);
    this.i = 0;
  }

  next(): Row | null {
    return this.i < this.out.length ? this.out[this.i++] : null;
  }
  override close(): void {}
}

// ------------------------------------------------------------------ sorting

export class Sort extends Operator {
  readonly name = 'Sort';
  private readonly keys: Compiled[];
  private readonly cmp: (a: Value[], b: Value[]) => number;
  private rows: Row[] = [];
  private i = 0;
  constructor(ctx: ExecContext, input: Operator, keys: Compiled[], dirs: SortKey[]) {
    super(ctx);
    this.children = [input];
    this.layout = input.layout;
    this.keys = keys;
    this.cmp = keyComparator(dirs);
  }
  open(): void {
    const input = this.children[0];
    const items: { row: Row; key: Value[] }[] = [];
    input.open();
    for (let r = input.next(); r; r = input.next()) {
      this.ctx.tick();
      items.push({ row: r, key: this.keys.map((k) => k(r)) });
    }
    input.close();
    const cmp = this.cmp;
    items.sort((a, b) => cmp(a.key, b.key));
    this.rows = items.map((x) => x.row);
    this.i = 0;
  }
  next(): Row | null {
    return this.i < this.rows.length ? this.rows[this.i++] : null;
  }
  override close(): void {}
}

/** ORDER BY ... LIMIT n: keeps only the best n rows in a binary heap. */
export class TopN extends Operator {
  readonly name = 'Top-N Sort';
  private readonly keys: Compiled[];
  private readonly cmp: (a: Value[], b: Value[]) => number;
  private readonly limitFn?: Compiled;
  private readonly offsetFn?: Compiled;
  private rows: Row[] = [];
  private i = 0;
  constructor(ctx: ExecContext, input: Operator, keys: Compiled[], dirs: SortKey[], limit?: Compiled, offset?: Compiled) {
    super(ctx);
    this.children = [input];
    this.layout = input.layout;
    this.keys = keys;
    this.cmp = keyComparator(dirs);
    this.limitFn = limit;
    this.offsetFn = offset;
  }
  open(): void {
    const l = this.limitFn ? toInteger(this.limitFn([])) : null;
    const o = this.offsetFn ? toInteger(this.offsetFn([])) : null;
    const limit = l === null || l < 0 ? Infinity : l;
    const offset = o === null || o < 0 ? 0 : o;
    const n = limit + offset;
    this.rows = [];
    this.i = 0;
    if (limit === 0) return;
    const input = this.children[0];
    const cmp = this.cmp;
    // max-heap on (key, seq) so ties keep input order (stable)
    type Item = { row: Row; key: Value[]; seq: number };
    const heap: Item[] = [];
    const worse = (a: Item, b: Item) => {
      const c = cmp(a.key, b.key);
      return c > 0 || (c === 0 && a.seq > b.seq);
    };
    const up = (i: number) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!worse(heap[i], heap[p])) break;
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      }
    };
    const down = (i: number) => {
      for (;;) {
        const l2 = 2 * i + 1;
        const r2 = l2 + 1;
        let m = i;
        if (l2 < heap.length && worse(heap[l2], heap[m])) m = l2;
        if (r2 < heap.length && worse(heap[r2], heap[m])) m = r2;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    };
    input.open();
    let seq = 0;
    for (let r = input.next(); r; r = input.next()) {
      this.ctx.tick();
      const item = { row: r, key: this.keys.map((k) => k(r)), seq: seq++ };
      if (heap.length < n) {
        heap.push(item);
        up(heap.length - 1);
      } else if (worse(heap[0], item)) {
        heap[0] = item;
        down(0);
      }
    }
    input.close();
    heap.sort((a, b) => cmp(a.key, b.key) || a.seq - b.seq);
    this.rows = heap.slice(offset).map((x) => x.row);
  }
  next(): Row | null {
    return this.i < this.rows.length ? this.rows[this.i++] : null;
  }
  override close(): void {}
}

// ------------------------------------------------------------------ set operations

export class SetOp extends Operator {
  readonly name: string;
  private readonly kind: 'union' | 'unionall' | 'intersect' | 'except';
  private side = 0;
  private seen = new Set<string>();
  private other = new Set<string>();
  constructor(ctx: ExecContext, left: Operator, right: Operator, kind: 'union' | 'unionall' | 'intersect' | 'except', layout: number[]) {
    super(ctx);
    this.children = [left, right];
    this.kind = kind;
    this.layout = layout;
    this.name = { union: 'Union', unionall: 'Union All', intersect: 'Intersect', except: 'Except' }[kind];
  }
  open(): void {
    this.side = 0;
    this.seen = new Set();
    this.other = new Set();
    if (this.kind === 'intersect' || this.kind === 'except') {
      const right = this.children[1];
      right.open();
      for (let r = right.next(); r; r = right.next()) this.other.add(tupleKey(r));
      right.close();
    }
    this.children[0].open();
  }
  next(): Row | null {
    for (;;) {
      const input = this.children[this.side];
      const r = input.next();
      if (!r) {
        if (this.side === 0 && (this.kind === 'union' || this.kind === 'unionall')) {
          this.side = 1;
          this.children[1].open();
          continue;
        }
        return null;
      }
      if (this.kind === 'unionall') return r;
      const k = tupleKey(r);
      if (this.seen.has(k)) continue;
      if (this.kind === 'intersect' && !this.other.has(k)) continue;
      if (this.kind === 'except' && this.other.has(k)) continue;
      this.seen.add(k);
      return r;
    }
  }
}

export class WorkTableScan extends Operator {
  readonly name = 'WorkTable Scan';
  private readonly workId: number;
  private rows: Row[] = [];
  private i = 0;
  constructor(ctx: ExecContext, workId: number, layout: number[], name: string) {
    super(ctx);
    this.workId = workId;
    this.layout = layout;
    this.details.push(`on ${name}`);
  }
  open(): void {
    this.rows = this.ctx.work.get(this.workId) ?? [];
    this.i = 0;
  }
  next(): Row | null {
    return this.i < this.rows.length ? this.rows[this.i++] : null;
  }
}

/** WITH RECURSIVE: evaluates the recursive member until no new rows appear (lazily). */
export class RecursiveUnion extends Operator {
  readonly name = 'Recursive Union';
  private readonly workId: number;
  private readonly distinct: boolean;
  private phase: 'anchor' | 'recursive' | 'done' = 'anchor';
  private produced: Row[] = [];
  private seen = new Set<string>();
  private iterations = 0;

  constructor(ctx: ExecContext, anchor: Operator, recursive: Operator, workId: number, distinct: boolean, layout: number[]) {
    super(ctx);
    this.children = [anchor, recursive];
    this.workId = workId;
    this.distinct = distinct;
    this.layout = layout;
  }
  open(): void {
    this.phase = 'anchor';
    this.produced = [];
    this.seen = new Set();
    this.iterations = 0;
    this.children[0].open();
  }
  private accept(r: Row): boolean {
    if (!this.distinct) return true;
    const k = tupleKey(r);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
  next(): Row | null {
    for (;;) {
      if (this.phase === 'done') return null;
      const input = this.phase === 'anchor' ? this.children[0] : this.children[1];
      const r = input.next();
      if (r) {
        this.ctx.tick();
        if (!this.accept(r)) continue;
        this.produced.push(r);
        return r;
      }
      if (this.produced.length === 0) {
        this.phase = 'done';
        return null;
      }
      if (++this.iterations > 1_000_000) throw new OpusError(ErrorCode.numericOutOfRange, 'recursive query exceeded 1,000,000 iterations');
      this.ctx.work.set(this.workId, this.produced);
      this.produced = [];
      this.phase = 'recursive';
      this.children[1].open();
    }
  }
}

// ------------------------------------------------------------------ window functions

export interface CompiledWindow {
  spec: WindowFuncSpec;
  args: Compiled[];
  partition: Compiled[];
  order: Compiled[];
  cmp: (a: Value[], b: Value[]) => number;
  filter?: Compiled;
}

export class WindowOp extends Operator {
  readonly name = 'WindowAgg';
  private readonly funcs: CompiledWindow[];
  private out: Row[] = [];
  private i = 0;

  constructor(ctx: ExecContext, input: Operator, funcs: CompiledWindow[], layout: number[]) {
    super(ctx);
    this.children = [input];
    this.funcs = funcs;
    this.layout = layout;
  }

  open(): void {
    const input = this.children[0];
    const rows: Row[] = [];
    input.open();
    for (let r = input.next(); r; r = input.next()) rows.push(r.slice());
    input.close();
    const width = input.layout.length;
    for (const r of rows) r.length = width + this.funcs.length;
    let order: number[] = rows.map((_, i) => i);
    this.funcs.forEach((w, fi) => {
      order = this.compute(rows, w, width + fi);
    });
    this.out = order.map((i) => rows[i]);
    this.i = 0;
  }

  next(): Row | null {
    return this.i < this.out.length ? this.out[this.i++] : null;
  }
  override close(): void {}

  /** Computes one window function into column `col`; returns the row order it sorted by. */
  private compute(rows: Row[], w: CompiledWindow, col: number): number[] {
    const n = rows.length;
    const pkeys = rows.map((r) => w.partition.map((f) => f(r)));
    const okeys = rows.map((r) => w.order.map((f) => f(r)));
    const idx = rows.map((_, i) => i);
    const pcmp = (a: number, b: number) => {
      const pa = pkeys[a];
      const pb = pkeys[b];
      for (let i = 0; i < pa.length; i++) {
        const c = compareValues(pa[i], pb[i]);
        if (c !== 0) return c;
      }
      return 0;
    };
    idx.sort((a, b) => pcmp(a, b) || w.cmp(okeys[a], okeys[b]) || a - b);
    const peer = (a: number, b: number) => w.cmp(okeys[a], okeys[b]) === 0;
    let start = 0;
    while (start < n) {
      let end = start + 1;
      while (end < n && pcmp(idx[start], idx[end]) === 0) end++;
      this.computePartition(rows, idx.slice(start, end), w, col, peer);
      start = end;
    }
    return idx;
  }

  private computePartition(rows: Row[], part: number[], w: CompiledWindow, col: number, peer: (a: number, b: number) => boolean): void {
    const n = part.length;
    const name = w.spec.name;
    const hasOrder = w.order.length > 0;
    // peer group boundaries
    const groupStart = new Array<number>(n);
    const groupEnd = new Array<number>(n);
    for (let i = 0; i < n; ) {
      let j = i + 1;
      while (j < n && peer(part[i], part[j])) j++;
      for (let k = i; k < j; k++) {
        groupStart[k] = i;
        groupEnd[k] = j - 1;
      }
      i = j;
    }
    const arg = (k: number, i: number) => (w.args[k] ? w.args[k](rows[part[i]]) : null);
    switch (name) {
      case 'ROW_NUMBER':
        for (let i = 0; i < n; i++) rows[part[i]][col] = i + 1;
        return;
      case 'RANK':
        for (let i = 0; i < n; i++) rows[part[i]][col] = groupStart[i] + 1;
        return;
      case 'DENSE_RANK': {
        let rank = 0;
        for (let i = 0; i < n; i++) {
          if (i === groupStart[i]) rank++;
          rows[part[i]][col] = rank;
        }
        return;
      }
      case 'PERCENT_RANK':
        for (let i = 0; i < n; i++) rows[part[i]][col] = n > 1 ? groupStart[i] / (n - 1) : 0;
        return;
      case 'CUME_DIST':
        for (let i = 0; i < n; i++) rows[part[i]][col] = (groupEnd[i] + 1) / n;
        return;
      case 'NTILE': {
        const buckets = toInteger(arg(0, 0));
        if (buckets === null || buckets <= 0) throw new OpusError(ErrorCode.invalidParameter, 'argument of ntile must be greater than zero');
        const size = Math.floor(n / buckets);
        const extra = n % buckets;
        let i = 0;
        for (let b = 1; b <= buckets && i < n; b++) {
          const cnt = size + (b <= extra ? 1 : 0);
          for (let k = 0; k < cnt && i < n; k++) rows[part[i++]][col] = b;
        }
        return;
      }
      case 'LAG':
      case 'LEAD': {
        for (let i = 0; i < n; i++) {
          const off = w.args[1] ? toInteger(arg(1, i)) : 1;
          const j = name === 'LAG' ? i - (off ?? 1) : i + (off ?? 1);
          rows[part[i]][col] = j >= 0 && j < n ? arg(0, j) : w.args[2] ? arg(2, i) : null;
        }
        return;
      }
    }
    // frame-based functions
    const frame = w.spec.frame;
    const range = (i: number): [number, number] => {
      if (!frame) return hasOrder ? [0, groupEnd[i]] : [0, n - 1];
      const bound = (b: { kind: string; offset?: number }, isStart: boolean): number => {
        switch (b.kind) {
          case 'unbounded_preceding':
            return 0;
          case 'unbounded_following':
            return n - 1;
          case 'current_row':
            return frame.mode === 'RANGE' ? (isStart ? groupStart[i] : groupEnd[i]) : i;
          case 'preceding':
            if (frame.mode === 'RANGE') throw new OpusError(ErrorCode.featureNotSupported, 'RANGE with offset PRECEDING is not supported');
            return i - (b.offset ?? 0);
          default:
            if (frame.mode === 'RANGE') throw new OpusError(ErrorCode.featureNotSupported, 'RANGE with offset FOLLOWING is not supported');
            return i + (b.offset ?? 0);
        }
      };
      return [Math.max(0, bound(frame.start, true)), Math.min(n - 1, bound(frame.end, false))];
    };
    if (name === 'FIRST_VALUE' || name === 'LAST_VALUE' || name === 'NTH_VALUE') {
      for (let i = 0; i < n; i++) {
        const [s, e] = range(i);
        let v: Value = null;
        if (s <= e) {
          if (name === 'FIRST_VALUE') v = arg(0, s);
          else if (name === 'LAST_VALUE') v = arg(0, e);
          else {
            const k = toInteger(arg(1, i));
            if (k === null || k <= 0) throw new OpusError(ErrorCode.invalidParameter, 'second argument to nth_value must be a positive integer');
            v = s + k - 1 <= e ? arg(0, s + k - 1) : null;
          }
        }
        rows[part[i]][col] = v;
      }
      return;
    }
    // aggregate over the frame
    const cagg: CompiledAgg = { spec: { name, args: w.spec.args, distinct: w.spec.distinct, star: w.args.length === 0, outId: 0, type: w.spec.type }, args: w.args, filter: w.filter };
    const growing = !frame || frame.start.kind === 'unbounded_preceding';
    if (growing) {
      const state = createAggState(cagg);
      let added = -1;
      for (let i = 0; i < n; i++) {
        const [, e] = range(i);
        while (added < e) {
          added++;
          stepAgg(cagg, state, rows[part[added]]);
        }
        rows[part[i]][col] = state.final();
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const [s, e] = range(i);
      const state = createAggState(cagg);
      for (let k = s; k <= e; k++) stepAgg(cagg, state, rows[part[k]]);
      rows[part[i]][col] = state.final();
    }
  }
}
