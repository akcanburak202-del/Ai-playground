import type { DataType, Value } from '../types.ts';
import type { BinaryOp } from '../sql/ast.ts';
import type { IndexSchema, TableSchema } from '../catalog.ts';

/**
 * Bound (semantically analysed) expressions and logical plan nodes.
 *
 * Every column produced anywhere in a query gets a globally unique numeric
 * id. Expressions reference columns by id, never by position, so the
 * optimiser can reorder joins freely; physical operators later map ids to
 * row positions. A column id that is not produced by an operator's input is
 * an "outer" reference and is read from the execution context (this is how
 * correlated subqueries and index nested-loop joins receive their values).
 */

export interface ColInfo {
  id: number;
  name: string;
  /** Table alias the column belongs to (lower-cased), if any. */
  table?: string;
  type: DataType;
}

export type SortKey = { expr: BExpr; desc: boolean; nullsFirst: boolean };

export interface SubPlan {
  plan: LNode;
  /** Column ids referenced by the subplan but produced outside of it. */
  freeIds: number[];
  /** Output column of a scalar / IN subquery. */
  type: DataType;
  /**
   * Free ids whose value lives under a different id in the enclosing plan
   * (a grouped column referenced from a subquery in an aggregate query).
   */
  alias?: Map<number, number>;
  /** Reads a recursive CTE's working table: its result changes between iterations. */
  usesWork?: boolean;
}

export type BExpr =
  | { k: 'const'; value: Value; type: DataType }
  | { k: 'col'; id: number; type: DataType; name: string }
  | { k: 'param'; index: number; type: DataType }
  | { k: 'unary'; op: '-' | 'NOT' | '~'; arg: BExpr; type: DataType }
  | { k: 'binary'; op: BinaryOp; left: BExpr; right: BExpr; type: DataType }
  | { k: 'is'; not: boolean; left: BExpr; right: BExpr; type: 'BOOLEAN' }
  | { k: 'isnull'; not: boolean; arg: BExpr; type: 'BOOLEAN' }
  | { k: 'like'; op: 'LIKE' | 'GLOB'; not: boolean; arg: BExpr; pattern: BExpr; escape?: BExpr; type: 'BOOLEAN' }
  | { k: 'between'; not: boolean; arg: BExpr; low: BExpr; high: BExpr; type: 'BOOLEAN' }
  | { k: 'inlist'; not: boolean; arg: BExpr; list: BExpr[]; type: 'BOOLEAN' }
  | { k: 'insub'; not: boolean; arg: BExpr; sub: SubPlan; type: 'BOOLEAN' }
  | { k: 'exists'; sub: SubPlan; type: 'BOOLEAN' }
  | { k: 'scalar'; sub: SubPlan; type: DataType }
  | { k: 'func'; name: string; args: BExpr[]; type: DataType }
  | { k: 'case'; operand?: BExpr; whens: { when: BExpr; then: BExpr }[]; else?: BExpr; type: DataType }
  | { k: 'cast'; arg: BExpr; type: DataType };

export interface AggSpec {
  name: string;
  args: BExpr[];
  distinct: boolean;
  star: boolean;
  filter?: BExpr;
  orderBy?: SortKey[];
  outId: number;
  type: DataType;
}

export interface WindowFuncSpec {
  name: string;
  args: BExpr[];
  partitionBy: BExpr[];
  orderBy: SortKey[];
  frame?: {
    mode: 'ROWS' | 'RANGE';
    start: { kind: string; offset?: number };
    end: { kind: string; offset?: number };
  };
  distinct: boolean;
  filter?: BExpr;
  outId: number;
  type: DataType;
}

export type JoinKind = 'inner' | 'left' | 'full' | 'semi' | 'anti';

export type LNode =
  | { op: 'scan'; table: TableSchema; alias: string; cols: ColInfo[] }
  | { op: 'values'; rows: BExpr[][]; cols: ColInfo[] }
  | { op: 'series'; args: BExpr[]; cols: ColInfo[] }
  | { op: 'filter'; input: LNode; pred: BExpr; cols: ColInfo[] }
  | { op: 'project'; input: LNode; exprs: BExpr[]; cols: ColInfo[] }
  | { op: 'join'; kind: JoinKind; left: LNode; right: LNode; cond?: BExpr; cols: ColInfo[] }
  | { op: 'aggregate'; input: LNode; groups: BExpr[]; aggs: AggSpec[]; cols: ColInfo[] }
  | { op: 'window'; input: LNode; funcs: WindowFuncSpec[]; cols: ColInfo[] }
  | { op: 'sort'; input: LNode; keys: SortKey[]; cols: ColInfo[] }
  | { op: 'limit'; input: LNode; limit?: BExpr; offset?: BExpr; cols: ColInfo[] }
  | { op: 'distinct'; input: LNode; cols: ColInfo[] }
  | { op: 'setop'; kind: 'union' | 'unionall' | 'intersect' | 'except'; left: LNode; right: LNode; cols: ColInfo[] }
  | { op: 'recursive'; anchor: LNode; recursive: LNode; workId: number; distinct: boolean; cols: ColInfo[] }
  | { op: 'worktable'; workId: number; cols: ColInfo[]; name: string };

// ------------------------------------------------------------------ DML plans

export interface BoundInsert {
  kind: 'insert';
  table: TableSchema;
  /** Target column index for each source column. */
  targets: number[];
  source: LNode | 'DEFAULT';
  conflict?: 'REPLACE' | 'IGNORE';
  upsert?: {
    /** Unique index the conflict target refers to (undefined = any). */
    index?: IndexSchema | 'rowid';
    action: 'NOTHING' | { sets: { col: number; expr: BExpr }[]; where?: BExpr };
    /** ids of the existing row's columns (+rowid) and of the excluded row's columns */
    existingIds: number[];
    excludedIds: number[];
  };
  returning?: { exprs: BExpr[]; cols: ColInfo[]; rowIds: number[] };
}

export interface BoundUpdate {
  kind: 'update';
  table: TableSchema;
  /** Produces the table's columns + rowid (ids = rowIds) and any extra FROM columns. */
  source: LNode;
  rowIds: number[];
  sets: { col: number; expr: BExpr }[];
  returning?: { exprs: BExpr[]; cols: ColInfo[]; rowIds: number[] };
}

export interface BoundDelete {
  kind: 'delete';
  table: TableSchema;
  source: LNode;
  rowIds: number[];
  /** True when the statement deletes every row (fast truncate). */
  all: boolean;
  returning?: { exprs: BExpr[]; cols: ColInfo[]; rowIds: number[] };
}

// ------------------------------------------------------------------ helpers

export function children(e: BExpr): BExpr[] {
  switch (e.k) {
    case 'const':
    case 'col':
    case 'param':
    case 'exists':
    case 'scalar':
      return [];
    case 'unary':
    case 'isnull':
    case 'cast':
      return [e.arg];
    case 'binary':
    case 'is':
      return [e.left, e.right];
    case 'like':
      return e.escape ? [e.arg, e.pattern, e.escape] : [e.arg, e.pattern];
    case 'between':
      return [e.arg, e.low, e.high];
    case 'inlist':
      return [e.arg, ...e.list];
    case 'insub':
      return [e.arg];
    case 'func':
      return e.args;
    case 'case': {
      const out: BExpr[] = [];
      if (e.operand) out.push(e.operand);
      for (const w of e.whens) out.push(w.when, w.then);
      if (e.else) out.push(e.else);
      return out;
    }
  }
}

/** Rebuilds an expression bottom-up with `fn` applied to every node (pre-order replacement first). */
export function mapExpr(e: BExpr, fn: (e: BExpr) => BExpr | undefined): BExpr {
  const replaced = fn(e);
  if (replaced) return replaced;
  const m = (x: BExpr) => mapExpr(x, fn);
  switch (e.k) {
    case 'const':
    case 'col':
    case 'param':
    case 'exists':
    case 'scalar':
      return e;
    case 'unary':
      return { ...e, arg: m(e.arg) };
    case 'isnull':
      return { ...e, arg: m(e.arg) };
    case 'cast':
      return { ...e, arg: m(e.arg) };
    case 'binary':
      return { ...e, left: m(e.left), right: m(e.right) };
    case 'is':
      return { ...e, left: m(e.left), right: m(e.right) };
    case 'like':
      return { ...e, arg: m(e.arg), pattern: m(e.pattern), escape: e.escape && m(e.escape) };
    case 'between':
      return { ...e, arg: m(e.arg), low: m(e.low), high: m(e.high) };
    case 'inlist':
      return { ...e, arg: m(e.arg), list: e.list.map(m) };
    case 'insub':
      return { ...e, arg: m(e.arg) };
    case 'func':
      return { ...e, args: e.args.map(m) };
    case 'case':
      return {
        ...e,
        operand: e.operand && m(e.operand),
        whens: e.whens.map((w) => ({ when: m(w.when), then: m(w.then) })),
        else: e.else && m(e.else),
      };
  }
}

/** All column ids an expression depends on, including free ids of nested subqueries. */
export function refIds(e: BExpr, out: Set<number> = new Set()): Set<number> {
  switch (e.k) {
    case 'col':
      out.add(e.id);
      return out;
    case 'insub':
      refIds(e.arg, out);
      for (const id of e.sub.freeIds) out.add(e.sub.alias?.get(id) ?? id);
      return out;
    case 'exists':
    case 'scalar':
      for (const id of e.sub.freeIds) out.add(e.sub.alias?.get(id) ?? id);
      return out;
    default:
      for (const c of children(e)) refIds(c, out);
      return out;
  }
}

export function hasSubquery(e: BExpr): boolean {
  if (e.k === 'insub' || e.k === 'exists' || e.k === 'scalar') return true;
  return children(e).some(hasSubquery);
}

export function isVolatile(e: BExpr): boolean {
  if (e.k === 'func' && (e.name === 'RANDOM' || e.name === 'RANDOMBLOB' || e.name === 'CHANGES')) return true;
  return children(e).some(isVolatile);
}

/** Splits an AND-tree into its conjuncts. */
export function conjuncts(e: BExpr | undefined, out: BExpr[] = []): BExpr[] {
  if (!e) return out;
  if (e.k === 'binary' && e.op === 'AND') {
    conjuncts(e.left, out);
    conjuncts(e.right, out);
  } else out.push(e);
  return out;
}

export function andAll(preds: BExpr[]): BExpr | undefined {
  if (preds.length === 0) return undefined;
  return preds.reduce((a, b) => ({ k: 'binary', op: 'AND', left: a, right: b, type: 'BOOLEAN' }));
}

let subplanKeyCounter = 0;
const subplanKeys = new WeakMap<SubPlan, number>();

/** Canonical string for structural comparison of expressions. */
export function exprKey(e: BExpr): string {
  switch (e.k) {
    case 'const':
      return `c:${typeof e.value}:${String(e.value)}:${e.type}`;
    case 'col':
      return `#${e.id}`;
    case 'param':
      return `?${e.index}`;
    case 'exists':
    case 'scalar':
    case 'insub': {
      let n = subplanKeys.get(e.sub);
      if (n === undefined) subplanKeys.set(e.sub, (n = ++subplanKeyCounter));
      return `${e.k}:${n}` + (e.k === 'insub' ? `(${exprKey(e.arg)},${e.not})` : '');
    }
    case 'unary':
      return `${e.op}(${exprKey(e.arg)})`;
    case 'binary':
      return `(${exprKey(e.left)} ${e.op} ${exprKey(e.right)})`;
    case 'is':
      return `is${e.not ? 'not' : ''}(${exprKey(e.left)},${exprKey(e.right)})`;
    case 'isnull':
      return `isnull${e.not ? 'not' : ''}(${exprKey(e.arg)})`;
    case 'like':
      return `${e.op}${e.not ? '!' : ''}(${children(e).map(exprKey).join(',')})`;
    case 'between':
      return `btw${e.not ? '!' : ''}(${children(e).map(exprKey).join(',')})`;
    case 'inlist':
      return `in${e.not ? '!' : ''}(${children(e).map(exprKey).join(',')})`;
    case 'func':
      return `${e.name}(${e.args.map(exprKey).join(',')})`;
    case 'case':
      return `case(${children(e).map(exprKey).join(',')}${e.operand ? ',op' : ''}${e.else ? ',else' : ''})`;
    case 'cast':
      return `cast(${exprKey(e.arg)} as ${e.type})`;
  }
}

export function isConst(e: BExpr): boolean {
  return e.k === 'const';
}

/** Visits every plan node, including the plans of nested subqueries. */
export function walkPlan(plan: LNode, visit: (n: LNode) => void, exprVisit?: (e: BExpr) => void): void {
  const ex = (e: BExpr | undefined) => {
    if (!e) return;
    const rec = (x: BExpr) => {
      exprVisit?.(x);
      if (x.k === 'insub' || x.k === 'exists' || x.k === 'scalar') walkPlan(x.sub.plan, visit, exprVisit);
      for (const c of children(x)) rec(c);
    };
    rec(e);
  };
  visit(plan);
  switch (plan.op) {
    case 'scan':
    case 'worktable':
      return;
    case 'values':
      plan.rows.forEach((r) => r.forEach(ex));
      return;
    case 'series':
      plan.args.forEach(ex);
      return;
    case 'filter':
      ex(plan.pred);
      return walkPlan(plan.input, visit, exprVisit);
    case 'project':
      plan.exprs.forEach(ex);
      return walkPlan(plan.input, visit, exprVisit);
    case 'join':
      ex(plan.cond);
      walkPlan(plan.left, visit, exprVisit);
      return walkPlan(plan.right, visit, exprVisit);
    case 'aggregate':
      plan.groups.forEach(ex);
      for (const a of plan.aggs) {
        a.args.forEach(ex);
        ex(a.filter);
        a.orderBy?.forEach((o) => ex(o.expr));
      }
      return walkPlan(plan.input, visit, exprVisit);
    case 'window':
      for (const w of plan.funcs) {
        w.args.forEach(ex);
        w.partitionBy.forEach(ex);
        w.orderBy.forEach((o) => ex(o.expr));
        ex(w.filter);
      }
      return walkPlan(plan.input, visit, exprVisit);
    case 'sort':
      plan.keys.forEach((k) => ex(k.expr));
      return walkPlan(plan.input, visit, exprVisit);
    case 'limit':
      ex(plan.limit);
      ex(plan.offset);
      return walkPlan(plan.input, visit, exprVisit);
    case 'distinct':
      return walkPlan(plan.input, visit, exprVisit);
    case 'setop':
      walkPlan(plan.left, visit, exprVisit);
      return walkPlan(plan.right, visit, exprVisit);
    case 'recursive':
      walkPlan(plan.anchor, visit, exprVisit);
      return walkPlan(plan.recursive, visit, exprVisit);
  }
}

/** Every column id referenced by any expression of a plan (subqueries included). */
export function usedIds(plan: LNode): Set<number> {
  const out = new Set<number>();
  walkPlan(plan, () => {}, (e) => {
    if (e.k === 'col') out.add(e.id);
  });
  return out;
}

export function containsWorktable(plan: LNode): boolean {
  let found = false;
  walkPlan(plan, (n) => {
    if (n.op === 'worktable') found = true;
  });
  return found;
}
