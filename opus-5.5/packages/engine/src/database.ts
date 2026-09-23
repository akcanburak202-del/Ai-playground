import type { DataType, Row, Value } from './types.ts';
import { ErrorCode, OpusError, hashKey, tupleKey } from './types.ts';
import type * as A from './sql/ast.ts';
import { parse } from './sql/parser.ts';
import { Catalog } from './catalog.ts';
import type { TableSchema } from './catalog.ts';
import { MemoryStorage } from './storage/file.ts';
import type { StorageProvider } from './storage/file.ts';
import { Pager } from './storage/pager.ts';
import type { PagerOptions } from './storage/pager.ts';
import type { TreeEvent } from './storage/btree.ts';
import { decodeRecord } from './storage/codec.ts';
import { Binder } from './plan/binder.ts';
import { Planner } from './plan/planner.ts';
import { ExecContext } from './exec/context.ts';
import { instrument } from './exec/operators.ts';
import type { Operator } from './exec/operators.ts';
import { DeleteOp, InsertOp, UpdateOp } from './exec/dml.ts';
import { Inspector } from './inspect.ts';

export interface DatabaseOptions extends PagerOptions {
  storage?: StorageProvider;
  /** B+tree teaching mode: split nodes above this many keys (for visualisation). */
  btreeMaxKeys?: number;
  /** Default per-statement time limit in milliseconds. */
  timeoutMs?: number;
}

export interface ColumnMeta {
  name: string;
  type: DataType;
}

export interface PlanNode {
  name: string;
  details: string[];
  estRows: number;
  cost: number;
  actual?: { rows: number; loops: number; timeMs: number; selfMs: number };
  children: PlanNode[];
}

export interface QueryResult {
  /** Command tag, e.g. SELECT, INSERT, CREATE TABLE. */
  command: string;
  columns: ColumnMeta[];
  rows: Value[][];
  rowsAffected: number;
  lastInsertRowid?: number;
  plan?: PlanNode;
  timeMs: number;
  sql: string;
}

export type DatabaseEvent =
  | { type: 'commit'; framesWritten: number; walFrames: number }
  | { type: 'rollback' }
  | { type: 'checkpoint'; pages: number }
  | { type: 'schema' }
  | { type: 'tree'; name: string; event: TreeEvent };

export type Params = Value[] | Record<string, Value>;

interface CompiledStatement {
  kind: 'select' | 'insert' | 'update' | 'delete';
  op: Operator;
  ctx: ExecContext;
  columns: ColumnMeta[];
  cookie: number;
}

const COMMANDS: Record<string, string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  create_table: 'CREATE TABLE',
  create_index: 'CREATE INDEX',
  create_view: 'CREATE VIEW',
  alter_table: 'ALTER TABLE',
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  explain: 'EXPLAIN',
  checkpoint: 'CHECKPOINT',
  vacuum: 'VACUUM',
  analyze: 'ANALYZE',
};

function resolveParams(params: Params | undefined, parsed: A.ParsedStatement): Value[] {
  if (!params) return [];
  if (Array.isArray(params)) return params;
  const out: Value[] = [];
  for (let i = 0; i < parsed.paramCount; i++) {
    const name = parsed.paramNames[i];
    if (name === undefined || !(name in params)) {
      throw new OpusError(ErrorCode.invalidParameter, `missing value for parameter ${name ? ':' + name : i + 1}`);
    }
    out.push(params[name]);
  }
  return out;
}

/**
 * A database: one pager + catalog, shared by any number of sessions.
 * Transactions are serialised with a database-wide lock (one writer or
 * explicit transaction at a time); each statement is atomic.
 */
export class Database {
  readonly pager: Pager;
  readonly catalog: Catalog;
  readonly options: DatabaseOptions;
  readonly inspect: Inspector;
  lockOwner: Session | null = null;
  private readonly listeners = new Set<(e: DatabaseEvent) => void>();
  private readonly defaultSession: Session;
  private closed = false;

  constructor(opts: DatabaseOptions = {}) {
    this.options = opts;
    this.pager = new Pager(opts.storage ?? new MemoryStorage(), opts);
    this.catalog = new Catalog(this.pager);
    this.catalog.treeOptions = { maxKeys: opts.btreeMaxKeys };
    this.catalog.onTreeEvent = (name, event) => {
      if (this.listeners.size) this.emit({ type: 'tree', name, event });
    };
    if (this.pager.isNew || this.pager.header.catalogRoot === 0) {
      this.catalog.initialize();
      this.pager.commit();
    }
    this.catalog.load();
    this.inspect = new Inspector(this);
    this.defaultSession = new Session(this);
  }

  static open(opts: DatabaseOptions = {}): Database {
    return new Database(opts);
  }

  on(listener: (e: DatabaseEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(e: DatabaseEvent): void {
    for (const l of this.listeners) l(e);
  }

  session(): Session {
    this.assertOpen();
    return new Session(this);
  }

  exec(sql: string, params?: Params): QueryResult[] {
    return this.defaultSession.exec(sql, params);
  }

  query(sql: string, params?: Params): QueryResult {
    return this.defaultSession.query(sql, params);
  }

  prepare(sql: string): PreparedStatement {
    return this.defaultSession.prepare(sql);
  }

  get inTransaction(): boolean {
    return this.defaultSession.inTransaction;
  }

  checkpoint(): number {
    if (this.lockOwner) throw new OpusError(ErrorCode.activeTransaction, 'cannot checkpoint while a transaction is active');
    const pages = this.pager.checkpoint();
    this.emit({ type: 'checkpoint', pages });
    return pages;
  }

  assertOpen(): void {
    if (this.closed) throw new OpusError(ErrorCode.internal, 'database is closed');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lockOwner = null;
    this.pager.close();
  }
}

export class Session {
  readonly db: Database;
  inTransaction = false;
  timeoutMs: number | undefined;
  /** Set to true to abort the statement that is currently running. */
  private currentCtx: ExecContext | null = null;

  constructor(db: Database) {
    this.db = db;
    this.timeoutMs = db.options.timeoutMs;
  }

  interrupt(): void {
    if (this.currentCtx) this.currentCtx.interrupted = true;
  }

  exec(sql: string, params?: Params): QueryResult[] {
    this.db.assertOpen();
    const stmts = parse(sql);
    const results: QueryResult[] = [];
    for (const p of stmts) {
      try {
        results.push(this.run(p, resolveParams(params, p)));
      } catch (e) {
        if (e instanceof OpusError && e.position !== undefined && e.position < p.start) e.position += p.start;
        throw e;
      }
    }
    return results;
  }

  query(sql: string, params?: Params): QueryResult {
    const results = this.exec(sql, params);
    if (results.length === 0) throw new OpusError(ErrorCode.syntax, 'empty query');
    return results[results.length - 1];
  }

  prepare(sql: string): PreparedStatement {
    const stmts = parse(sql);
    if (stmts.length !== 1) throw new OpusError(ErrorCode.syntax, `prepare expects exactly one statement, got ${stmts.length}`);
    return new PreparedStatement(this, stmts[0]);
  }

  /** Rolls back any open transaction and releases the database lock. */
  close(): void {
    if (this.inTransaction) {
      this.db.pager.rollback();
      this.db.catalog.refresh();
      this.inTransaction = false;
    }
    if (this.db.lockOwner === this) this.db.lockOwner = null;
  }

  // ------------------------------------------------------------------ locking

  private acquire(): void {
    const owner = this.db.lockOwner;
    if (owner && owner !== this) throw new OpusError(ErrorCode.lockNotAvailable, 'database is locked by another session');
    this.db.lockOwner = this;
  }

  private release(): void {
    if (this.db.lockOwner === this && !this.inTransaction) this.db.lockOwner = null;
  }

  // ------------------------------------------------------------------ execution

  private result(command: string, sql: string, t0: number, extra: Partial<QueryResult> = {}): QueryResult {
    return { command, columns: [], rows: [], rowsAffected: 0, timeMs: performance.now() - t0, sql, ...extra };
  }

  /** Runs `fn` as one atomic statement (auto-committed unless inside BEGIN). */
  private atomic<T>(fn: () => T): T {
    const { pager, catalog } = this.db;
    this.acquire();
    const autocommit = !this.inTransaction;
    pager.beginStatement();
    try {
      const out = fn();
      pager.endStatement();
      if (autocommit) this.commitNow();
      return out;
    } catch (e) {
      if (autocommit) {
        pager.rollback();
        this.db.emit({ type: 'rollback' });
      } else pager.rollbackStatement();
      catalog.refresh();
      throw e;
    } finally {
      if (autocommit) this.release();
    }
  }

  private commitNow(): void {
    const { pager } = this.db;
    if (!pager.hasChanges) return;
    const before = pager.stats.framesWritten;
    const cookie = pager.header.schemaCookie;
    const committedCookie = this.db.catalog.cookie;
    pager.commit();
    this.db.emit({ type: 'commit', framesWritten: pager.stats.framesWritten - before, walFrames: pager.walInfo().frames });
    if (cookie !== committedCookie) this.db.emit({ type: 'schema' });
  }

  run(p: A.ParsedStatement, params: Value[]): QueryResult {
    const t0 = performance.now();
    const stmt = p.stmt;
    const { pager, catalog } = this.db;
    const command = COMMANDS[stmt.type] ?? `${stmt.type.toUpperCase()}`;
    switch (stmt.type) {
      case 'begin':
        if (this.inTransaction) throw new OpusError(ErrorCode.activeTransaction, 'cannot start a transaction within a transaction', stmt.pos);
        this.acquire();
        this.inTransaction = true;
        return this.result(command, p.text, t0);
      case 'commit': {
        if (!this.inTransaction) throw new OpusError(ErrorCode.noActiveTransaction, 'cannot commit - no transaction is active', stmt.pos);
        const schemaChanged = catalog.cookie !== pager.header.schemaCookie;
        this.inTransaction = false;
        try {
          this.commitNow();
        } finally {
          this.release();
        }
        if (schemaChanged) this.db.emit({ type: 'schema' });
        return this.result(command, p.text, t0);
      }
      case 'rollback':
        if (!this.inTransaction) throw new OpusError(ErrorCode.noActiveTransaction, 'cannot rollback - no transaction is active', stmt.pos);
        pager.rollback();
        catalog.refresh();
        this.inTransaction = false;
        this.release();
        this.db.emit({ type: 'rollback' });
        return this.result(command, p.text, t0);
      case 'checkpoint': {
        if (this.inTransaction) throw new OpusError(ErrorCode.activeTransaction, 'cannot checkpoint inside a transaction', stmt.pos);
        this.acquire();
        try {
          const pages = this.db.checkpoint();
          return this.result(command, p.text, t0, { rowsAffected: pages });
        } finally {
          this.release();
        }
      }
      case 'explain':
        return this.explain(stmt, p, params, t0);
      case 'select':
      case 'insert':
      case 'update':
      case 'delete': {
        const compiled = this.compile(stmt);
        return this.runCompiled(compiled, params, p.text, t0, false);
      }
      default:
        return this.atomic(() => this.ddl(stmt, p, t0));
    }
  }

  compile(stmt: A.Statement): CompiledStatement {
    const { catalog } = this.db;
    catalog.refresh();
    const binder = new Binder(catalog);
    const ctx = new ExecContext();
    const bound = binder.bindStatement(stmt);
    const planner = new Planner({ catalog, ctx, binder });
    switch (bound.kind) {
      case 'select':
        return { kind: 'select', op: planner.planQuery(bound.plan), ctx, columns: bound.cols.map((c) => ({ name: c.name, type: c.type })), cookie: catalog.cookie };
      case 'insert':
        return { kind: 'insert', op: planner.planInsert(bound), ctx, columns: bound.returning?.cols.map((c) => ({ name: c.name, type: c.type })) ?? [], cookie: catalog.cookie };
      case 'update':
        return { kind: 'update', op: planner.planUpdate(bound), ctx, columns: bound.returning?.cols.map((c) => ({ name: c.name, type: c.type })) ?? [], cookie: catalog.cookie };
      case 'delete':
        return { kind: 'delete', op: planner.planDelete(bound), ctx, columns: bound.returning?.cols.map((c) => ({ name: c.name, type: c.type })) ?? [], cookie: catalog.cookie };
    }
  }

  runCompiled(c: CompiledStatement, params: Value[], sql: string, t0: number, analyze: boolean): QueryResult {
    const exec = () => {
      c.ctx.begin(params, this.timeoutMs);
      this.currentCtx = c.ctx;
      const rows: Row[] = [];
      try {
        const op = c.op;
        op.open();
        for (let r = op.next(); r; r = op.next()) rows.push(r);
        op.close();
      } finally {
        this.currentCtx = null;
      }
      return rows;
    };
    // read-only statements outside a transaction skip statement bookkeeping
    const rows = c.kind === 'select' && !this.inTransaction && !this.db.lockOwner ? exec() : this.atomic(exec);
    const res = this.result(COMMANDS[c.kind], sql, t0, { columns: c.columns, rows });
    const op = c.op;
    if (op instanceof InsertOp) {
      res.rowsAffected = op.rowsAffected;
      res.lastInsertRowid = op.lastInsertRowid;
    } else if (op instanceof UpdateOp || op instanceof DeleteOp) res.rowsAffected = op.rowsAffected;
    else res.rowsAffected = rows.length;
    void analyze;
    return res;
  }

  private explain(stmt: A.ExplainStmt, p: A.ParsedStatement, params: Value[], t0: number): QueryResult {
    const inner = stmt.stmt;
    if (inner.type !== 'select' && inner.type !== 'insert' && inner.type !== 'update' && inner.type !== 'delete') {
      throw new OpusError(ErrorCode.featureNotSupported, 'EXPLAIN supports SELECT, INSERT, UPDATE and DELETE', stmt.pos);
    }
    const compiled = this.compile(inner);
    if (stmt.analyze) {
      instrument(compiled.op);
      this.runCompiled(compiled, params, p.text, performance.now(), true);
    }
    const plan = toPlanNode(compiled.op, stmt.analyze);
    const lines = renderPlan(plan);
    return this.result('EXPLAIN', p.text, t0, { columns: [{ name: 'QUERY PLAN', type: 'TEXT' }], rows: lines.map((l) => [l]), plan });
  }

  private ddl(stmt: A.Statement, p: A.ParsedStatement, t0: number): QueryResult {
    const { catalog } = this.db;
    const command = COMMANDS[stmt.type] ?? stmt.type.toUpperCase();
    switch (stmt.type) {
      case 'create_table': {
        if (stmt.as) {
          if (catalog.tables.has(stmt.name.toLowerCase())) {
            if (stmt.ifNotExists) return this.result(command, p.text, t0);
          }
          const compiled = this.compile(stmt.as);
          const def: A.CreateTableStmt = {
            ...stmt,
            as: undefined,
            columns: compiled.columns.map((c) => ({
              name: c.name,
              typeName: c.type === 'ANY' || c.type === 'NULL' ? '' : c.type,
              dataType: c.type === 'NULL' ? 'ANY' : c.type,
              notNull: false,
              primaryKey: false,
              primaryKeyDesc: false,
              autoincrement: false,
              unique: false,
              pos: stmt.pos,
            })),
          };
          const table = catalog.createTable(def);
          if (!table) return this.result(command, p.text, t0);
          const rows = (() => {
            compiled.ctx.begin([]);
            const out: Row[] = [];
            compiled.op.open();
            for (let r = compiled.op.next(); r; r = compiled.op.next()) out.push(r);
            compiled.op.close();
            return out;
          })();
          const planner = new Planner({ catalog, ctx: new ExecContext(), binder: new Binder(catalog) });
          const h = planner.handle(table);
          for (const r of rows) {
            const rowid = h.resolveRowid(r, undefined);
            h.insertRow(h.prepareRow(r, rowid));
          }
          return this.result('SELECT', p.text, t0, { rowsAffected: rows.length });
        }
        catalog.createTable(stmt);
        return this.result(command, p.text, t0);
      }
      case 'create_index':
        catalog.createIndex(stmt);
        return this.result(command, p.text, t0);
      case 'create_view': {
        // validate the view body before storing it
        new Binder(catalog).bindSelect(stmt.select, undefined);
        catalog.createView(stmt);
        return this.result(command, p.text, t0);
      }
      case 'drop':
        catalog.drop(stmt);
        return this.result(`DROP ${stmt.kind}`, p.text, t0);
      case 'alter_table':
        catalog.alterTable(stmt);
        return this.result(command, p.text, t0);
      case 'analyze': {
        const tables = stmt.target ? [catalog.getTable(stmt.target, stmt.pos)] : [...catalog.tables.values()];
        for (const t of tables) analyzeTable(catalog, t);
        return this.result(command, p.text, t0, { rowsAffected: tables.length });
      }
      case 'vacuum':
        return this.result(command, p.text, t0);
      default:
        throw new OpusError(ErrorCode.featureNotSupported, `unsupported statement ${stmt.type}`, stmt.pos);
    }
  }
}

function analyzeTable(catalog: Catalog, t: TableSchema): void {
  const tree = catalog.tableTree(t);
  const sets = t.columns.map(() => new Set<unknown>());
  let rows = 0;
  const c = tree.cursor();
  for (let ok = c.first(); ok; ok = c.next()) {
    const r = decodeRecord(c.payload());
    rows++;
    for (let i = 0; i < sets.length; i++) sets[i].add(hashKey(r[i] ?? null));
  }
  t.stats = { rows, ndv: sets.map((s) => Math.max(1, s.size)) };
}

/** A parsed statement whose physical plan is cached until the schema changes. */
export class PreparedStatement {
  readonly session: Session;
  readonly parsed: A.ParsedStatement;
  private cached: CompiledStatement | null = null;

  constructor(session: Session, parsed: A.ParsedStatement) {
    this.session = session;
    this.parsed = parsed;
  }

  get paramCount(): number {
    return this.parsed.paramCount;
  }

  run(params?: Params): QueryResult {
    const stmt = this.parsed.stmt;
    const values = resolveParams(params, this.parsed);
    if (stmt.type !== 'select' && stmt.type !== 'insert' && stmt.type !== 'update' && stmt.type !== 'delete') {
      return this.session.run(this.parsed, values);
    }
    const db = this.session.db;
    db.assertOpen();
    db.catalog.refresh();
    if (!this.cached || this.cached.cookie !== db.catalog.cookie) this.cached = this.session.compile(stmt);
    return this.session.runCompiled(this.cached, values, this.parsed.text, performance.now(), false);
  }

  all(params?: Params): Value[][] {
    return this.run(params).rows;
  }

  get(params?: Params): Value[] | undefined {
    return this.run(params).rows[0];
  }

  /** Rows as objects keyed by column name. */
  objects(params?: Params): Record<string, Value>[] {
    const r = this.run(params);
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
  }
}

// ------------------------------------------------------------------ EXPLAIN rendering

export function toPlanNode(op: Operator, analyze: boolean): PlanNode {
  const children = op.children.map((c) => toPlanNode(c, analyze));
  const node: PlanNode = { name: op.name, details: op.details, estRows: Math.round(op.estRows), cost: Math.round(op.cost * 100) / 100, children };
  if (analyze) {
    const childTime = op.children.reduce((s, c) => s + c.statTime, 0);
    node.actual = {
      rows: op.statRows,
      loops: op.statLoops,
      timeMs: Math.round(op.statTime * 1000) / 1000,
      selfMs: Math.max(0, Math.round((op.statTime - childTime) * 1000) / 1000),
    };
  }
  return node;
}

export function renderPlan(plan: PlanNode): string[] {
  const lines: string[] = [];
  const visit = (n: PlanNode, prefix: string, detailPrefix: string) => {
    let head = `${n.name}  (rows=${n.estRows} cost=${n.cost})`;
    if (n.actual) head += ` (actual rows=${n.actual.rows} loops=${n.actual.loops} time=${n.actual.timeMs.toFixed(3)}ms)`;
    lines.push(prefix + head);
    for (const d of n.details) lines.push(detailPrefix + d);
    for (const c of n.children) visit(c, detailPrefix + '->  ', detailPrefix + '      ');
  };
  visit(plan, '', '  ');
  return lines;
}

export { tupleKey };
