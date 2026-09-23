import type { DataType, Value } from '../types.ts';
import { ErrorCode, OpusError } from '../types.ts';
import type { Catalog, IndexSchema, TableSchema } from '../catalog.ts';
import type { ExecContext } from '../exec/context.ts';
import type { Compiled } from '../exec/expr.ts';
import { compileExpr, keyComparator, layoutOf } from '../exec/expr.ts';
import {
  Distinct,
  Filter,
  GenerateSeries,
  HashAggregate,
  HashJoin,
  IndexScan,
  Limit,
  Materialize,
  NestedLoopJoin,
  Operator,
  Project,
  RecursiveUnion,
  RowidScan,
  SeqScan,
  SetOp,
  Sort,
  TopN,
  Values,
  WindowOp,
  WorkTableScan,
} from '../exec/operators.ts';
import type { CompiledAgg, CompiledWindow } from '../exec/operators.ts';
import { DeleteOp, InsertOp, UpdateOp } from '../exec/dml.ts';
import type { UpsertSpec } from '../exec/dml.ts';
import { affinityFor, TableAccess, TableHandle } from '../exec/table.ts';
import type { Binder } from './binder.ts';
import type { BExpr, BoundDelete, BoundInsert, BoundUpdate, LNode, SortKey, SubPlan } from './bound.ts';
import { andAll, conjuncts, containsWorktable, exprKey, hasSubquery, isVolatile, mapExpr, refIds, usedIds } from './bound.ts';
import { showExpr } from './show.ts';

/**
 * Cost-based physical planner.
 *
 *  - predicates are pushed down through filters, projections, aggregates,
 *    set operations and joins;
 *  - each base table picks the cheapest access path: sequential scan, rowid
 *    point/range lookup, index (equality prefix + range or IN list), or an
 *    index-only scan when the index covers every referenced column;
 *  - clusters of inner joins are ordered with dynamic programming over
 *    subsets (left-deep), choosing index nested-loop, hash or nested-loop
 *    joins per step;
 *  - ORDER BY is satisfied by index order when possible, and ORDER BY +
 *    LIMIT becomes a bounded heap (Top-N).
 */

type ScanNode = Extract<LNode, { op: 'scan' }>;

interface Constraint {
  pred: BExpr;
  col: number; // column index; -1 = rowid
  op: '=' | '<' | '<=' | '>' | '>=' | 'in';
  value?: BExpr;
  list?: BExpr[];
}

interface AccessPlan {
  kind: 'seq' | 'rowid-eq' | 'rowid-range' | 'index';
  index?: IndexSchema;
  eq: Constraint[];
  inList?: Constraint;
  lo?: Constraint;
  hi?: Constraint;
  reverse: boolean;
  covering: boolean;
  consumed: Set<BExpr>;
  rows: number; // rows produced (after residual filter)
  cost: number;
  orderSatisfied: boolean;
  parameterized: boolean;
}

export interface PlannerOptions {
  catalog: Catalog;
  ctx: ExecContext;
  binder: Binder;
}

const DEFAULT_EQ_SEL = 0.1;
const DEFAULT_RANGE_SEL = 1 / 3;

function flip(op: string): Constraint['op'] {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
    default:
      return op as Constraint['op'];
  }
}

function log2(n: number): number {
  return Math.log2(Math.max(2, n));
}

export class Planner {
  private readonly catalog: Catalog;
  private readonly ctx: ExecContext;
  private readonly binder: Binder;
  private readonly accessCache = new Map<TableSchema, TableAccess>();
  private readonly handleCache = new Map<TableSchema, TableHandle>();
  /** Disables index-only scans (DML sources need every column). */
  private noCovering = false;
  /** Column ids referenced anywhere in the statement; drives index-only scans. */
  private used: Set<number> | null = null;

  constructor(opts: PlannerOptions) {
    this.catalog = opts.catalog;
    this.ctx = opts.ctx;
    this.binder = opts.binder;
  }

  // ------------------------------------------------------------------ helpers

  private access(t: TableSchema): TableAccess {
    let a = this.accessCache.get(t);
    if (!a) this.accessCache.set(t, (a = new TableAccess(this.catalog, t)));
    return a;
  }

  handle(t: TableSchema): TableHandle {
    let h = this.handleCache.get(t);
    if (h) return h;
    h = new TableHandle(this.catalog, t);
    const none = new Map<number, number>();
    h.defaults = t.columns.map((c) => {
      if (!c.default) return undefined;
      const { expr } = this.binder.bindTableExpr(c.default, t, 'DEFAULT');
      return compileExpr(expr, { ctx: this.ctx, layout: none, planSub: (s) => this.planSub(s) });
    });
    h.checks = t.checks.map((ch) => {
      const { expr, ids } = this.binder.bindTableExpr(ch.expr, t, 'CHECK');
      return { fn: compileExpr(expr, { ctx: this.ctx, layout: layoutOf(ids), planSub: (s) => this.planSub(s) }), name: ch.name === 'check' ? showExpr(expr) : ch.name };
    });
    this.handleCache.set(t, h);
    return h;
  }

  private planSub(sub: SubPlan): Operator {
    const saved = this.noCovering;
    this.noCovering = false;
    try {
      return this.buildWithLayout(sub.plan);
    } finally {
      this.noCovering = saved;
    }
  }

  compile(e: BExpr, layout: readonly number[]): Compiled {
    return compileExpr(e, { ctx: this.ctx, layout: layoutOf(layout), planSub: (s) => this.planSub(s) });
  }

  private tableRows(t: TableSchema): number {
    if (t.stats) return Math.max(1, t.stats.rows);
    return Math.max(1, this.handle(t).rowCount());
  }

  private ndv(t: TableSchema, col: number): number {
    const rows = this.tableRows(t);
    if (col === -1 || col === t.rowidCol) return rows;
    if (t.stats) return Math.max(1, t.stats.ndv[col]);
    if (t.indexes.some((ix) => ix.unique && ix.columns.length === 1 && ix.columns[0] === col)) return rows;
    return Math.max(1, rows * DEFAULT_EQ_SEL);
  }

  /** Rough selectivity of a predicate (0..1). */
  private selectivity(e: BExpr, colInfo?: (id: number) => { table: TableSchema; col: number } | undefined): number {
    switch (e.k) {
      case 'binary':
        if (e.op === 'AND') return this.selectivity(e.left, colInfo) * this.selectivity(e.right, colInfo);
        if (e.op === 'OR') {
          const a = this.selectivity(e.left, colInfo);
          const b = this.selectivity(e.right, colInfo);
          return Math.min(1, a + b - a * b);
        }
        if (e.op === '=') {
          const side = e.left.k === 'col' ? e.left : e.right.k === 'col' ? e.right : undefined;
          const info = side && colInfo?.(side.id);
          if (info) return 1 / this.ndv(info.table, info.col);
          return DEFAULT_EQ_SEL;
        }
        if (e.op === '!=') return 0.9;
        if (e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>=') return DEFAULT_RANGE_SEL;
        return 0.5;
      case 'between':
        return e.not ? 0.75 : 0.25;
      case 'isnull':
        return e.not ? 0.95 : 0.05;
      case 'inlist':
        return e.not ? 0.9 : Math.min(0.5, e.list.length * DEFAULT_EQ_SEL);
      case 'like':
        return e.not ? 0.9 : 0.2;
      case 'unary':
        if (e.op === 'NOT') return 1 - this.selectivity(e.arg, colInfo);
        return 0.5;
      case 'const':
        return e.value === true || e.value === 1 ? 1 : e.value === null || e.value === false || e.value === 0 ? 0 : 1;
      case 'exists':
      case 'insub':
        return 0.5;
      default:
        return 0.5;
    }
  }

  private scanColInfo(scan: ScanNode): (id: number) => { table: TableSchema; col: number } | undefined {
    const map = new Map<number, number>();
    scan.cols.forEach((c, i) => map.set(c.id, i === scan.cols.length - 1 ? -1 : i));
    return (id) => {
      const col = map.get(id);
      return col === undefined ? undefined : { table: scan.table, col };
    };
  }

  private est<T extends Operator>(op: T, rows: number, cost: number): T {
    op.estRows = Math.max(0, rows);
    op.cost = cost;
    return op;
  }

  // ------------------------------------------------------------------ entry points

  /** Plans a whole query: computes the referenced columns, then builds the operator tree. */
  planQuery(node: LNode): Operator {
    this.used = usedIds(node);
    for (const c of node.cols) this.used.add(c.id);
    return this.buildWithLayout(node);
  }

  /** Builds an operator whose output rows follow `node.cols` exactly. */
  buildWithLayout(node: LNode): Operator {
    const op = this.build(node);
    const want = node.cols.map((c) => c.id);
    if (want.length === op.layout.length && want.every((id, i) => op.layout[i] === id)) return op;
    const exprs = node.cols.map((c): BExpr => ({ k: 'col', id: c.id, type: c.type, name: c.name }));
    return this.est(new Project(this.ctx, op, exprs.map((e) => this.compile(e, op.layout)), want), op.estRows, op.cost);
  }

  build(node: LNode): Operator {
    switch (node.op) {
      case 'scan':
        return this.planAccess(node, []).op;
      case 'filter':
        return this.buildFilter(node.input, conjuncts(node.pred));
      case 'project': {
        const input = this.build(node.input);
        const op = new Project(
          this.ctx,
          input,
          node.exprs.map((e) => this.compile(e, input.layout)),
          node.cols.map((c) => c.id),
        );
        op.details.push(node.exprs.map(showExpr).join(', '));
        return this.est(op, input.estRows, input.cost + input.estRows * 0.01);
      }
      case 'join':
        return this.buildJoin(node, []);
      case 'aggregate':
        return this.buildAggregate(node);
      case 'window': {
        const input = this.build(node.input);
        const funcs: CompiledWindow[] = node.funcs.map((w) => ({
          spec: w,
          args: w.args.map((a) => this.compile(a, input.layout)),
          partition: w.partitionBy.map((p) => this.compile(p, input.layout)),
          order: w.orderBy.map((o) => this.compile(o.expr, input.layout)),
          cmp: keyComparator(w.orderBy),
          filter: w.filter ? this.compile(w.filter, input.layout) : undefined,
        }));
        const op = new WindowOp(this.ctx, input, funcs, [...input.layout, ...node.funcs.map((w) => w.outId)]);
        op.details.push(node.funcs.map((w) => `${w.name.toLowerCase()}()`).join(', '));
        return this.est(op, input.estRows, input.cost + input.estRows * log2(input.estRows));
      }
      case 'sort':
        return this.buildSorted(node.input, node.keys);
      case 'limit': {
        const inner = node.input;
        if (inner.op === 'sort') return this.buildSorted(inner.input, inner.keys, node.limit, node.offset);
        if (inner.op === 'project' && inner.input.op === 'sort') {
          const sorted = this.buildSorted(inner.input.input, inner.input.keys, node.limit, node.offset);
          const op = new Project(
            this.ctx,
            sorted,
            inner.exprs.map((e) => this.compile(e, sorted.layout)),
            inner.cols.map((c) => c.id),
          );
          op.details.push(inner.exprs.map(showExpr).join(', '));
          return this.est(op, sorted.estRows, sorted.cost);
        }
        const input = this.build(inner);
        const op = new Limit(this.ctx, input, node.limit && this.compile(node.limit, []), node.offset && this.compile(node.offset, []));
        const lim = node.limit?.k === 'const' && typeof node.limit.value === 'number' ? node.limit.value : input.estRows;
        return this.est(op, Math.min(input.estRows, lim), input.cost);
      }
      case 'distinct': {
        const input = this.build(node.input);
        return this.est(new Distinct(this.ctx, input), input.estRows * 0.7, input.cost + input.estRows);
      }
      case 'values': {
        const layout = node.cols.map((c) => c.id);
        const op = new Values(this.ctx, node.rows.map((r) => r.map((e) => this.compile(e, []))), layout);
        if (node.rows.length !== 1 || node.cols.length) op.details.push(`${node.rows.length} row${node.rows.length === 1 ? '' : 's'}`);
        return this.est(op, node.rows.length, node.rows.length);
      }
      case 'series': {
        const op = new GenerateSeries(this.ctx, node.args.map((a) => this.compile(a, [])), node.cols.map((c) => c.id));
        const [a, b] = node.args;
        let rows = 1000;
        if (a?.k === 'const' && b?.k === 'const' && typeof a.value === 'number' && typeof b.value === 'number') rows = Math.abs(b.value - a.value) + 1;
        else if (a?.k === 'const' && node.args.length === 1 && typeof a.value === 'number') rows = a.value;
        return this.est(op, rows, rows);
      }
      case 'setop': {
        const left = this.buildWithLayout(node.left);
        const right = this.buildWithLayout(node.right);
        const op = new SetOp(this.ctx, left, right, node.kind, node.cols.map((c) => c.id));
        const rows = node.kind === 'unionall' || node.kind === 'union' ? left.estRows + right.estRows : node.kind === 'intersect' ? Math.min(left.estRows, right.estRows) : left.estRows;
        return this.est(op, rows, left.cost + right.cost + left.estRows + right.estRows);
      }
      case 'recursive': {
        const anchor = this.buildWithLayout(node.anchor);
        const rec = this.buildWithLayout(node.recursive);
        const op = new RecursiveUnion(this.ctx, anchor, rec, node.workId, node.distinct, node.cols.map((c) => c.id));
        return this.est(op, anchor.estRows * 10, anchor.cost + rec.cost * 10);
      }
      case 'worktable':
        return this.est(new WorkTableScan(this.ctx, node.workId, node.cols.map((c) => c.id), node.name), 10, 10);
    }
  }

  // ------------------------------------------------------------------ filters & pushdown

  private buildFilter(input: LNode, preds: BExpr[]): Operator {
    if (preds.length === 0) return this.build(input);
    switch (input.op) {
      case 'filter':
        return this.buildFilter(input.input, [...preds, ...conjuncts(input.pred)]);
      case 'scan':
        return this.planAccess(input, preds).op;
      case 'join':
        return this.buildJoin(input, preds);
      case 'distinct':
      case 'sort': {
        // filters commute with DISTINCT and ORDER BY
        const inner: LNode = { ...input, input: { op: 'filter', input: input.input, pred: andAll(preds)!, cols: input.input.cols } } as LNode;
        return this.build(inner);
      }
      case 'project': {
        const map = new Map<number, BExpr>();
        input.cols.forEach((c, i) => map.set(c.id, input.exprs[i]));
        const push: BExpr[] = [];
        const keep: BExpr[] = [];
        for (const p of preds) {
          const ids = refIds(p);
          const substitutable =
            !hasSubquery(p) &&
            [...ids].every((id) => {
              const src = map.get(id);
              return src === undefined || (!hasSubquery(src) && !isVolatile(src));
            });
          if (substitutable && [...ids].some((id) => map.has(id))) push.push(mapExpr(p, (x) => (x.k === 'col' ? map.get(x.id) : undefined)));
          else keep.push(p);
        }
        if (push.length === 0) return this.filterOp(this.build(input), keep);
        const pushed: LNode = { ...input, input: { op: 'filter', input: input.input, pred: andAll(push)!, cols: input.input.cols } };
        return this.filterOp(this.build(pushed), keep);
      }
      case 'aggregate': {
        const groupIds = new Map<number, BExpr>();
        input.cols.slice(0, input.groups.length).forEach((c, i) => groupIds.set(c.id, input.groups[i]));
        const push: BExpr[] = [];
        const keep: BExpr[] = [];
        for (const p of preds) {
          const ids = [...refIds(p)];
          const local = ids.filter((id) => input.cols.some((c) => c.id === id));
          if (!hasSubquery(p) && local.length > 0 && local.every((id) => groupIds.has(id))) {
            push.push(mapExpr(p, (x) => (x.k === 'col' ? groupIds.get(x.id) : undefined)));
          } else keep.push(p);
        }
        if (push.length === 0) return this.filterOp(this.build(input), keep);
        const pushed: LNode = { ...input, input: { op: 'filter', input: input.input, pred: andAll(push)!, cols: input.input.cols } };
        return this.filterOp(this.build(pushed), keep);
      }
      case 'setop': {
        if (preds.some(hasSubquery)) break;
        const side = (child: LNode): LNode => {
          const map = new Map<number, BExpr>();
          input.cols.forEach((c, i) => map.set(c.id, { k: 'col', id: child.cols[i].id, type: child.cols[i].type, name: child.cols[i].name }));
          const mapped = preds.map((p) => mapExpr(p, (x) => (x.k === 'col' ? map.get(x.id) : undefined)));
          return { op: 'filter', input: child, pred: andAll(mapped)!, cols: child.cols };
        };
        return this.build({ ...input, left: side(input.left), right: side(input.right) });
      }
    }
    return this.filterOp(this.build(input), preds);
  }

  private filterOp(input: Operator, preds: BExpr[]): Operator {
    if (preds.length === 0) return input;
    const pred = andAll(preds)!;
    const op = new Filter(this.ctx, input, this.compile(pred, input.layout));
    op.details.push(showExpr(pred));
    return this.est(op, input.estRows * this.selectivity(pred), input.cost + input.estRows * 0.05);
  }

  // ------------------------------------------------------------------ access paths

  private constraintsFor(scan: ScanNode, preds: BExpr[]): Constraint[] {
    const n = scan.cols.length - 1;
    const colOf = new Map<number, number>();
    scan.cols.forEach((c, i) => colOf.set(c.id, i === n ? -1 : i));
    const rowidCol = scan.table.rowidCol;
    const own = (e: BExpr) => [...refIds(e)].some((id) => colOf.has(id));
    const colIndex = (e: BExpr): number | undefined => {
      if (e.k !== 'col') return undefined;
      const c = colOf.get(e.id);
      if (c === undefined) return undefined;
      return c === rowidCol ? -1 : c;
    };
    const free = (e: BExpr) => !own(e) && !isVolatile(e);
    const out: Constraint[] = [];
    for (const p of preds) {
      if (p.k === 'binary' && ['=', '<', '<=', '>', '>='].includes(p.op)) {
        let c = colIndex(p.left);
        if (c !== undefined && free(p.right)) {
          out.push({ pred: p, col: c, op: p.op as Constraint['op'], value: p.right });
          continue;
        }
        c = colIndex(p.right);
        if (c !== undefined && free(p.left)) out.push({ pred: p, col: c, op: flip(p.op), value: p.left });
      } else if (p.k === 'between' && !p.not) {
        const c = colIndex(p.arg);
        if (c !== undefined && free(p.low) && free(p.high)) {
          out.push({ pred: p, col: c, op: '>=', value: p.low });
          out.push({ pred: p, col: c, op: '<=', value: p.high });
        }
      } else if (p.k === 'inlist' && !p.not) {
        const c = colIndex(p.arg);
        if (c !== undefined && p.list.every(free)) out.push({ pred: p, col: c, op: 'in', list: p.list });
      }
    }
    return out;
  }

  /**
   * Chooses the cheapest way to read one table given its predicates.
   * `order` asks for rows in a particular order (used to skip a sort).
   */
  planAccess(scan: ScanNode, preds: BExpr[], opts: { order?: SortKey[]; limit?: number; need?: Set<number> } = {}): { op: Operator; plan: AccessPlan } {
    const plan = this.chooseAccess(scan, preds, opts);
    return { op: this.buildAccess(scan, preds, plan), plan };
  }

  private chooseAccess(scan: ScanNode, preds: BExpr[], opts: { order?: SortKey[]; limit?: number; need?: Set<number> }): AccessPlan {
    const t = scan.table;
    const N = this.tableRows(t);
    const colInfo = this.scanColInfo(scan);
    const cons = this.constraintsFor(scan, preds);
    const scanIds = new Set(scan.cols.map((c) => c.id));
    const isParam = (c: Constraint) =>
      [c.value, ...(c.list ?? [])].some((v) => v && [...refIds(v)].some((id) => !scanIds.has(id)));
    const residualSel = (consumed: Set<BExpr>) => {
      let s = 1;
      for (const p of preds) if (!consumed.has(p)) s *= this.selectivity(p, colInfo);
      return s;
    };
    const sortCost = (rows: number) => (opts.order?.length ? rows * log2(rows) * 0.2 : 0);
    const candidates: AccessPlan[] = [];

    // order satisfaction helpers
    const n = scan.cols.length - 1;
    const orderCols = opts.order?.map((k) => {
      if (k.expr.k !== 'col') return undefined;
      const i = scan.cols.findIndex((c) => c.id === (k.expr as { id: number }).id);
      if (i < 0) return undefined;
      return { col: i === n || i === t.rowidCol ? -1 : i, desc: k.desc, nullsFirst: k.nullsFirst };
    });
    const orderOk = orderCols && orderCols.length > 0 && orderCols.every((o) => o !== undefined) ? (orderCols as { col: number; desc: boolean; nullsFirst: boolean }[]) : undefined;

    // 1. sequential scan (rowid order)
    {
      const seqOrder = orderOk && orderOk.length === 1 && orderOk[0].col === -1;
      const rows = N * residualSel(new Set());
      let cost = N;
      if (!seqOrder) cost += sortCost(rows);
      else if (opts.limit !== undefined) cost = Math.min(cost, opts.limit / Math.max(0.001, rows / N));
      candidates.push({
        kind: 'seq',
        eq: [],
        reverse: !!(seqOrder && orderOk![0].desc),
        covering: false,
        consumed: new Set(),
        rows,
        cost,
        orderSatisfied: !!seqOrder,
        parameterized: false,
      });
    }

    // 2. rowid lookups / ranges
    const rowidCons = cons.filter((c) => c.col === -1);
    const rowidEq = rowidCons.find((c) => c.op === '=') ?? rowidCons.find((c) => c.op === 'in');
    if (rowidEq) {
      const keys = rowidEq.op === 'in' ? rowidEq.list!.length : 1;
      const consumed = new Set([rowidEq.pred]);
      const rows = keys * residualSel(consumed);
      candidates.push({
        kind: 'rowid-eq',
        eq: [rowidEq],
        reverse: false,
        covering: false,
        consumed,
        rows,
        cost: keys * log2(N) + sortCost(rows),
        orderSatisfied: keys === 1,
        parameterized: isParam(rowidEq),
      });
    } else {
      const lo = rowidCons.find((c) => c.op === '>' || c.op === '>=');
      const hi = rowidCons.find((c) => c.op === '<' || c.op === '<=');
      if (lo || hi) {
        const consumed = new Set<BExpr>();
        if (lo && (lo.pred.k !== 'between' || (hi && hi.pred === lo.pred))) consumed.add(lo.pred);
        if (hi && (hi.pred.k !== 'between' || (lo && lo.pred === hi.pred))) consumed.add(hi.pred);
        const matched = N * (lo && hi ? 0.25 : DEFAULT_RANGE_SEL);
        const rows = matched * residualSel(consumed);
        const ordered = !!(orderOk && orderOk.length === 1 && orderOk[0].col === -1);
        let cost = log2(N) + matched + (ordered ? 0 : sortCost(rows));
        if (ordered && opts.limit !== undefined) cost = Math.min(cost, log2(N) + opts.limit / Math.max(0.001, rows / Math.max(1, matched)));
        candidates.push({
          kind: 'rowid-range',
          eq: [],
          lo,
          hi,
          reverse: ordered && orderOk![0].desc,
          covering: false,
          consumed,
          rows,
          cost,
          orderSatisfied: ordered,
          parameterized: !!((lo && isParam(lo)) || (hi && isParam(hi))),
        });
      }
    }

    // 3. secondary indexes
    for (const ix of t.indexes) {
      const eq: Constraint[] = [];
      let inList: Constraint | undefined;
      let lo: Constraint | undefined;
      let hi: Constraint | undefined;
      let sel = 1;
      let k = 0;
      for (; k < ix.columns.length; k++) {
        const col = ix.columns[k];
        const cs = cons.filter((c) => c.col === col);
        const e = cs.find((c) => c.op === '=');
        if (e) {
          eq.push(e);
          sel *= 1 / this.ndv(t, col);
          continue;
        }
        const inc = cs.find((c) => c.op === 'in');
        if (inc) {
          inList = inc;
          sel *= Math.min(1, inc.list!.length / this.ndv(t, col));
          k++;
          break;
        }
        if (!ix.desc[k]) {
          lo = cs.find((c) => c.op === '>' || c.op === '>=');
          hi = cs.find((c) => c.op === '<' || c.op === '<=');
          if (lo || hi) sel *= lo && hi ? 0.25 : DEFAULT_RANGE_SEL;
        }
        break;
      }
      const consumed = new Set<BExpr>();
      for (const c of eq) consumed.add(c.pred);
      if (inList) consumed.add(inList.pred);
      if (lo && (lo.pred.k !== 'between' || (hi && hi.pred === lo.pred))) consumed.add(lo.pred);
      if (hi && (hi.pred.k !== 'between' || (lo && lo.pred === hi.pred))) consumed.add(hi.pred);
      const fullyUnique = ix.unique && eq.length === ix.columns.length;
      const matched = fullyUnique ? 1 : Math.max(1, N * sel);

      // order: remaining sort keys must follow the index columns after the equality prefix
      let ordered = false;
      let reverse = false;
      if (orderOk && !inList) {
        let ok = true;
        let dir: boolean | undefined;
        let pos = eq.length;
        for (const o of orderOk) {
          if (o.col === -1) {
            // trailing rowid: index keys end with the rowid
            if (pos !== ix.columns.length) ok = false;
            else {
              const r = o.desc;
              if (dir === undefined) dir = r;
              else if (dir !== r) ok = false;
              pos++;
            }
            continue;
          }
          // skip leading columns pinned by equality
          while (pos < ix.columns.length && eq.some((e) => e.col === ix.columns[pos]) && ix.columns[pos] !== o.col) pos++;
          if (pos >= ix.columns.length || ix.columns[pos] !== o.col) {
            if (eq.some((e) => e.col === o.col)) continue; // ordering by a constant column is free
            ok = false;
            break;
          }
          const r = o.desc !== ix.desc[pos];
          if (o.nullsFirst !== !o.desc) ok = false;
          if (dir === undefined) dir = r;
          else if (dir !== r) ok = false;
          pos++;
        }
        if (ok && dir !== undefined) {
          ordered = true;
          reverse = dir;
        }
      }
      if (eq.length === 0 && !inList && !lo && !hi && !ordered) {
        // an index without usable constraints only helps as a covering scan
        if (this.noCovering || (!opts.need && !this.used)) continue;
      }
      const need = opts.need ?? (this.used ? new Set(scan.cols.map((c) => c.id).filter((id) => this.used!.has(id))) : new Set(scan.cols.map((c) => c.id)));
      const covering =
        !this.noCovering &&
        [...need].every((id) => {
          const i = scan.cols.findIndex((c) => c.id === id);
          return i < 0 || i === n || i === t.rowidCol || ix.columns.includes(i);
        }) &&
        [...refIds(andAll(preds.filter((p) => !consumed.has(p))) ?? { k: 'const', value: true, type: 'BOOLEAN' })].every((id) => {
          const i = scan.cols.findIndex((c) => c.id === id);
          return i < 0 || i === n || i === t.rowidCol || ix.columns.includes(i);
        });
      if (eq.length === 0 && !inList && !lo && !hi && !ordered && !covering) continue;
      const perRow = covering ? 0.6 : 2.5;
      const rows = matched * residualSel(consumed);
      let cost = log2(N) * (inList ? inList.list!.length : 1) + matched * perRow + (ordered ? 0 : sortCost(rows));
      if (ordered && opts.limit !== undefined) cost = Math.min(cost, log2(N) + (opts.limit / Math.max(0.001, rows / matched)) * perRow);
      candidates.push({
        kind: 'index',
        index: ix,
        eq,
        inList,
        lo,
        hi,
        reverse,
        covering,
        consumed,
        rows,
        cost,
        orderSatisfied: ordered,
        parameterized: [...eq, inList, lo, hi].some((c) => c && isParam(c)),
      });
    }
    candidates.sort((a, b) => a.cost - b.cost);
    return candidates[0];
  }

  private buildAccess(scan: ScanNode, preds: BExpr[], plan: AccessPlan): Operator {
    const access = this.access(scan.table);
    const layout = scan.cols.map((c) => c.id);
    const residual = preds.filter((p) => !plan.consumed.has(p));
    const filterExpr = andAll(residual);
    const filter = filterExpr ? this.compile(filterExpr, layout) : undefined;
    const val = (c: Constraint) => this.compile(c.value!, []);
    let op: Operator;
    const name = scan.alias !== scan.table.name.toLowerCase() ? `${scan.table.name} ${scan.alias}` : scan.table.name;
    switch (plan.kind) {
      case 'seq':
        op = new SeqScan(this.ctx, access, filter, plan.reverse);
        op.details.push(`on ${name}${plan.reverse ? ' (reverse)' : ''}`);
        break;
      case 'rowid-eq': {
        const c = plan.eq[0];
        const keys = c.op === 'in' ? c.list!.map((e) => this.compile(e, [])) : [val(c)];
        op = new RowidScan(this.ctx, access, { keys }, filter);
        op.details.push(`on ${name}`, `Key: rowid ${c.op === 'in' ? `IN (${c.list!.map(showExpr).join(', ')})` : `= ${showExpr(c.value!)}`}`);
        break;
      }
      case 'rowid-range': {
        const lo = plan.lo ? { fn: val(plan.lo), incl: plan.lo.op === '>=' } : undefined;
        const hi = plan.hi ? { fn: val(plan.hi), incl: plan.hi.op === '<=' } : undefined;
        op = new RowidScan(this.ctx, access, { lo, hi, reverse: plan.reverse }, filter);
        const cond = [plan.lo && `rowid ${plan.lo.op} ${showExpr(plan.lo.value!)}`, plan.hi && `rowid ${plan.hi.op} ${showExpr(plan.hi.value!)}`].filter(Boolean).join(' AND ');
        op.details.push(`on ${name}${plan.reverse ? ' (reverse)' : ''}`, `Range: ${cond}`);
        break;
      }
      case 'index': {
        const ix = plan.index!;
        const affinity = ix.columns.map((c) => affinityFor(scan.table.columns[c].type));
        op = new IndexScan(
          this.ctx,
          access,
          ix,
          this.catalog.indexTree(ix),
          {
            eq: plan.eq.map(val),
            inList: plan.inList?.list!.map((e) => this.compile(e, [])),
            lo: plan.lo ? { fn: val(plan.lo), incl: plan.lo.op === '>=' } : undefined,
            hi: plan.hi ? { fn: val(plan.hi), incl: plan.hi.op === '<=' } : undefined,
            reverse: plan.reverse,
            covering: plan.covering,
            affinity,
          },
          filter,
        );
        op.details.push(`using ${ix.name} on ${name}${plan.reverse ? ' (reverse)' : ''}`);
        const colName = (c: number) => scan.table.columns[c].name;
        const conds: string[] = plan.eq.map((c) => `${colName(c.col)} = ${showExpr(c.value!)}`);
        if (plan.inList) conds.push(`${colName(plan.inList.col)} IN (${plan.inList.list!.map(showExpr).join(', ')})`);
        if (plan.lo) conds.push(`${colName(plan.lo.col)} ${plan.lo.op} ${showExpr(plan.lo.value!)}`);
        if (plan.hi) conds.push(`${colName(plan.hi.col)} ${plan.hi.op} ${showExpr(plan.hi.value!)}`);
        if (conds.length) op.details.push(`Index Cond: ${conds.join(' AND ')}`);
        break;
      }
    }
    op.layout = layout;
    if (filterExpr) op.details.push(`Filter: ${showExpr(filterExpr)}`);
    return this.est(op, plan.rows, plan.cost);
  }

  // ------------------------------------------------------------------ joins

  private leafOf(node: LNode, preds: BExpr[]): { node: LNode; preds: BExpr[] } {
    while (node.op === 'filter') {
      preds = [...preds, ...conjuncts(node.pred)];
      node = node.input;
    }
    return { node, preds };
  }

  private buildJoin(node: Extract<LNode, { op: 'join' }>, preds: BExpr[]): Operator {
    if (node.kind === 'inner') return this.buildInnerCluster(node, preds);
    const leftIds = new Set(node.left.cols.map((c) => c.id));
    const rightIds = new Set(node.right.cols.map((c) => c.id));
    const touches = (p: BExpr, ids: Set<number>) => [...refIds(p)].some((id) => ids.has(id));

    if (node.kind === 'left') {
      const leftPreds: BExpr[] = [];
      const above: BExpr[] = [];
      for (const p of preds) (touches(p, rightIds) ? above : leftPreds).push(p);
      const on = conjuncts(node.cond);
      const rightLocal = on.filter((p) => !touches(p, leftIds));
      const joinConds = on.filter((p) => touches(p, leftIds));
      const outer = this.buildFilter(node.left, leftPreds);
      const op = this.joinStep(outer, node.right, rightLocal, joinConds, 'left');
      return this.filterOp(op, above);
    }
    if (node.kind === 'full') {
      const outer = this.build(node.left);
      const op = this.joinStep(outer, node.right, [], conjuncts(node.cond), 'full');
      return this.filterOp(op, preds);
    }
    // semi / anti (not produced by the binder today)
    const outer = this.buildFilter(node.left, preds);
    return this.joinStep(outer, node.right, [], conjuncts(node.cond), node.kind);
  }

  /** Splits `a = b` join predicates into (outer-side expr, inner-side expr) pairs. */
  private equiKeys(conds: BExpr[], outerIds: Set<number>, innerIds: Set<number>): { outer: BExpr[]; inner: BExpr[]; rest: BExpr[] } {
    const outer: BExpr[] = [];
    const inner: BExpr[] = [];
    const rest: BExpr[] = [];
    const side = (e: BExpr): 'o' | 'i' | 'none' | 'both' => {
      const ids = [...refIds(e)];
      const o = ids.some((id) => outerIds.has(id));
      const i = ids.some((id) => innerIds.has(id));
      return o && i ? 'both' : o ? 'o' : i ? 'i' : 'none';
    };
    const compatible = (a: DataType, b: DataType) =>
      (a === b && a !== 'ANY') || ((a === 'INTEGER' || a === 'REAL' || a === 'BOOLEAN') && (b === 'INTEGER' || b === 'REAL' || b === 'BOOLEAN'));
    for (const c of conds) {
      if (c.k === 'binary' && c.op === '=' && !hasSubquery(c) && compatible(c.left.type, c.right.type)) {
        const l = side(c.left);
        const r = side(c.right);
        if (l === 'o' && r === 'i') {
          outer.push(c.left);
          inner.push(c.right);
          continue;
        }
        if (l === 'i' && r === 'o') {
          outer.push(c.right);
          inner.push(c.left);
          continue;
        }
      }
      rest.push(c);
    }
    return { outer, inner, rest };
  }

  /**
   * Joins an already-built outer operator with an inner logical subtree,
   * choosing index nested-loop, hash join or (materialised) nested loop.
   */
  private joinStep(outer: Operator, innerNode: LNode, innerLocal: BExpr[], joinConds: BExpr[], kind: 'inner' | 'left' | 'full' | 'semi' | 'anti'): Operator {
    const alt = this.joinAlternatives(outer.estRows, outer.layout, innerNode, innerLocal, joinConds, kind);
    return this.realizeJoin(outer, innerNode, innerLocal, joinConds, kind, alt.best);
  }

  private joinAlternatives(
    outerRows: number,
    outerLayout: number[],
    innerNode: LNode,
    innerLocal: BExpr[],
    joinConds: BExpr[],
    kind: string,
  ): { best: 'inl' | 'hash' | 'nl'; cost: number; rows: number; innerRows: number } {
    const leaf = this.leafOf(innerNode, innerLocal);
    const outerIds = new Set(outerLayout);
    const innerIds = new Set(innerNode.cols.map((c) => c.id));
    const options: { best: 'inl' | 'hash' | 'nl'; cost: number; rows: number; innerRows: number }[] = [];
    // estimated inner size standalone
    let innerRows: number;
    let innerCost: number;
    if (leaf.node.op === 'scan') {
      const p = this.chooseAccess(leaf.node, leaf.preds, {});
      innerRows = p.rows;
      innerCost = p.cost;
      if (kind !== 'full') {
        const pi = this.chooseAccess(leaf.node, [...leaf.preds, ...joinConds], {});
        if (pi.parameterized) {
          options.push({ best: 'inl', cost: outerRows * (pi.cost + 1), rows: outerRows * Math.max(pi.rows, kind === 'left' ? 1 : 0), innerRows: pi.rows });
        }
      }
    } else {
      innerRows = Math.max(1, this.guessRows(leaf.node));
      innerCost = innerRows;
    }
    const joinSel = joinConds.reduce((s, p) => s * this.joinSelectivity(p), 1);
    const rows = Math.max(kind === 'left' ? outerRows : 0, outerRows * innerRows * joinSel);
    const keys = this.equiKeys(joinConds, outerIds, innerIds);
    if (keys.outer.length) options.push({ best: 'hash', cost: innerCost + outerRows + innerRows * 1.5 + rows * 0.1, rows, innerRows });
    options.push({ best: 'nl', cost: innerCost + outerRows * innerRows * 0.3 + rows * 0.1, rows, innerRows });
    options.sort((a, b) => a.cost - b.cost);
    return options[0];
  }

  private joinSelectivity(p: BExpr): number {
    if (p.k === 'binary' && p.op === '=' && p.left.k === 'col' && p.right.k === 'col') {
      const a = this.colStats.get(p.left.id);
      const b = this.colStats.get(p.right.id);
      const na = a ? this.ndv(a.table, a.col) : 10;
      const nb = b ? this.ndv(b.table, b.col) : 10;
      return 1 / Math.max(na, nb, 1);
    }
    return this.selectivity(p);
  }

  /** column id -> (table, column) for every scan seen by the planner; feeds join selectivity. */
  private readonly colStats = new Map<number, { table: TableSchema; col: number }>();

  private registerScans(node: LNode): void {
    if (node.op === 'scan') {
      const n = node.cols.length - 1;
      node.cols.forEach((c, i) => this.colStats.set(c.id, { table: node.table, col: i === n ? -1 : i }));
      return;
    }
    for (const k of ['input', 'left', 'right', 'anchor', 'recursive'] as const) {
      const child = (node as Record<string, unknown>)[k] as LNode | undefined;
      if (child) this.registerScans(child);
    }
  }

  private guessRows(node: LNode): number {
    switch (node.op) {
      case 'scan':
        return this.tableRows(node.table);
      case 'filter':
        return this.guessRows(node.input) * this.selectivity(node.pred);
      case 'values':
        return node.rows.length;
      case 'aggregate':
        return node.groups.length ? Math.max(1, Math.sqrt(this.guessRows(node.input)) * 2) : 1;
      case 'limit':
        return node.limit?.k === 'const' && typeof node.limit.value === 'number' ? Math.min(node.limit.value, this.guessRows(node.input)) : this.guessRows(node.input);
      case 'join':
        return Math.max(this.guessRows(node.left), this.guessRows(node.right));
      case 'setop':
        return this.guessRows(node.left) + this.guessRows(node.right);
      case 'series':
        return 1000;
      case 'recursive':
        return 100;
      case 'worktable':
        return 10;
      default:
        return this.guessRows((node as { input: LNode }).input);
    }
  }

  private realizeJoin(outer: Operator, innerNode: LNode, innerLocal: BExpr[], joinConds: BExpr[], kind: 'inner' | 'left' | 'full' | 'semi' | 'anti', method: 'inl' | 'hash' | 'nl'): Operator {
    const outerIds = new Set(outer.layout);
    const innerIds = new Set(innerNode.cols.map((c) => c.id));
    if (method === 'inl') {
      const leaf = this.leafOf(innerNode, innerLocal);
      const scan = leaf.node as ScanNode;
      const { op: inner, plan } = this.planAccess(scan, [...leaf.preds, ...joinConds], {});
      const used = new Set<number>();
      for (const p of [...leaf.preds, ...joinConds]) for (const id of refIds(p)) if (outerIds.has(id)) used.add(id);
      const bindings = outer.layout.map((id, i) => [id, i] as [number, number]).filter(([id]) => used.has(id));
      const op = new NestedLoopJoin(this.ctx, outer, inner, kind, undefined, bindings);
      op.name = kind === 'inner' ? 'Index Nested Loop' : `Index Nested Loop ${kind[0].toUpperCase()}${kind.slice(1)} Join`;
      const rows = outer.estRows * Math.max(plan.rows, kind === 'left' ? 1 : 0);
      return this.est(op, rows, outer.cost + outer.estRows * (plan.cost + 1));
    }
    const inner = this.buildFilter(innerNode, innerLocal);
    const joinSel = joinConds.reduce((s, p) => s * this.joinSelectivity(p), 1);
    const rows = Math.max(kind === 'left' ? outer.estRows : 0, outer.estRows * inner.estRows * joinSel);
    if (method === 'hash') {
      const keys = this.equiKeys(joinConds, outerIds, innerIds);
      const combined = [...outer.layout, ...inner.layout];
      const residual = andAll(keys.rest);
      // inner joins build on the smaller side
      if (kind === 'inner' && outer.estRows < inner.estRows) {
        const swapped = [...inner.layout, ...outer.layout];
        const op = new HashJoin(
          this.ctx,
          inner,
          outer,
          'inner',
          keys.inner.map((e) => this.compile(e, inner.layout)),
          keys.outer.map((e) => this.compile(e, outer.layout)),
          residual ? this.compile(residual, swapped) : undefined,
        );
        op.details.push(`Hash Cond: ${keys.outer.map((o, i) => `${showExpr(o)} = ${showExpr(keys.inner[i])}`).join(' AND ')}`, 'build: outer side');
        if (residual) op.details.push(`Join Filter: ${showExpr(residual)}`);
        return this.est(op, rows, outer.cost + inner.cost + outer.estRows * 1.5 + inner.estRows);
      }
      const op = new HashJoin(
        this.ctx,
        outer,
        inner,
        kind,
        keys.outer.map((e) => this.compile(e, outer.layout)),
        keys.inner.map((e) => this.compile(e, inner.layout)),
        residual ? this.compile(residual, combined) : undefined,
      );
      op.details.push(`Hash Cond: ${keys.outer.map((o, i) => `${showExpr(o)} = ${showExpr(keys.inner[i])}`).join(' AND ')}`);
      if (residual) op.details.push(`Join Filter: ${showExpr(residual)}`);
      return this.est(op, rows, outer.cost + inner.cost + outer.estRows + inner.estRows * 1.5);
    }
    // plain nested loop over a materialised inner side
    const correlated = [...planFreeIds(innerNode, innerLocal)].some((id) => outerIds.has(id));
    const innerOp = correlated || inner instanceof Materialize || containsWorktable(innerNode) ? inner : this.est(new Materialize(this.ctx, inner), inner.estRows, inner.cost);
    const cond = andAll(joinConds);
    const bindings = correlated ? outer.layout.map((id, i) => [id, i] as [number, number]) : [];
    const op = new NestedLoopJoin(this.ctx, outer, innerOp, kind, cond ? this.compile(cond, [...outer.layout, ...innerOp.layout]) : undefined, bindings);
    if (cond) op.details.push(`Join Filter: ${showExpr(cond)}`);
    return this.est(op, rows, outer.cost + inner.cost + outer.estRows * inner.estRows * 0.3);
  }

  /** Orders a cluster of inner joins with dynamic programming over relation subsets. */
  private buildInnerCluster(node: Extract<LNode, { op: 'join' }>, preds: BExpr[]): Operator {
    this.registerScans(node);
    const rels: { node: LNode; ids: Set<number>; local: BExpr[] }[] = [];
    const pool: BExpr[] = [...preds];
    const flatten = (n: LNode) => {
      if (n.op === 'join' && n.kind === 'inner') {
        pool.push(...conjuncts(n.cond));
        flatten(n.left);
        flatten(n.right);
        return;
      }
      const leaf = this.leafOf(n, []);
      rels.push({ node: leaf.node, ids: new Set(n.cols.map((c) => c.id)), local: [] });
      pool.push(...leaf.preds);
    };
    flatten(node);
    const relOf = (p: BExpr): number[] => {
      const ids = refIds(p);
      const out: number[] = [];
      rels.forEach((r, i) => {
        for (const id of ids)
          if (r.ids.has(id)) {
            out.push(i);
            break;
          }
      });
      return out;
    };
    const multi: { pred: BExpr; rels: number[]; mask: number }[] = [];
    const constant: BExpr[] = [];
    for (const p of pool) {
      const rs = relOf(p);
      if (rs.length === 0) constant.push(p);
      else if (rs.length === 1) rels[rs[0]].local.push(p);
      else multi.push({ pred: p, rels: rs, mask: rs.reduce((m, r) => m | (1 << r), 0) });
    }
    const n = rels.length;
    if (n > 30) throw new OpusError(ErrorCode.featureNotSupported, 'too many tables in join (max 30)');

    // standalone estimates
    const base = rels.map((r) => {
      const leaf = this.leafOf(r.node, r.local);
      if (leaf.node.op === 'scan') {
        const p = this.chooseAccess(leaf.node, leaf.preds, {});
        return { rows: Math.max(1, p.rows), cost: p.cost };
      }
      const rows = Math.max(1, this.guessRows(leaf.node) * leaf.preds.reduce((s, p) => s * this.selectivity(p), 1));
      return { rows, cost: rows };
    });

    interface State {
      cost: number;
      rows: number;
      order: number[];
      methods: ('inl' | 'hash' | 'nl')[];
    }
    const full = (1 << n) - 1;
    const best = new Map<number, State>();
    const layoutOfMask = (mask: number) => {
      const ids: number[] = [];
      rels.forEach((r, i) => {
        if (mask & (1 << i)) ids.push(...r.ids);
      });
      return ids;
    };
    const extend = (s: State, mask: number, r: number): State => {
      const newMask = mask | (1 << r);
      const conds = multi.filter((m) => m.mask & (1 << r) && (m.mask & ~newMask) === 0).map((m) => m.pred);
      const alt = this.joinAlternatives(s.rows, layoutOfMask(mask), rels[r].node, rels[r].local, conds, 'inner');
      // cartesian products are a last resort
      const penalty = conds.length === 0 ? 1e6 : 0;
      return { cost: s.cost + alt.cost + penalty, rows: Math.max(1, alt.rows), order: [...s.order, r], methods: [...s.methods, alt.best] };
    };
    if (n <= 10) {
      for (let i = 0; i < n; i++) best.set(1 << i, { cost: base[i].cost, rows: base[i].rows, order: [i], methods: [] });
      for (let mask = 1; mask <= full; mask++) {
        const s = best.get(mask);
        if (!s) continue;
        for (let r = 0; r < n; r++) {
          if (mask & (1 << r)) continue;
          const cand = extend(s, mask, r);
          const nm = mask | (1 << r);
          const cur = best.get(nm);
          if (!cur || cand.cost < cur.cost) best.set(nm, cand);
        }
      }
    } else {
      // greedy for very wide joins
      let startIdx = 0;
      for (let i = 1; i < n; i++) if (base[i].rows < base[startIdx].rows) startIdx = i;
      let s: State = { cost: base[startIdx].cost, rows: base[startIdx].rows, order: [startIdx], methods: [] };
      let mask = 1 << startIdx;
      while (mask !== full) {
        let pick: State | undefined;
        let pickR = -1;
        for (let r = 0; r < n; r++) {
          if (mask & (1 << r)) continue;
          const cand = extend(s, mask, r);
          if (!pick || cand.cost < pick.cost) {
            pick = cand;
            pickR = r;
          }
        }
        s = pick!;
        mask |= 1 << pickR;
      }
      best.set(full, s);
    }
    const plan = best.get(full)!;

    // realise the chosen order
    const first = plan.order[0];
    let op = this.buildFilter(rels[first].node, rels[first].local);
    let mask = 1 << first;
    for (let k = 1; k < plan.order.length; k++) {
      const r = plan.order[k];
      const newMask = mask | (1 << r);
      const conds = multi.filter((m) => m.mask & (1 << r) && (m.mask & ~newMask) === 0).map((m) => m.pred);
      let method = plan.methods[k - 1];
      if (method === 'inl' && this.leafOf(rels[r].node, rels[r].local).node.op !== 'scan') method = 'nl';
      op = this.realizeJoin(op, rels[r].node, rels[r].local, conds, 'inner', method);
      mask = newMask;
    }
    return this.filterOp(op, constant);
  }

  // ------------------------------------------------------------------ aggregation & sorting

  private buildAggregate(node: Extract<LNode, { op: 'aggregate' }>): Operator {
    const input = this.build(node.input);
    const layout = node.cols.map((c) => c.id);
    const aggs: CompiledAgg[] = node.aggs.map((a) => ({
      spec: a,
      args: a.args.map((x) => this.compile(x, input.layout)),
      filter: a.filter ? this.compile(a.filter, input.layout) : undefined,
      orderBy: a.orderBy ? { keys: a.orderBy.map((o) => this.compile(o.expr, input.layout)), cmp: keyComparator(a.orderBy) } : undefined,
    }));
    const op = new HashAggregate(this.ctx, input, node.groups.map((g) => this.compile(g, input.layout)), aggs, layout);
    if (node.groups.length) op.details.push(`Group Key: ${node.groups.map(showExpr).join(', ')}`);
    if (node.aggs.length) op.details.push(node.aggs.map((a) => `${a.name.toLowerCase()}(${a.star ? '*' : (a.distinct ? 'DISTINCT ' : '') + a.args.map(showExpr).join(', ')})`).join(', '));
    const groups = node.groups.length ? Math.max(1, Math.min(input.estRows, Math.sqrt(input.estRows) * 2)) : 1;
    return this.est(op, groups, input.cost + input.estRows);
  }

  private buildSorted(input: LNode, keys: SortKey[], limit?: BExpr, offset?: BExpr): Operator {
    const limitN = limit?.k === 'const' && typeof limit.value === 'number' ? limit.value + (offset?.k === 'const' && typeof offset.value === 'number' ? offset.value : 0) : undefined;
    // try to read rows already in order from an index
    const leaf = this.leafOf(input, []);
    if (leaf.node.op === 'scan') {
      const { op, plan } = this.planAccess(leaf.node, leaf.preds, { order: keys, limit: limitN });
      if (plan.orderSatisfied) {
        op.details.push(`Order: satisfied by ${plan.kind === 'index' ? 'index' : 'rowid'} order`);
        if (!limit && !offset) return op;
        const l = new Limit(this.ctx, op, limit && this.compile(limit, []), offset && this.compile(offset, []));
        return this.est(l, Math.min(op.estRows, limitN ?? op.estRows), op.cost);
      }
      return this.sortOp(op, keys, limit, offset, limitN);
    }
    return this.sortOp(this.build(input), keys, limit, offset, limitN);
  }

  private sortOp(input: Operator, keys: SortKey[], limit: BExpr | undefined, offset: BExpr | undefined, limitN: number | undefined): Operator {
    const fns = keys.map((k) => this.compile(k.expr, input.layout));
    const label = keys.map((k) => `${showExpr(k.expr)}${k.desc ? ' DESC' : ''}`).join(', ');
    if (limit) {
      const op = new TopN(this.ctx, input, fns, keys, this.compile(limit, []), offset && this.compile(offset, []));
      op.details.push(`Sort Key: ${label}`, `Limit: ${showExpr(limit)}${offset ? ` Offset: ${showExpr(offset)}` : ''}`);
      const rows = Math.min(input.estRows, limitN ?? input.estRows);
      return this.est(op, rows, input.cost + input.estRows * log2(Math.max(2, rows)));
    }
    const op = new Sort(this.ctx, input, fns, keys);
    op.details.push(`Sort Key: ${label}`);
    if (offset) {
      const l = new Limit(this.ctx, op, undefined, this.compile(offset, []));
      return this.est(l, input.estRows, input.cost + input.estRows * log2(input.estRows));
    }
    return this.est(op, input.estRows, input.cost + input.estRows * log2(input.estRows));
  }

  // ------------------------------------------------------------------ DML

  planInsert(b: BoundInsert): InsertOp {
    const h = this.handle(b.table);
    let source: Operator | null = null;
    if (b.source !== 'DEFAULT') {
      this.noCovering = true;
      source = this.buildWithLayout(b.source);
      this.noCovering = false;
    }
    let upsert: UpsertSpec | undefined;
    if (b.upsert) {
      const layout = [...b.upsert.existingIds, ...b.upsert.excludedIds];
      const action = b.upsert.action;
      upsert = {
        index: b.upsert.index,
        action:
          action === 'NOTHING'
            ? 'NOTHING'
            : {
                sets: action.sets.map((s) => ({ col: s.col, fn: this.compile(s.expr, layout) })),
                where: action.where ? this.compile(action.where, layout) : undefined,
              },
      };
    }
    const returning = b.returning ? b.returning.exprs.map((e) => this.compile(e, b.returning!.rowIds)) : undefined;
    const op = new InsertOp(this.ctx, h, source, b.targets, {
      conflict: b.conflict,
      upsert,
      returning,
      layout: b.returning ? b.returning.cols.map((c) => c.id) : [],
    });
    return this.est(op, source?.estRows ?? 1, source?.cost ?? 1);
  }

  planUpdate(b: BoundUpdate): UpdateOp {
    const h = this.handle(b.table);
    this.noCovering = true;
    const source = this.build(b.source);
    this.noCovering = false;
    const pos = (id: number) => {
      const i = source.layout.indexOf(id);
      if (i < 0) throw new OpusError(ErrorCode.internal, 'update source lost a table column');
      return i;
    };
    const n = b.table.columns.length;
    const colPos = b.rowIds.slice(0, n).map(pos);
    const sets = b.sets.map((s) => ({ col: s.col, fn: this.compile(s.expr, source.layout) }));
    const returning = b.returning ? b.returning.exprs.map((e) => this.compile(e, b.returning!.rowIds)) : undefined;
    const op = new UpdateOp(this.ctx, h, source, colPos, pos(b.rowIds[n]), sets, returning, b.returning ? b.returning.cols.map((c) => c.id) : []);
    op.details.push(`Set: ${b.sets.map((s) => `${b.table.columns[s.col].name} = ${showExpr(s.expr)}`).join(', ')}`);
    return this.est(op, source.estRows, source.cost);
  }

  planDelete(b: BoundDelete): DeleteOp {
    const h = this.handle(b.table);
    this.noCovering = true;
    const source = this.build(b.source);
    this.noCovering = false;
    const n = b.table.columns.length;
    const pos = (id: number) => source.layout.indexOf(id);
    const returning = b.returning ? b.returning.exprs.map((e) => this.compile(e, b.returning!.rowIds)) : undefined;
    const op = new DeleteOp(
      this.ctx,
      h,
      source,
      b.rowIds.slice(0, n).map(pos),
      pos(b.rowIds[n]),
      b.all,
      returning,
      b.returning ? b.returning.cols.map((c) => c.id) : [],
    );
    return this.est(op, source.estRows, source.cost);
  }
}

/** Column ids referenced by a subtree (plus extra predicates) that it does not produce itself. */
function planFreeIds(node: LNode, extra: BExpr[]): Set<number> {
  const produced = new Set<number>();
  const referenced = new Set<number>();
  const walk = (n: LNode) => {
    for (const c of n.cols) produced.add(c.id);
    const addExpr = (e: BExpr | undefined) => {
      if (e) refIds(e, referenced);
    };
    switch (n.op) {
      case 'filter':
        addExpr(n.pred);
        walk(n.input);
        break;
      case 'project':
        n.exprs.forEach(addExpr);
        walk(n.input);
        break;
      case 'join':
        addExpr(n.cond);
        walk(n.left);
        walk(n.right);
        break;
      case 'aggregate':
        n.groups.forEach(addExpr);
        n.aggs.forEach((a) => {
          a.args.forEach(addExpr);
          addExpr(a.filter);
        });
        walk(n.input);
        break;
      case 'window':
        n.funcs.forEach((w) => {
          w.args.forEach(addExpr);
          w.partitionBy.forEach(addExpr);
          w.orderBy.forEach((o) => addExpr(o.expr));
        });
        walk(n.input);
        break;
      case 'sort':
        n.keys.forEach((k) => addExpr(k.expr));
        walk(n.input);
        break;
      case 'limit':
        addExpr(n.limit);
        addExpr(n.offset);
        walk(n.input);
        break;
      case 'distinct':
        walk(n.input);
        break;
      case 'setop':
        walk(n.left);
        walk(n.right);
        break;
      case 'recursive':
        walk(n.anchor);
        walk(n.recursive);
        break;
      case 'values':
        n.rows.forEach((r) => r.forEach(addExpr));
        break;
      case 'series':
        n.args.forEach(addExpr);
        break;
    }
  };
  walk(node);
  extra.forEach((e) => refIds(e, referenced));
  const out = new Set<number>();
  for (const id of referenced) if (!produced.has(id)) out.add(id);
  return out;
}

export { exprKey };
export type { Value };
