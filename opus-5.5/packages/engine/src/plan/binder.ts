import type * as A from '../sql/ast.ts';
import type { DataType, Value } from '../types.ts';
import { ErrorCode, OpusError, isNumericType } from '../types.ts';
import type { Catalog, TableSchema, ViewSchema } from '../catalog.ts';
import { AGGREGATE_FUNCTIONS, SCALAR_FUNCTIONS, WINDOW_FUNCTIONS, castValue, isAggregateName, toNumber } from '../exec/functions.ts';
import { exprToSql } from '../sql/printer.ts';
import type {
  AggSpec,
  BExpr,
  BoundDelete,
  BoundInsert,
  BoundUpdate,
  ColInfo,
  LNode,
  SortKey,
  SubPlan,
  WindowFuncSpec,
} from './bound.ts';
import { children, containsWorktable, exprKey, mapExpr, refIds } from './bound.ts';

/**
 * Semantic analysis: resolves names against the catalog and the lexical
 * scopes of the query, infers static types, and turns the AST into a tree of
 * logical plan nodes (see bound.ts).
 */

interface ScopeEntry {
  table?: string; // lower-cased alias
  name: string;
  lname: string;
  id: number;
  type: DataType;
  /** rowid pseudo-column: never expanded by `*` */
  rowid?: boolean;
  /** right-hand duplicate of a USING/NATURAL join column */
  merged?: boolean;
}

class Scope {
  readonly entries: ScopeEntry[];
  readonly parent?: Scope;
  constructor(entries: ScopeEntry[], parent?: Scope) {
    this.entries = entries;
    this.parent = parent;
  }

  lookup(table: string | undefined, name: string, pos: number): ScopeEntry | undefined {
    const lname = name.toLowerCase();
    const ltable = table?.toLowerCase();
    let found: ScopeEntry | undefined;
    for (const e of this.entries) {
      if (e.lname !== lname) continue;
      if (ltable !== undefined ? e.table !== ltable : e.merged) continue;
      if (e.rowid && found) continue;
      if (found && !found.rowid) {
        throw new OpusError(ErrorCode.ambiguousColumn, `ambiguous column name: ${table ? table + '.' : ''}${name}`, pos);
      }
      found = e;
    }
    if (!found && (lname === 'rowid' || lname === 'oid' || lname === '_rowid_')) {
      const rowids = this.entries.filter((e) => e.rowid && (ltable === undefined || e.table === ltable));
      if (rowids.length > 1) throw new OpusError(ErrorCode.ambiguousColumn, `ambiguous column name: ${name}`, pos);
      found = rowids[0];
    }
    return found;
  }

  hasTable(table: string): boolean {
    const t = table.toLowerCase();
    return this.entries.some((e) => e.table === t);
  }
}

interface CteDef {
  name: string;
  columns?: string[];
  select: A.SelectStmt;
  outer?: Scope;
  recursive: boolean;
  /** Set while the recursive member of this CTE is being bound. */
  work?: { workId: number; cols: ColInfo[] };
}

interface AggContext {
  /** Scope in which aggregate arguments are bound (pre-aggregation). */
  inputScope: Scope;
  specs: AggSpec[];
  byKey: Map<string, AggSpec>;
}

interface WinContext {
  specs: WindowFuncSpec[];
  named?: Map<string, A.WindowSpec>;
}

interface ExprContext {
  agg?: AggContext;
  win?: WinContext;
  clause: string;
}

export interface BoundSelect {
  plan: LNode;
  cols: ColInfo[];
}

export type BoundStatement =
  | { kind: 'select'; plan: LNode; cols: ColInfo[] }
  | BoundInsert
  | BoundUpdate
  | BoundDelete;

function unifyTypes(a: DataType, b: DataType): DataType {
  if (a === b) return a;
  if (a === 'NULL') return b;
  if (b === 'NULL') return a;
  if ((a === 'INTEGER' && b === 'REAL') || (a === 'REAL' && b === 'INTEGER')) return 'REAL';
  if ((a === 'INTEGER' && b === 'BOOLEAN') || (a === 'BOOLEAN' && b === 'INTEGER')) return 'INTEGER';
  return 'ANY';
}

function isBoolish(t: DataType): boolean {
  return t === 'BOOLEAN' || t === 'INTEGER' || t === 'NULL' || t === 'ANY' || t === 'REAL';
}

const typeLabel = (t: DataType) => (t === 'NULL' ? 'NULL' : t);

function containsAggregate(e: A.Expr | undefined): boolean {
  if (!e) return false;
  let found = false;
  const visit = (x: A.Expr): void => {
    if (found) return;
    switch (x.type) {
      case 'function':
        if (!x.over && (x.star ? x.name === 'COUNT' : isAggregateName(x.name, x.args.length))) {
          found = true;
          return;
        }
        x.args.forEach(visit);
        if (x.filter) visit(x.filter);
        return;
      case 'unary':
        return visit(x.expr);
      case 'binary':
        visit(x.left);
        return visit(x.right);
      case 'is':
        visit(x.left);
        return visit(x.right);
      case 'is_null':
        return visit(x.expr);
      case 'like':
        visit(x.expr);
        visit(x.pattern);
        if (x.escape) visit(x.escape);
        return;
      case 'between':
        visit(x.expr);
        visit(x.low);
        return visit(x.high);
      case 'in_list':
        visit(x.expr);
        return x.list.forEach(visit);
      case 'in_select':
        return visit(x.expr);
      case 'case':
        if (x.operand) visit(x.operand);
        x.whens.forEach((w) => {
          visit(w.when);
          visit(w.then);
        });
        if (x.else) visit(x.else);
        return;
      case 'cast':
        return visit(x.expr);
      default:
        return;
    }
  };
  visit(e);
  return found;
}

export class Binder {
  private readonly catalog: Catalog;
  private nextId = 1;
  private readonly cteStack: Map<string, CteDef>[] = [];
  private viewDepth = 0;

  constructor(catalog: Catalog) {
    this.catalog = catalog;
  }

  newId(): number {
    return this.nextId++;
  }

  get idCount(): number {
    return this.nextId;
  }

  // ------------------------------------------------------------------ statements

  bindStatement(stmt: A.Statement): BoundStatement {
    switch (stmt.type) {
      case 'select': {
        const r = this.bindSelect(stmt, undefined);
        return { kind: 'select', plan: r.plan, cols: r.cols };
      }
      case 'insert':
        return this.withCtes(stmt.with, undefined, () => this.bindInsert(stmt));
      case 'update':
        return this.withCtes(stmt.with, undefined, () => this.bindUpdate(stmt));
      case 'delete':
        return this.withCtes(stmt.with, undefined, () => this.bindDelete(stmt));
      default:
        throw new OpusError(ErrorCode.internal, `cannot bind ${stmt.type}`);
    }
  }

  private withCtes<T>(w: A.WithClause | undefined, outer: Scope | undefined, fn: () => T): T {
    if (!w) return fn();
    const frame = new Map<string, CteDef>();
    for (const cte of w.ctes) {
      const key = cte.name.toLowerCase();
      if (frame.has(key)) throw new OpusError(ErrorCode.duplicateTable, `duplicate WITH table name: ${cte.name}`, cte.pos);
      frame.set(key, { name: cte.name, columns: cte.columns, select: cte.select, outer, recursive: w.recursive });
    }
    this.cteStack.push(frame);
    try {
      return fn();
    } finally {
      this.cteStack.pop();
    }
  }

  private findCte(name: string): CteDef | undefined {
    const key = name.toLowerCase();
    for (let i = this.cteStack.length - 1; i >= 0; i--) {
      const d = this.cteStack[i].get(key);
      if (d) return d;
    }
    return undefined;
  }

  // ------------------------------------------------------------------ SELECT

  bindSelect(stmt: A.SelectStmt, outer: Scope | undefined): BoundSelect {
    return this.withCtes(stmt.with, outer, () => {
      if (stmt.body.type === 'core') return this.bindCore(stmt.body, outer, stmt);
      let { plan, cols } = this.bindBody(stmt.body, outer);
      if (stmt.orderBy) {
        const scope = new Scope(
          cols.map((c) => ({ name: c.name, lname: c.name.toLowerCase(), id: c.id, type: c.type })),
          outer,
        );
        const keys = stmt.orderBy.map((item) => {
          let expr: BExpr;
          if (item.expr.type === 'literal' && item.expr.dataType === 'INTEGER' && typeof item.expr.value === 'number') {
            const k = item.expr.value;
            if (k < 1 || k > cols.length) {
              throw new OpusError(ErrorCode.invalidParameter, `ORDER BY term out of range - should be between 1 and ${cols.length}`, item.expr.pos);
            }
            const c = cols[k - 1];
            expr = { k: 'col', id: c.id, type: c.type, name: c.name };
          } else {
            expr = this.bindExpr(item.expr, scope, { clause: 'ORDER BY' });
            for (const id of refIds(expr)) {
              if (!cols.some((c) => c.id === id)) {
                throw new OpusError(ErrorCode.undefinedColumn, 'ORDER BY term does not match any column in the result set', item.expr.pos);
              }
            }
          }
          return this.sortKey(expr, item);
        });
        plan = { op: 'sort', input: plan, keys, cols };
      }
      plan = this.bindLimit(stmt, plan);
      return { plan, cols };
    });
  }

  private sortKey(expr: BExpr, item: A.OrderItem): SortKey {
    // SQLite semantics: NULLs are the smallest value
    const nullsFirst = item.nulls ? item.nulls === 'FIRST' : !item.desc;
    return { expr, desc: item.desc, nullsFirst };
  }

  private bindLimit(stmt: A.SelectStmt, plan: LNode): LNode {
    if (!stmt.limit && !stmt.offset) return plan;
    const empty = new Scope([]);
    const bindInt = (e: A.Expr | undefined, what: string) => {
      if (!e) return undefined;
      const b = this.bindExpr(e, empty, { clause: what });
      if (b.type === 'TEXT' || b.type === 'BOOLEAN') throw new OpusError(ErrorCode.datatypeMismatch, `${what} must be an integer`, e.pos);
      return b;
    };
    return { op: 'limit', input: plan, limit: bindInt(stmt.limit, 'LIMIT'), offset: bindInt(stmt.offset, 'OFFSET'), cols: plan.cols };
  }

  private bindBody(body: A.SelectBody, outer: Scope | undefined): BoundSelect {
    if (body.type === 'core') return this.bindCore(body, outer, undefined);
    if (body.type === 'values') return this.bindValues(body, outer);
    const left = this.bindBody(body.left, outer);
    const right = this.bindBody(body.right, outer);
    if (left.cols.length !== right.cols.length) {
      throw new OpusError(ErrorCode.syntax, `SELECTs to the left and right of ${body.op} do not have the same number of result columns`, body.pos);
    }
    const cols = left.cols.map((c, i) => ({ id: this.newId(), name: c.name, type: unifyTypes(c.type, right.cols[i].type) }));
    const kind = body.op === 'UNION' ? 'union' : body.op === 'UNION ALL' ? 'unionall' : body.op === 'INTERSECT' ? 'intersect' : 'except';
    return { plan: { op: 'setop', kind, left: left.plan, right: right.plan, cols }, cols };
  }

  private bindValues(body: A.ValuesBody, outer: Scope | undefined): BoundSelect {
    const scope = new Scope([], outer);
    const width = body.rows[0].length;
    const rows = body.rows.map((r) => {
      if (r.length !== width) throw new OpusError(ErrorCode.syntax, 'all VALUES must have the same number of terms', body.pos);
      return r.map((e) => this.bindExpr(e, scope, { clause: 'VALUES' }));
    });
    const cols: ColInfo[] = [];
    for (let i = 0; i < width; i++) {
      let type: DataType = 'NULL';
      for (const r of rows) type = unifyTypes(type, r[i].type);
      cols.push({ id: this.newId(), name: `column${i + 1}`, type: type === 'NULL' ? 'ANY' : type });
    }
    return { plan: { op: 'values', rows, cols }, cols };
  }

  private bindCore(core: A.SelectCore, outer: Scope | undefined, stmt: A.SelectStmt | undefined): BoundSelect {
    // 1. FROM
    let plan: LNode;
    let scope: Scope;
    if (core.from) {
      const f = this.bindFrom(core.from, outer);
      plan = f.plan;
      scope = new Scope(f.entries, outer);
    } else {
      plan = { op: 'values', rows: [[]], cols: [] };
      scope = new Scope([], outer);
    }
    const localIds = new Set(scope.entries.map((e) => e.id));

    // 2. WHERE
    if (core.where) {
      if (containsAggregate(core.where)) throw new OpusError(ErrorCode.groupingError, 'aggregate functions are not allowed in WHERE', core.where.pos);
      const pred = this.bindExpr(core.where, scope, { clause: 'WHERE' });
      this.expectBool(pred, core.where.pos, 'WHERE');
      plan = { op: 'filter', input: plan, pred, cols: plan.cols };
    }

    // 3. expand the select list
    const items: { ast?: A.Expr; bound?: BExpr; name: string; alias?: string }[] = [];
    for (const rc of core.columns) {
      if (rc.expr.type === 'star') {
        const table = rc.expr.table?.toLowerCase();
        if (table !== undefined && !scope.hasTable(table)) throw new OpusError(ErrorCode.undefinedTable, `no such table: ${rc.expr.table}`, rc.expr.pos);
        const entries = scope.entries.filter((e) => !e.rowid && (table === undefined ? !e.merged : e.table === table));
        if (entries.length === 0 && table === undefined) throw new OpusError(ErrorCode.syntax, 'no tables specified', rc.expr.pos);
        for (const e of entries) items.push({ bound: { k: 'col', id: e.id, type: e.type, name: e.name }, name: e.name });
      } else {
        const name = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : rc.text);
        items.push({ ast: rc.expr, name, alias: rc.alias });
      }
    }

    // 4. aggregation
    const hasAgg =
      !!core.groupBy || containsAggregate(core.having) || core.columns.some((c) => containsAggregate(c.expr)) || (stmt?.orderBy ?? []).some((o) => containsAggregate(o.expr));
    let ctx: ExprContext = { clause: 'SELECT' };
    const exprScope = scope;
    let aggNode: Extract<LNode, { op: 'aggregate' }> | undefined;
    let postAggCheck: ((e: BExpr, pos: number) => BExpr) | undefined;
    if (hasAgg) {
      const groups: BExpr[] = [];
      for (const g of core.groupBy ?? []) {
        let ast = g;
        if (g.type === 'literal' && g.dataType === 'INTEGER' && typeof g.value === 'number') {
          const k = g.value;
          if (k < 1 || k > items.length) throw new OpusError(ErrorCode.invalidParameter, `GROUP BY term out of range - should be between 1 and ${items.length}`, g.pos);
          const item = items[k - 1];
          if (item.bound) {
            groups.push(item.bound);
            continue;
          }
          ast = item.ast!;
        } else if (g.type === 'column' && !g.table && !scope.lookup(undefined, g.name, g.pos)) {
          const aliased = items.find((i) => i.alias && i.alias.toLowerCase() === g.name.toLowerCase());
          if (aliased?.ast) ast = aliased.ast;
        }
        if (containsAggregate(ast)) throw new OpusError(ErrorCode.groupingError, 'aggregate functions are not allowed in GROUP BY', ast.pos);
        groups.push(this.bindExpr(ast, scope, { clause: 'GROUP BY' }));
      }
      const groupCols: ColInfo[] = groups.map((g) => ({ id: this.newId(), name: g.k === 'col' ? g.name : 'group', type: g.type }));
      const plainGroup = new Map<number, ColInfo>();
      groups.forEach((g, i) => {
        if (g.k === 'col' && !plainGroup.has(g.id)) plainGroup.set(g.id, groupCols[i]);
      });
      const agg: AggContext = { inputScope: scope, specs: [], byKey: new Map() };
      ctx = { clause: 'SELECT', agg };
      aggNode = { op: 'aggregate', input: plan, groups, aggs: agg.specs, cols: [] };
      const groupKeys = groups.map((g) => exprKey(g));
      const aliasSub = (sub: SubPlan) => {
        for (const id of sub.freeIds) {
          const gc = plainGroup.get(id);
          if (gc) (sub.alias ??= new Map()).set(id, gc.id);
        }
      };
      // Expressions above the aggregate may only use grouped expressions, aggregates or outer columns.
      postAggCheck = (e: BExpr, pos: number) => {
        const rewritten = mapExpr(e, (x) => {
          if (x.k === 'const' || x.k === 'param') return x;
          const gi = groupKeys.indexOf(exprKey(x));
          if (gi >= 0) return { k: 'col', id: groupCols[gi].id, type: groupCols[gi].type, name: groupCols[gi].name };
          if (x.k === 'scalar' || x.k === 'exists' || x.k === 'insub') aliasSub(x.sub);
          return undefined;
        });
        for (const id of refIds(rewritten)) {
          if (localIds.has(id)) {
            const entry = scope.entries.find((en) => en.id === id);
            throw new OpusError(
              ErrorCode.groupingError,
              `column "${entry ? (entry.table ? entry.table + '.' : '') + entry.name : id}" must appear in the GROUP BY clause or be used in an aggregate function`,
              pos,
            );
          }
        }
        return rewritten;
      };
      aggNode.cols = groupCols; // agg cols appended after binding
    }

    const win: WinContext = { specs: [], named: core.windows };
    const bindItem = (ast: A.Expr, clause: string): BExpr => {
      const e = this.bindExpr(ast, exprScope, { ...ctx, clause, win });
      return postAggCheck ? postAggCheck(e, ast.pos) : e;
    };

    // 5. HAVING
    let having: BExpr | undefined;
    if (core.having) {
      if (!hasAgg) throw new OpusError(ErrorCode.groupingError, 'HAVING clause on a non-aggregate query', core.having.pos);
      having = this.bindExpr(core.having, exprScope, { ...ctx, clause: 'HAVING' });
      having = postAggCheck!(having, core.having.pos);
      this.expectBool(having, core.having.pos, 'HAVING');
    }

    // 6. select items
    for (const item of items) {
      if (item.bound) {
        if (postAggCheck) item.bound = postAggCheck(item.bound, 0);
        continue;
      }
      item.bound = bindItem(item.ast!, 'SELECT');
    }

    // window functions of an aggregate query see the aggregated rows
    const rewriteWindows = () => {
      if (!postAggCheck) return;
      for (const w of win.specs) {
        if ((w as { checked?: boolean }).checked) continue;
        (w as { checked?: boolean }).checked = true;
        w.args = w.args.map((a) => postAggCheck!(a, 0));
        w.partitionBy = w.partitionBy.map((a) => postAggCheck!(a, 0));
        w.orderBy = w.orderBy.map((o) => ({ ...o, expr: postAggCheck!(o.expr, 0) }));
        if (w.filter) w.filter = postAggCheck(w.filter, 0);
      }
    };
    rewriteWindows();

    // 7. ORDER BY (bound before projection so it may reference any input column)
    let sortKeys: SortKey[] | undefined;
    const distinct = core.distinct;
    if (stmt?.orderBy) {
      sortKeys = stmt.orderBy.map((o) => {
        let bound: BExpr | undefined;
        let itemIndex = -1;
        if (o.expr.type === 'literal' && o.expr.dataType === 'INTEGER' && typeof o.expr.value === 'number') {
          const k = o.expr.value;
          if (k < 1 || k > items.length) {
            throw new OpusError(ErrorCode.invalidParameter, `ORDER BY term out of range - should be between 1 and ${items.length}`, o.expr.pos);
          }
          itemIndex = k - 1;
          bound = items[itemIndex].bound;
        } else if (o.expr.type === 'column' && !o.expr.table) {
          const name = o.expr.name.toLowerCase();
          itemIndex = items.findIndex((i) => i.alias !== undefined && i.alias.toLowerCase() === name);
          if (itemIndex >= 0) bound = items[itemIndex].bound;
        }
        if (!bound) {
          bound = bindItem(o.expr, 'ORDER BY');
          const key = exprKey(bound);
          itemIndex = items.findIndex((i) => exprKey(i.bound!) === key);
        }
        if (distinct && itemIndex < 0) {
          throw new OpusError(ErrorCode.syntax, 'for SELECT DISTINCT, ORDER BY expressions must appear in select list', o.expr.pos);
        }
        const key = this.sortKey(bound, o);
        return Object.assign(key, { itemIndex });
      });
    }

    rewriteWindows();

    // 8. assemble the plan
    if (aggNode) {
      aggNode.cols = [...aggNode.cols, ...aggNode.aggs.map((a) => ({ id: a.outId, name: a.name.toLowerCase(), type: a.type }))];
      plan = aggNode;
      if (having) plan = { op: 'filter', input: plan, pred: having, cols: plan.cols };
    }
    if (win.specs.length) {
      plan = { op: 'window', input: plan, funcs: win.specs, cols: [...plan.cols, ...win.specs.map((w) => ({ id: w.outId, name: w.name.toLowerCase(), type: w.type }))] };
    }
    const outCols: ColInfo[] = items.map((i) => ({ id: this.newId(), name: i.name, type: i.bound!.type === 'NULL' ? 'ANY' : i.bound!.type }));
    if (!distinct) {
      if (sortKeys?.length) plan = { op: 'sort', input: plan, keys: sortKeys, cols: plan.cols };
      plan = { op: 'project', input: plan, exprs: items.map((i) => i.bound!), cols: outCols };
    } else {
      plan = { op: 'project', input: plan, exprs: items.map((i) => i.bound!), cols: outCols };
      plan = { op: 'distinct', input: plan, cols: outCols };
      if (sortKeys?.length) {
        const keys = sortKeys.map((k) => {
          const idx = (k as SortKey & { itemIndex: number }).itemIndex;
          const c = outCols[idx];
          return { expr: { k: 'col', id: c.id, type: c.type, name: c.name } as BExpr, desc: k.desc, nullsFirst: k.nullsFirst };
        });
        plan = { op: 'sort', input: plan, keys, cols: outCols };
      }
    }
    if (stmt) plan = this.bindLimit(stmt, plan);
    return { plan, cols: outCols };
  }

  private expectBool(e: BExpr, pos: number, clause: string): void {
    if (!isBoolish(e.type)) throw new OpusError(ErrorCode.datatypeMismatch, `argument of ${clause} must be type BOOLEAN, not type ${e.type}`, pos);
  }

  // ------------------------------------------------------------------ FROM

  private scanOf(table: TableSchema, alias: string): { plan: LNode; entries: ScopeEntry[] } {
    const a = alias.toLowerCase();
    const cols: ColInfo[] = table.columns.map((c) => ({ id: this.newId(), name: c.name, table: a, type: c.type }));
    cols.push({ id: this.newId(), name: 'rowid', table: a, type: 'INTEGER' });
    const entries: ScopeEntry[] = cols.map((c, i) => ({
      table: a,
      name: c.name,
      lname: c.name.toLowerCase(),
      id: c.id,
      type: c.type,
      rowid: i === cols.length - 1,
    }));
    return { plan: { op: 'scan', table, alias: a, cols }, entries };
  }

  private entriesFor(cols: ColInfo[], alias: string | undefined): ScopeEntry[] {
    const a = alias?.toLowerCase();
    return cols.map((c) => ({ table: a, name: c.name, lname: c.name.toLowerCase(), id: c.id, type: c.type }));
  }

  private renameCols(cols: ColInfo[], names: string[] | undefined, what: string, pos: number): ColInfo[] {
    if (!names) return cols;
    if (names.length !== cols.length) {
      throw new OpusError(ErrorCode.syntax, `${what} has ${cols.length} values for ${names.length} columns`, pos);
    }
    return cols.map((c, i) => ({ ...c, name: names[i] }));
  }

  private bindFrom(item: A.FromItem, outer: Scope | undefined): { plan: LNode; entries: ScopeEntry[] } {
    switch (item.type) {
      case 'table': {
        const alias = item.alias ?? item.name;
        const cte = this.findCte(item.name);
        if (cte) return this.bindCteRef(cte, alias, item.pos);
        const view = this.catalog.views.get(item.name.toLowerCase());
        if (view) return this.bindViewRef(view, alias, item.pos);
        const table = this.catalog.getTable(item.name, item.pos);
        return this.scanOf(table, alias);
      }
      case 'subquery': {
        const r = this.bindSelect(item.select, outer);
        // Project into fresh ids so the same subquery can appear twice safely.
        return { plan: r.plan, entries: this.entriesFor(r.cols, item.alias) };
      }
      case 'function_table': {
        if (item.name !== 'generate_series') throw new OpusError(ErrorCode.undefinedTable, `no such table-valued function: ${item.name}`, item.pos);
        if (item.args.length < 1 || item.args.length > 3) throw new OpusError(ErrorCode.syntax, 'generate_series expects 1 to 3 arguments', item.pos);
        const scope = new Scope([], outer);
        const args = item.args.map((a) => this.bindExpr(a, scope, { clause: 'FROM' }));
        const cols: ColInfo[] = [{ id: this.newId(), name: 'value', table: (item.alias ?? item.name).toLowerCase(), type: 'INTEGER' }];
        if (args.some((a) => a.type === 'REAL')) cols[0].type = 'REAL';
        return { plan: { op: 'series', args, cols }, entries: this.entriesFor(cols, item.alias ?? item.name) };
      }
      case 'join': {
        const left = this.bindFrom(item.left, outer);
        const right = this.bindFrom(item.right, outer);
        const entries = [...left.entries, ...right.entries];
        let using = item.using;
        if (item.natural) {
          const leftNames = new Set(left.entries.filter((e) => !e.rowid && !e.merged).map((e) => e.lname));
          using = right.entries.filter((e) => !e.rowid && leftNames.has(e.lname)).map((e) => e.name);
        }
        const conds: BExpr[] = [];
        if (using) {
          for (const name of using) {
            const ln = name.toLowerCase();
            const l = new Scope(left.entries).lookup(undefined, name, item.pos);
            const rIdx = right.entries.findIndex((e) => e.lname === ln && !e.rowid && !e.merged);
            if (!l || rIdx < 0) throw new OpusError(ErrorCode.undefinedColumn, `cannot join using column ${name} - column not present in both tables`, item.pos);
            const r = right.entries[rIdx];
            const ri = entries.indexOf(r);
            entries[ri] = { ...r, merged: true };
            conds.push(this.comparison('=', { k: 'col', id: l.id, type: l.type, name: l.name }, { k: 'col', id: r.id, type: r.type, name: r.name }, item.pos));
          }
        }
        if (item.on) {
          const scope = new Scope(entries, outer);
          const on = this.bindExpr(item.on, scope, { clause: 'ON' });
          this.expectBool(on, item.on.pos, 'ON');
          conds.push(on);
        }
        const cond = conds.length ? conds.reduce((a, b) => ({ k: 'binary', op: 'AND', left: a, right: b, type: 'BOOLEAN' })) : undefined;
        let plan: LNode;
        if (item.kind === 'RIGHT') plan = { op: 'join', kind: 'left', left: right.plan, right: left.plan, cond, cols: [...right.plan.cols, ...left.plan.cols] };
        else {
          const kind = item.kind === 'LEFT' ? 'left' : item.kind === 'FULL' ? 'full' : 'inner';
          plan = { op: 'join', kind, left: left.plan, right: right.plan, cond, cols: [...left.plan.cols, ...right.plan.cols] };
        }
        return { plan, entries };
      }
    }
  }

  private bindViewRef(view: ViewSchema, alias: string, pos: number): { plan: LNode; entries: ScopeEntry[] } {
    if (this.viewDepth > 32) throw new OpusError(ErrorCode.syntax, `view ${view.name} is circularly defined`, pos);
    this.viewDepth++;
    try {
      const saved = this.cteStack.splice(0);
      try {
        const r = this.bindSelect(view.select, undefined);
        const cols = this.renameCols(r.cols, view.columns, `view ${view.name}`, pos);
        return { plan: r.plan, entries: this.entriesFor(cols, alias) };
      } finally {
        this.cteStack.push(...saved);
      }
    } finally {
      this.viewDepth--;
    }
  }

  private bindCteRef(cte: CteDef, alias: string, pos: number): { plan: LNode; entries: ScopeEntry[] } {
    if (cte.work) {
      // reference to the working table from inside the recursive member
      const cols = cte.work.cols.map((c) => ({ ...c, id: this.newId() }));
      return { plan: { op: 'worktable', workId: cte.work.workId, cols, name: cte.name }, entries: this.entriesFor(cols, alias) };
    }
    const body = cte.select.body;
    const selfRef = cte.recursive && body.type === 'compound' && (body.op === 'UNION' || body.op === 'UNION ALL') && referencesTable(body.right, cte.name);
    if (!selfRef) {
      if (cte.recursive && referencesTable(cte.select.body, cte.name)) {
        throw new OpusError(ErrorCode.syntax, `recursive reference in a subquery: ${cte.name}`, pos);
      }
      // Bind the CTE body with the CTE itself hidden to avoid infinite recursion.
      const r = this.bindCteBody(cte, () => this.bindSelect(cte.select, cte.outer));
      const cols = this.renameCols(r.cols, cte.columns, `table ${cte.name}`, pos);
      return { plan: r.plan, entries: this.entriesFor(cols, alias) };
    }
    if (cte.select.orderBy || cte.select.limit) {
      throw new OpusError(ErrorCode.featureNotSupported, 'ORDER BY / LIMIT are not supported directly on a recursive CTE', pos);
    }
    const compound = body as A.CompoundBody;
    const anchor = this.bindCteBody(cte, () => this.withCtes(cte.select.with, cte.outer, () => this.bindBody(compound.left, cte.outer)));
    const anchorCols = this.renameCols(anchor.cols, cte.columns, `table ${cte.name}`, pos);
    const workId = this.newId();
    cte.work = { workId, cols: anchorCols };
    let rec: BoundSelect;
    try {
      rec = this.withCtes(cte.select.with, cte.outer, () => this.bindBody(compound.right, cte.outer));
    } finally {
      cte.work = undefined;
    }
    if (rec.cols.length !== anchorCols.length) {
      throw new OpusError(ErrorCode.syntax, `recursive member of ${cte.name} has ${rec.cols.length} columns, expected ${anchorCols.length}`, pos);
    }
    const cols = anchorCols.map((c, i) => ({ id: this.newId(), name: c.name, type: unifyTypes(c.type, rec.cols[i].type) }));
    const plan: LNode = { op: 'recursive', anchor: anchor.plan, recursive: rec.plan, workId, distinct: compound.op === 'UNION', cols };
    return { plan, entries: this.entriesFor(cols, alias) };
  }

  private bindCteBody<T>(cte: CteDef, fn: () => T): T {
    // Inside its own definition a non-recursive CTE name refers to an outer object.
    const key = cte.name.toLowerCase();
    const hidden: { frame: Map<string, CteDef>; def: CteDef }[] = [];
    for (const frame of this.cteStack) {
      const d = frame.get(key);
      if (d === cte) {
        frame.delete(key);
        hidden.push({ frame, def: d });
      }
    }
    try {
      return fn();
    } finally {
      for (const h of hidden) h.frame.set(key, h.def);
    }
  }

  // ------------------------------------------------------------------ expressions

  private subplan(select: A.SelectStmt, scope: Scope, expectOne: boolean, pos: number): SubPlan {
    const start = this.nextId;
    const r = this.bindSelect(select, scope);
    if (expectOne && r.cols.length !== 1) throw new OpusError(ErrorCode.syntax, `sub-select returns ${r.cols.length} columns - expected 1`, pos);
    const free = new Set<number>();
    for (const id of planRefIds(r.plan)) if (id < start) free.add(id);
    return { plan: r.plan, freeIds: [...free], type: r.cols[0]?.type ?? 'ANY', usesWork: containsWorktable(r.plan) };
  }

  /** Builds a comparison, applying SQLite-style affinity to literal operands. */
  private comparison(op: A.BinaryOp, left: BExpr, right: BExpr, pos: number): BExpr {
    [left, right] = this.coercePair(left, right, pos);
    return { k: 'binary', op, left, right, type: 'BOOLEAN' };
  }

  private coerceLiteral(lit: BExpr, target: DataType, pos: number): BExpr {
    if (lit.k !== 'const' || lit.value === null) return lit;
    if (isNumericType(target) && target !== 'BOOLEAN' && typeof lit.value === 'string') {
      const s = lit.value.trim();
      if (s !== '' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
        const n = Number(s);
        return { k: 'const', value: n, type: Number.isInteger(n) && !/[.eE]/.test(s) ? 'INTEGER' : 'REAL' };
      }
      return lit;
    }
    if (target === 'TEXT' && typeof lit.value === 'number') {
      return { k: 'const', value: castValue(lit.value, 'TEXT', lit.type), type: 'TEXT' };
    }
    if (target === 'BOOLEAN' && typeof lit.value === 'string') {
      const b = castValue(lit.value, 'BOOLEAN');
      return { k: 'const', value: b, type: 'BOOLEAN' };
    }
    void pos;
    return lit;
  }

  private coercePair(left: BExpr, right: BExpr, pos: number): [BExpr, BExpr] {
    if (left.k === 'const' && right.k !== 'const') left = this.coerceLiteral(left, right.type, pos);
    else if (right.k === 'const' && left.k !== 'const') right = this.coerceLiteral(right, left.type, pos);
    return [left, right];
  }

  private arithmeticType(op: string, l: DataType, r: DataType, pos: number): DataType {
    for (const t of [l, r]) {
      if (t === 'TEXT') throw new OpusError(ErrorCode.datatypeMismatch, `operator ${op} cannot be applied to type TEXT (use CAST)`, pos);
    }
    if (l === 'ANY' || r === 'ANY') return 'ANY';
    if (l === 'REAL' || r === 'REAL') return 'REAL';
    return 'INTEGER';
  }

  bindExpr(e: A.Expr, scope: Scope, ctx: ExprContext): BExpr {
    switch (e.type) {
      case 'literal':
        return { k: 'const', value: e.value, type: e.dataType };
      case 'column': {
        for (let s: Scope | undefined = scope; s; s = s.parent) {
          const entry = s.lookup(e.table, e.name, e.pos);
          if (entry) return { k: 'col', id: entry.id, type: entry.type, name: entry.name };
        }
        if (e.table) {
          let known = false;
          for (let s: Scope | undefined = scope; s; s = s.parent) if (s.hasTable(e.table)) known = true;
          if (!known) throw new OpusError(ErrorCode.undefinedTable, `no such table: ${e.table}`, e.pos);
        }
        throw new OpusError(ErrorCode.undefinedColumn, `no such column: ${e.table ? e.table + '.' : ''}${e.name}`, e.pos);
      }
      case 'star':
        throw new OpusError(ErrorCode.syntax, '"*" is only allowed in the select list or in COUNT(*)', e.pos);
      case 'param':
        return { k: 'param', index: e.index, type: 'ANY' };
      case 'unary': {
        const arg = this.bindExpr(e.expr, scope, ctx);
        if (e.op === '+') return arg;
        if (e.op === 'NOT') {
          this.expectBool(arg, e.pos, 'NOT');
          if (arg.k === 'const') return { k: 'const', value: arg.value === null ? null : !toBoolConst(arg.value), type: 'BOOLEAN' };
          return { k: 'unary', op: 'NOT', arg, type: 'BOOLEAN' };
        }
        if (arg.type === 'TEXT') throw new OpusError(ErrorCode.datatypeMismatch, `operator ${e.op} cannot be applied to type TEXT`, e.pos);
        if (e.op === '~') return { k: 'unary', op: '~', arg, type: 'INTEGER' };
        return { k: 'unary', op: '-', arg, type: arg.type === 'BOOLEAN' || arg.type === 'NULL' ? 'INTEGER' : arg.type };
      }
      case 'binary': {
        let left = this.bindExpr(e.left, scope, ctx);
        let right = this.bindExpr(e.right, scope, ctx);
        switch (e.op) {
          case 'AND':
          case 'OR':
            this.expectBool(left, e.left.pos, e.op);
            this.expectBool(right, e.right.pos, e.op);
            return { k: 'binary', op: e.op, left, right, type: 'BOOLEAN' };
          case '=':
          case '!=':
          case '<':
          case '<=':
          case '>':
          case '>=':
            return this.comparison(e.op, left, right, e.pos);
          case '||':
            return { k: 'binary', op: '||', left, right, type: 'TEXT' };
          case '&':
          case '|':
          case '<<':
          case '>>':
            [left, right] = this.coercePair(left, right, e.pos);
            this.arithmeticType(e.op, left.type, right.type, e.pos);
            return { k: 'binary', op: e.op, left, right, type: 'INTEGER' };
          default: {
            if (left.k === 'const' && typeof left.value === 'string') left = this.coerceLiteral(left, 'REAL', e.pos);
            if (right.k === 'const' && typeof right.value === 'string') right = this.coerceLiteral(right, 'REAL', e.pos);
            const type = this.arithmeticType(e.op, left.type, right.type, e.pos);
            return { k: 'binary', op: e.op, left, right, type };
          }
        }
      }
      case 'is': {
        const [left, right] = this.coercePair(this.bindExpr(e.left, scope, ctx), this.bindExpr(e.right, scope, ctx), e.pos);
        return { k: 'is', not: e.not, left, right, type: 'BOOLEAN' };
      }
      case 'is_null':
        return { k: 'isnull', not: e.not, arg: this.bindExpr(e.expr, scope, ctx), type: 'BOOLEAN' };
      case 'like': {
        const arg = this.bindExpr(e.expr, scope, ctx);
        const pattern = this.bindExpr(e.pattern, scope, ctx);
        const escape = e.escape ? this.bindExpr(e.escape, scope, ctx) : undefined;
        return { k: 'like', op: e.op, not: e.not, arg, pattern, escape, type: 'BOOLEAN' };
      }
      case 'between': {
        let arg = this.bindExpr(e.expr, scope, ctx);
        let low = this.bindExpr(e.low, scope, ctx);
        let high = this.bindExpr(e.high, scope, ctx);
        [arg, low] = this.coercePair(arg, low, e.pos);
        [arg, high] = this.coercePair(arg, high, e.pos);
        return { k: 'between', not: e.not, arg, low, high, type: 'BOOLEAN' };
      }
      case 'in_list': {
        const arg = this.bindExpr(e.expr, scope, ctx);
        const list = e.list.map((x) => this.coercePair(arg, this.bindExpr(x, scope, ctx), x.pos)[1]);
        if (list.length === 0) return { k: 'const', value: e.not, type: 'BOOLEAN' };
        return { k: 'inlist', not: e.not, arg, list, type: 'BOOLEAN' };
      }
      case 'in_select': {
        const arg = this.bindExpr(e.expr, scope, ctx);
        const sub = this.subplan(e.select, scope, true, e.pos);
        return { k: 'insub', not: e.not, arg, sub, type: 'BOOLEAN' };
      }
      case 'exists':
        return { k: 'exists', sub: this.subplan(e.select, scope, false, e.pos), type: 'BOOLEAN' };
      case 'subquery': {
        const sub = this.subplan(e.select, scope, true, e.pos);
        return { k: 'scalar', sub, type: sub.type };
      }
      case 'case': {
        let operand = e.operand ? this.bindExpr(e.operand, scope, ctx) : undefined;
        const whens = e.whens.map((w) => {
          let when = this.bindExpr(w.when, scope, ctx);
          if (operand) {
            const pair = this.coercePair(operand, when, w.when.pos);
            when = pair[1];
          } else this.expectBool(when, w.when.pos, 'CASE WHEN');
          return { when, then: this.bindExpr(w.then, scope, ctx) };
        });
        const els = e.else ? this.bindExpr(e.else, scope, ctx) : undefined;
        let type: DataType = 'NULL';
        for (const w of whens) type = unifyTypes(type, w.then.type);
        if (els) type = unifyTypes(type, els.type);
        if (type === 'NULL') type = 'ANY';
        void operand;
        return { k: 'case', operand, whens, else: els, type };
      }
      case 'cast': {
        const arg = this.bindExpr(e.expr, scope, ctx);
        if (arg.k === 'const') return { k: 'const', value: castValue(arg.value, e.to, arg.type), type: e.to };
        return { k: 'cast', arg, type: e.to };
      }
      case 'function':
        return this.bindFunction(e, scope, ctx);
    }
  }

  private bindFunction(e: A.FunctionExpr, scope: Scope, ctx: ExprContext): BExpr {
    const name = e.name;
    if (e.over) return this.bindWindow(e, scope, ctx);
    if (WINDOW_FUNCTIONS.has(name)) throw new OpusError(ErrorCode.syntax, `${name.toLowerCase()}() may only be used as a window function (missing OVER)`, e.pos);
    const isAgg = e.star ? name === 'COUNT' : isAggregateName(name, e.args.length);
    if (isAgg) {
      if (!ctx.agg) {
        throw new OpusError(ErrorCode.groupingError, `aggregate function ${name.toLowerCase()}() is not allowed in ${ctx.clause}`, e.pos);
      }
      const def = AGGREGATE_FUNCTIONS[name];
      const argc = e.star ? 0 : e.args.length;
      if (!e.star && (argc < def.min || argc > def.max)) {
        throw new OpusError(ErrorCode.undefinedFunction, `wrong number of arguments to function ${name.toLowerCase()}()`, e.pos);
      }
      const inner: ExprContext = { clause: `aggregate ${name.toLowerCase()}()` };
      const args = e.star ? [] : e.args.map((a) => {
        if (containsAggregate(a)) throw new OpusError(ErrorCode.groupingError, 'aggregate function calls cannot be nested', a.pos);
        return this.bindExpr(a, ctx.agg!.inputScope, inner);
      });
      const filter = e.filter ? this.bindExpr(e.filter, ctx.agg.inputScope, inner) : undefined;
      const orderBy = e.orderBy?.map((o) => this.sortKey(this.bindExpr(o.expr, ctx.agg!.inputScope, inner), o));
      const key = `${name}|${e.distinct}|${e.star}|${args.map(exprKey).join(',')}|${filter ? exprKey(filter) : ''}|${orderBy ? orderBy.map((o) => exprKey(o.expr) + o.desc).join(',') : ''}`;
      let spec = ctx.agg.byKey.get(key);
      if (!spec) {
        spec = {
          name,
          args,
          distinct: e.distinct,
          star: e.star,
          filter,
          orderBy,
          outId: this.newId(),
          type: def.type(args.map((a) => a.type)),
        };
        if (spec.type === 'NULL') spec.type = 'ANY';
        ctx.agg.byKey.set(key, spec);
        ctx.agg.specs.push(spec);
      }
      return { k: 'col', id: spec.outId, type: spec.type, name: name.toLowerCase() };
    }
    const fn = SCALAR_FUNCTIONS[name];
    if (!fn) throw new OpusError(ErrorCode.undefinedFunction, `no such function: ${name.toLowerCase()}`, e.pos);
    if (e.star || e.distinct) throw new OpusError(ErrorCode.syntax, `${name.toLowerCase()}() is not an aggregate function`, e.pos);
    if (e.args.length < fn.min || e.args.length > fn.max) {
      throw new OpusError(ErrorCode.undefinedFunction, `wrong number of arguments to function ${name.toLowerCase()}()`, e.pos);
    }
    const args = e.args.map((a) => this.bindExpr(a, scope, ctx));
    let type = fn.type(args.map((a) => a.type));
    if (type === 'NULL') type = 'ANY';
    return { k: 'func', name, args, type };
  }

  private bindWindow(e: A.FunctionExpr, scope: Scope, ctx: ExprContext): BExpr {
    if (!ctx.win) throw new OpusError(ErrorCode.syntax, `window function ${e.name.toLowerCase()}() is not allowed in ${ctx.clause}`, e.pos);
    let spec = e.over!;
    const ref = (spec as A.WindowSpec & { ref?: string }).ref;
    if (ref) {
      const base = ctx.win.named?.get(ref);
      if (!base) throw new OpusError(ErrorCode.syntax, `no such window: ${ref}`, e.pos);
      spec = {
        partitionBy: spec.partitionBy.length ? spec.partitionBy : base.partitionBy,
        orderBy: spec.orderBy.length ? spec.orderBy : base.orderBy,
        frame: spec.frame ?? base.frame,
      };
    }
    const name = e.name;
    const isWinFn = WINDOW_FUNCTIONS.has(name);
    const isAgg = e.star ? name === 'COUNT' : isAggregateName(name, e.args.length);
    if (!isWinFn && !isAgg) throw new OpusError(ErrorCode.undefinedFunction, `${name.toLowerCase()}() is not a window function`, e.pos);
    const inner: ExprContext = { agg: ctx.agg, clause: 'window function' };
    const args = e.star ? [] : e.args.map((a) => this.bindExpr(a, scope, inner));
    const partitionBy = spec.partitionBy.map((p) => this.bindExpr(p, scope, inner));
    const orderBy = spec.orderBy.map((o) => this.sortKey(this.bindExpr(o.expr, scope, inner), o));
    const filter = e.filter ? this.bindExpr(e.filter, scope, inner) : undefined;
    let type: DataType;
    switch (name) {
      case 'ROW_NUMBER':
      case 'RANK':
      case 'DENSE_RANK':
      case 'NTILE':
        type = 'INTEGER';
        break;
      case 'PERCENT_RANK':
      case 'CUME_DIST':
        type = 'REAL';
        break;
      case 'LAG':
      case 'LEAD':
      case 'FIRST_VALUE':
      case 'LAST_VALUE':
      case 'NTH_VALUE':
        if (args.length === 0) throw new OpusError(ErrorCode.undefinedFunction, `${name.toLowerCase()}() requires an argument`, e.pos);
        type = args[0].type === 'NULL' ? 'ANY' : args[0].type;
        if ((name === 'LAG' || name === 'LEAD') && args[2]) type = unifyTypes(type, args[2].type);
        break;
      default:
        type = AGGREGATE_FUNCTIONS[name].type(args.map((a) => a.type));
    }
    if (name === 'NTILE' && args.length !== 1) throw new OpusError(ErrorCode.undefinedFunction, 'ntile() requires one argument', e.pos);
    const w: WindowFuncSpec = {
      name,
      args,
      partitionBy,
      orderBy,
      frame: spec.frame ? { mode: spec.frame.mode, start: spec.frame.start, end: spec.frame.end } : undefined,
      distinct: e.distinct,
      filter,
      outId: this.newId(),
      type: type === 'NULL' ? 'ANY' : type,
    };
    ctx.win.specs.push(w);
    return { k: 'col', id: w.outId, type: w.type, name: name.toLowerCase() };
  }

  // ------------------------------------------------------------------ DML

  private tableScope(table: TableSchema, alias: string | undefined, outer?: Scope): { entries: ScopeEntry[]; ids: number[] } {
    const a = (alias ?? table.name).toLowerCase();
    const ids: number[] = [];
    const entries: ScopeEntry[] = table.columns.map((c) => {
      const id = this.newId();
      ids.push(id);
      return { table: a, name: c.name, lname: c.name.toLowerCase(), id, type: c.type };
    });
    const rid = this.newId();
    ids.push(rid);
    entries.push({ table: a, name: 'rowid', lname: 'rowid', id: rid, type: 'INTEGER', rowid: true });
    void outer;
    return { entries, ids };
  }

  private bindReturning(items: A.ResultColumn[] | undefined, table: TableSchema, alias: string | undefined): BoundInsert['returning'] {
    if (!items) return undefined;
    const { entries, ids } = this.tableScope(table, alias);
    const scope = new Scope(entries);
    const exprs: BExpr[] = [];
    const cols: ColInfo[] = [];
    for (const rc of items) {
      if (rc.expr.type === 'star') {
        for (const e of entries) {
          if (e.rowid) continue;
          exprs.push({ k: 'col', id: e.id, type: e.type, name: e.name });
          cols.push({ id: this.newId(), name: e.name, type: e.type });
        }
        continue;
      }
      const b = this.bindExpr(rc.expr, scope, { clause: 'RETURNING' });
      exprs.push(b);
      cols.push({ id: this.newId(), name: rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : rc.text), type: b.type });
    }
    return { exprs, cols, rowIds: ids };
  }

  private bindInsert(stmt: A.InsertStmt): BoundInsert {
    if (this.catalog.views.has(stmt.table.toLowerCase())) throw new OpusError(ErrorCode.featureNotSupported, `cannot modify ${stmt.table} because it is a view`, stmt.pos);
    const table = this.catalog.getTable(stmt.table, stmt.pos);
    let targets: number[];
    if (stmt.columns) {
      const seen = new Set<number>();
      targets = stmt.columns.map((name) => {
        const i = table.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
        if (i < 0) {
          if (['rowid', 'oid', '_rowid_'].includes(name.toLowerCase()) && table.rowidCol < 0) return -1;
          throw new OpusError(ErrorCode.undefinedColumn, `table ${table.name} has no column named ${name}`, stmt.pos);
        }
        if (seen.has(i)) throw new OpusError(ErrorCode.duplicateColumn, `column ${name} specified more than once`, stmt.pos);
        seen.add(i);
        return i;
      });
    } else targets = table.columns.map((_, i) => i);

    let source: LNode | 'DEFAULT';
    if (stmt.source === 'DEFAULT') source = 'DEFAULT';
    else {
      const r = this.bindSelect(stmt.source, undefined);
      if (r.cols.length !== targets.length) {
        throw new OpusError(ErrorCode.syntax, `table ${table.name} has ${targets.length} columns but ${r.cols.length} values were supplied`, stmt.pos);
      }
      source = r.plan;
    }
    const bound: BoundInsert = { kind: 'insert', table, targets, source, conflict: stmt.conflict };
    if (stmt.upsert) {
      const existing = this.tableScope(table, undefined);
      const excluded = this.tableScope(table, 'excluded');
      let index: IndexSchemaOrRowid | undefined;
      if (stmt.upsert.target) {
        const cols = stmt.upsert.target.map((n) => {
          const i = table.columns.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
          if (i < 0) throw new OpusError(ErrorCode.undefinedColumn, `no such column: ${n}`, stmt.pos);
          return i;
        });
        if (cols.length === 1 && cols[0] === table.rowidCol) index = 'rowid';
        else {
          index = table.indexes.find((ix) => ix.unique && ix.columns.length === cols.length && ix.columns.every((c) => cols.includes(c)));
          if (!index) throw new OpusError(ErrorCode.syntax, 'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint', stmt.pos);
        }
      }
      const action = stmt.upsert.action;
      if (action === 'NOTHING') {
        bound.upsert = { index, action: 'NOTHING', existingIds: existing.ids, excludedIds: excluded.ids };
      } else {
        const scope = new Scope([...existing.entries, ...excluded.entries]);
        const sets = action.set.map((s) => ({ col: this.columnIndex(table, s.column, s.pos), expr: this.bindExpr(s.value, scope, { clause: 'SET' }) }));
        const where = action.where ? this.bindExpr(action.where, scope, { clause: 'WHERE' }) : undefined;
        bound.upsert = { index, action: { sets, where }, existingIds: existing.ids, excludedIds: excluded.ids };
      }
    }
    bound.returning = this.bindReturning(stmt.returning, table, undefined);
    return bound;
  }

  private columnIndex(table: TableSchema, name: string, pos: number): number {
    const i = table.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new OpusError(ErrorCode.undefinedColumn, `no such column: ${name}`, pos);
    return i;
  }

  private bindUpdate(stmt: A.UpdateStmt): BoundUpdate {
    if (this.catalog.views.has(stmt.table.toLowerCase())) throw new OpusError(ErrorCode.featureNotSupported, `cannot modify ${stmt.table} because it is a view`, stmt.pos);
    const table = this.catalog.getTable(stmt.table, stmt.pos);
    const scan = this.scanOf(table, stmt.alias ?? table.name);
    let plan: LNode = scan.plan;
    let entries = scan.entries;
    if (stmt.from) {
      const f = this.bindFrom(stmt.from, undefined);
      plan = { op: 'join', kind: 'inner', left: plan, right: f.plan, cols: [...plan.cols, ...f.plan.cols] };
      entries = [...entries, ...f.entries];
    }
    const scope = new Scope(entries);
    if (stmt.where) {
      const pred = this.bindExpr(stmt.where, scope, { clause: 'WHERE' });
      this.expectBool(pred, stmt.where.pos, 'WHERE');
      plan = { op: 'filter', input: plan, pred, cols: plan.cols };
    }
    const seen = new Set<number>();
    const sets = stmt.set.map((s) => {
      const col = this.columnIndex(table, s.column, s.pos);
      if (seen.has(col)) throw new OpusError(ErrorCode.duplicateColumn, `column ${s.column} assigned more than once`, s.pos);
      seen.add(col);
      return { col, expr: this.bindExpr(s.value, scope, { clause: 'SET' }) };
    });
    return { kind: 'update', table, source: plan, rowIds: scan.plan.cols.map((c) => c.id), sets, returning: this.bindReturning(stmt.returning, table, stmt.alias) };
  }

  private bindDelete(stmt: A.DeleteStmt): BoundDelete {
    if (this.catalog.views.has(stmt.table.toLowerCase())) throw new OpusError(ErrorCode.featureNotSupported, `cannot modify ${stmt.table} because it is a view`, stmt.pos);
    const table = this.catalog.getTable(stmt.table, stmt.pos);
    const scan = this.scanOf(table, stmt.alias ?? table.name);
    let plan: LNode = scan.plan;
    if (stmt.where) {
      const pred = this.bindExpr(stmt.where, new Scope(scan.entries), { clause: 'WHERE' });
      this.expectBool(pred, stmt.where.pos, 'WHERE');
      plan = { op: 'filter', input: plan, pred, cols: plan.cols };
    }
    return {
      kind: 'delete',
      table,
      source: plan,
      rowIds: scan.plan.cols.map((c) => c.id),
      all: !stmt.where,
      returning: this.bindReturning(stmt.returning, table, stmt.alias),
    };
  }

  /** Binds a standalone expression over a table's columns (CHECK constraints, DEFAULTs). */
  bindTableExpr(e: A.Expr, table: TableSchema, clause: string): { expr: BExpr; ids: number[] } {
    const { entries, ids } = this.tableScope(table, undefined);
    return { expr: this.bindExpr(e, new Scope(entries), { clause }), ids };
  }
}

type IndexSchemaOrRowid = NonNullable<BoundInsert['upsert']>['index'];

function toBoolConst(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  return (toNumber(v) ?? 0) !== 0;
}

function referencesTable(body: A.SelectBody, name: string): boolean {
  const target = name.toLowerCase();
  let found = false;
  const visit = (x: unknown): void => {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const v of x) visit(v);
      return;
    }
    const o = x as Record<string, unknown>;
    if (o.type === 'table' && typeof o.name === 'string' && o.name.toLowerCase() === target) {
      found = true;
      return;
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(body);
  return found;
}

/** All column ids referenced by expressions anywhere in a plan (including nested subplans). */
export function planRefIds(plan: LNode, out: Set<number> = new Set()): Set<number> {
  const add = (e: BExpr | undefined) => {
    if (e) refIds(e, out);
  };
  switch (plan.op) {
    case 'scan':
    case 'worktable':
      break;
    case 'values':
      plan.rows.forEach((r) => r.forEach(add));
      break;
    case 'series':
      plan.args.forEach(add);
      break;
    case 'filter':
      add(plan.pred);
      planRefIds(plan.input, out);
      break;
    case 'project':
      plan.exprs.forEach(add);
      planRefIds(plan.input, out);
      break;
    case 'join':
      add(plan.cond);
      planRefIds(plan.left, out);
      planRefIds(plan.right, out);
      break;
    case 'aggregate':
      plan.groups.forEach(add);
      for (const a of plan.aggs) {
        a.args.forEach(add);
        add(a.filter);
        a.orderBy?.forEach((o) => add(o.expr));
      }
      planRefIds(plan.input, out);
      break;
    case 'window':
      for (const w of plan.funcs) {
        w.args.forEach(add);
        w.partitionBy.forEach(add);
        w.orderBy.forEach((o) => add(o.expr));
        add(w.filter);
      }
      planRefIds(plan.input, out);
      break;
    case 'sort':
      plan.keys.forEach((k) => add(k.expr));
      planRefIds(plan.input, out);
      break;
    case 'limit':
      add(plan.limit);
      add(plan.offset);
      planRefIds(plan.input, out);
      break;
    case 'distinct':
      planRefIds(plan.input, out);
      break;
    case 'setop':
      planRefIds(plan.left, out);
      planRefIds(plan.right, out);
      break;
    case 'recursive':
      planRefIds(plan.anchor, out);
      planRefIds(plan.recursive, out);
      break;
  }
  return out;
}

export { exprToSql, children };
