import type * as A from './sql/ast.ts';
import { parse } from './sql/parser.ts';
import { exprToSql, quoteIdent } from './sql/printer.ts';
import type { DataType, Value } from './types.ts';
import { ErrorCode, OpusError } from './types.ts';
import type { Pager } from './storage/pager.ts';
import { BTree } from './storage/btree.ts';
import type { BTreeOptions, TreeEvent } from './storage/btree.ts';
import { decodeRecord, encodeRecord } from './storage/codec.ts';

/**
 * The system catalog lives in an ordinary table b-tree rooted at the page
 * recorded in the database header (like sqlite_schema). Each row is
 *
 *   (type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)
 *
 * and the in-memory schema is rebuilt by re-parsing the stored SQL.
 */

export interface ColumnSchema {
  name: string;
  type: DataType;
  typeName: string;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  default?: A.Expr;
  check?: A.Expr;
  references?: { table: string; column?: string };
}

export interface IndexSchema {
  name: string;
  table: string;
  columns: number[];
  desc: boolean[];
  unique: boolean;
  root: number;
  /** Created implicitly for a PRIMARY KEY / UNIQUE constraint. */
  auto: boolean;
  catalogRowid: number;
  tree?: BTree;
}

export interface TableStats {
  rows: number;
  /** Distinct values per column. */
  ndv: number[];
}

export interface TableSchema {
  kind: 'table';
  name: string;
  columns: ColumnSchema[];
  /** Index of the INTEGER PRIMARY KEY column that aliases the rowid, or -1. */
  rowidCol: number;
  pk: number[];
  autoincrement: boolean;
  root: number;
  indexes: IndexSchema[];
  checks: { expr: A.Expr; name: string }[];
  foreignKeys: { columns: number[]; table: string; refColumns?: string[] }[];
  catalogRowid: number;
  stats?: TableStats;
  tree?: BTree;
  /** Cached row count estimate (maintained incrementally, reset on rollback). */
  rowCount?: { epoch: number; value: number };
  nextRowid?: { epoch: number; value: number };
}

export interface ViewSchema {
  kind: 'view';
  name: string;
  columns?: string[];
  select: A.SelectStmt;
  sql: string;
  catalogRowid: number;
}

export const AUTOINDEX_PREFIX = 'opus_autoindex_';

function lower(s: string): string {
  return s.toLowerCase();
}

export class Catalog {
  readonly pager: Pager;
  readonly tables = new Map<string, TableSchema>();
  readonly views = new Map<string, ViewSchema>();
  readonly indexes = new Map<string, IndexSchema>();
  cookie = -1;
  private tree!: BTree;
  treeOptions: BTreeOptions = {};
  onTreeEvent?: (name: string, e: TreeEvent) => void;

  constructor(pager: Pager) {
    this.pager = pager;
  }

  /** Creates the catalog b-tree in a brand-new database. */
  initialize(): void {
    const root = BTree.create(this.pager, 'table');
    this.pager.setHeader({ catalogRoot: root, schemaCookie: 1 });
  }

  get catalogRoot(): number {
    return this.pager.header.catalogRoot;
  }

  treeFor(name: string, root: number, kind: 'table' | 'index', desc?: boolean[]): BTree {
    const onTreeEvent = this.onTreeEvent;
    return new BTree(this.pager, root, kind, {
      ...this.treeOptions,
      desc,
      observer: onTreeEvent ? (e) => onTreeEvent(name, e) : undefined,
    });
  }

  tableTree(t: TableSchema): BTree {
    return (t.tree ??= this.treeFor(t.name, t.root, 'table'));
  }

  indexTree(ix: IndexSchema): BTree {
    return (ix.tree ??= this.treeFor(ix.name, ix.root, 'index', ix.desc.some((d) => d) ? [...ix.desc, false] : undefined));
  }

  /** Re-reads the catalog if the schema cookie changed (after DDL or rollback). */
  refresh(): void {
    if (this.cookie === this.pager.header.schemaCookie) return;
    this.load();
  }

  load(): void {
    this.tables.clear();
    this.views.clear();
    this.indexes.clear();
    this.tree = new BTree(this.pager, this.catalogRoot, 'table');
    const rows: { rowid: number; type: string; name: string; tbl: string; root: number; sql: string }[] = [];
    const c = this.tree.cursor();
    for (let ok = c.first(); ok; ok = c.next()) {
      const [type, name, tbl, root, sql] = decodeRecord(c.payload()) as [string, string, string, number, string];
      rows.push({ rowid: c.rowid(), type, name, tbl, root, sql });
    }
    for (const r of rows) {
      if (r.type === 'table') {
        const stmt = parse(r.sql)[0].stmt as A.CreateTableStmt;
        const { schema } = buildTableSchema(stmt);
        schema.root = r.root;
        schema.catalogRowid = r.rowid;
        this.tables.set(lower(schema.name), schema);
      } else if (r.type === 'view') {
        const stmt = parse(r.sql)[0].stmt as A.CreateViewStmt;
        this.views.set(lower(r.name), { kind: 'view', name: stmt.name, columns: stmt.columns, select: stmt.select, sql: r.sql, catalogRowid: r.rowid });
      }
    }
    for (const r of rows) {
      if (r.type !== 'index') continue;
      const stmt = parse(r.sql)[0].stmt as A.CreateIndexStmt;
      const table = this.tables.get(lower(stmt.table));
      if (!table) throw new OpusError(ErrorCode.corrupt, `index ${r.name} refers to missing table ${stmt.table}`);
      const ix = indexFromStmt(stmt, table);
      ix.root = r.root;
      ix.catalogRowid = r.rowid;
      table.indexes.push(ix);
      this.indexes.set(lower(ix.name), ix);
    }
    this.cookie = this.pager.header.schemaCookie;
  }

  private bump(): void {
    const cookie = (this.pager.header.schemaCookie + 1) >>> 0;
    this.pager.setHeader({ schemaCookie: cookie });
    this.cookie = cookie;
  }

  private catalogInsert(type: string, name: string, tbl: string, root: number, sql: string): number {
    const last = this.tree.lastKey();
    const rowid = last === undefined ? 1 : (last as number) + 1;
    this.tree.insert(rowid, encodeRecord([type, name, tbl, root, sql]));
    return rowid;
  }

  private catalogUpdate(rowid: number, type: string, name: string, tbl: string, root: number, sql: string): void {
    this.tree.insert(rowid, encodeRecord([type, name, tbl, root, sql]), true);
  }

  getTable(name: string, pos?: number): TableSchema {
    const t = this.tables.get(lower(name));
    if (!t) throw new OpusError(ErrorCode.undefinedTable, `no such table: ${name}`, pos);
    return t;
  }

  private assertNameFree(name: string, pos: number): void {
    const n = lower(name);
    if (this.tables.has(n) || this.views.has(n) || this.indexes.has(n)) {
      throw new OpusError(ErrorCode.duplicateTable, `there is already an object named ${name}`, pos);
    }
  }

  // ------------------------------------------------------------------ DDL

  createTable(stmt: A.CreateTableStmt): TableSchema | null {
    if (this.tables.has(lower(stmt.name)) || this.views.has(lower(stmt.name))) {
      if (stmt.ifNotExists) return null;
      throw new OpusError(ErrorCode.duplicateTable, `table ${stmt.name} already exists`, stmt.pos);
    }
    this.assertNameFree(stmt.name, stmt.pos);
    const { schema, uniqueSets } = buildTableSchema(stmt);
    schema.root = BTree.create(this.pager, 'table');
    schema.catalogRowid = this.catalogInsert('table', schema.name, schema.name, schema.root, tableToSql(schema));
    this.tables.set(lower(schema.name), schema);
    let n = 0;
    for (const set of uniqueSets) {
      const name = `${AUTOINDEX_PREFIX}${schema.name}_${++n}`;
      this.createIndexInternal(schema, name, set.columns, set.columns.map(() => false), true, true);
    }
    this.bump();
    return schema;
  }

  createIndex(stmt: A.CreateIndexStmt): IndexSchema | null {
    if (this.indexes.has(lower(stmt.name))) {
      if (stmt.ifNotExists) return null;
      throw new OpusError(ErrorCode.duplicateObject, `index ${stmt.name} already exists`, stmt.pos);
    }
    this.assertNameFree(stmt.name, stmt.pos);
    const table = this.getTable(stmt.table, stmt.pos);
    const columns = stmt.columns.map((c) => {
      const i = table.columns.findIndex((col) => lower(col.name) === lower(c.name));
      if (i < 0) throw new OpusError(ErrorCode.undefinedColumn, `no such column: ${c.name}`, c.pos);
      return i;
    });
    const ix = this.createIndexInternal(table, stmt.name, columns, stmt.columns.map((c) => c.desc), stmt.unique, false);
    this.bump();
    return ix;
  }

  private createIndexInternal(table: TableSchema, name: string, columns: number[], desc: boolean[], unique: boolean, auto: boolean): IndexSchema {
    const ix: IndexSchema = { name, table: table.name, columns, desc, unique, root: BTree.create(this.pager, 'index'), auto, catalogRowid: 0 };
    ix.catalogRowid = this.catalogInsert('index', name, table.name, ix.root, indexToSql(ix, table));
    // populate from existing rows
    const tree = this.tableTree(table);
    const itree = this.indexTree(ix);
    const c = tree.cursor();
    for (let ok = c.first(); ok; ok = c.next()) {
      const row = decodeRecord(c.payload());
      const key: Value[] = columns.map((i) => (i < row.length ? row[i] : null));
      if (unique && !key.some((v) => v === null)) {
        const probe = itree.cursor();
        if (probe.seek(key) && itree.cmpPrefix(probe.key(), key) === 0) {
          throw new OpusError(ErrorCode.uniqueViolation, `could not create unique index "${name}": duplicate key (${columns.map((i) => table.columns[i].name).join(', ')})`);
        }
      }
      key.push(c.rowid());
      itree.insert(key);
    }
    table.indexes.push(ix);
    this.indexes.set(lower(name), ix);
    return ix;
  }

  createView(stmt: A.CreateViewStmt): void {
    if (this.views.has(lower(stmt.name))) {
      if (stmt.ifNotExists) return;
      throw new OpusError(ErrorCode.duplicateTable, `view ${stmt.name} already exists`, stmt.pos);
    }
    this.assertNameFree(stmt.name, stmt.pos);
    const cols = stmt.columns ? ` (${stmt.columns.map(quoteIdent).join(', ')})` : '';
    const sql = `CREATE VIEW ${quoteIdent(stmt.name)}${cols} AS ${stmt.selectText}`;
    const rowid = this.catalogInsert('view', stmt.name, stmt.name, 0, sql);
    this.views.set(lower(stmt.name), { kind: 'view', name: stmt.name, columns: stmt.columns, select: stmt.select, sql, catalogRowid: rowid });
    this.bump();
  }

  drop(stmt: A.DropStmt): boolean {
    const n = lower(stmt.name);
    if (stmt.kind === 'TABLE') {
      const t = this.tables.get(n);
      if (!t) {
        if (stmt.ifExists) return false;
        throw new OpusError(ErrorCode.undefinedTable, `no such table: ${stmt.name}`, stmt.pos);
      }
      for (const ix of t.indexes) {
        this.indexTree(ix).destroy();
        this.tree.delete(ix.catalogRowid);
        this.indexes.delete(lower(ix.name));
      }
      this.tableTree(t).destroy();
      this.tree.delete(t.catalogRowid);
      this.tables.delete(n);
    } else if (stmt.kind === 'INDEX') {
      const ix = this.indexes.get(n);
      if (!ix) {
        if (stmt.ifExists) return false;
        throw new OpusError(ErrorCode.undefinedTable, `no such index: ${stmt.name}`, stmt.pos);
      }
      if (ix.auto) throw new OpusError(ErrorCode.featureNotSupported, `index ${ix.name} is associated with a UNIQUE or PRIMARY KEY constraint and cannot be dropped`, stmt.pos);
      this.indexTree(ix).destroy();
      this.tree.delete(ix.catalogRowid);
      this.indexes.delete(n);
      const t = this.tables.get(lower(ix.table))!;
      t.indexes = t.indexes.filter((i) => i !== ix);
    } else {
      const v = this.views.get(n);
      if (!v) {
        if (stmt.ifExists) return false;
        throw new OpusError(ErrorCode.undefinedTable, `no such view: ${stmt.name}`, stmt.pos);
      }
      this.tree.delete(v.catalogRowid);
      this.views.delete(n);
    }
    this.bump();
    return true;
  }

  alterTable(stmt: A.AlterTableStmt): void {
    const t = this.getTable(stmt.table, stmt.pos);
    const action = stmt.action;
    if (action.kind === 'add_column') {
      const def = action.column;
      if (t.columns.some((c) => lower(c.name) === lower(def.name))) {
        throw new OpusError(ErrorCode.duplicateColumn, `duplicate column name: ${def.name}`, def.pos);
      }
      if (def.primaryKey || def.unique) throw new OpusError(ErrorCode.featureNotSupported, 'cannot add a PRIMARY KEY or UNIQUE column', def.pos);
      if (def.notNull && (!def.default || (def.default.type === 'literal' && def.default.value === null))) {
        throw new OpusError(ErrorCode.notNullViolation, 'cannot add a NOT NULL column with default value NULL', def.pos);
      }
      if (def.default && def.default.type !== 'literal') {
        throw new OpusError(ErrorCode.featureNotSupported, 'cannot add a column with non-constant default', def.pos);
      }
      t.columns.push(columnFromDef(def));
      if (def.check) t.checks.push({ expr: def.check, name: def.name });
    } else if (action.kind === 'rename_table') {
      const to = action.to;
      this.assertNameFree(to, stmt.pos);
      this.tables.delete(lower(t.name));
      t.name = to;
      this.tables.set(lower(to), t);
      t.tree = undefined;
      for (const ix of t.indexes) {
        ix.table = to;
        ix.tree = undefined;
        this.catalogUpdate(ix.catalogRowid, 'index', ix.name, to, ix.root, indexToSql(ix, t));
      }
    } else {
      const col = t.columns.find((c) => lower(c.name) === lower(action.from));
      if (!col) throw new OpusError(ErrorCode.undefinedColumn, `no such column: ${action.from}`, stmt.pos);
      if (t.columns.some((c) => lower(c.name) === lower(action.to))) {
        throw new OpusError(ErrorCode.duplicateColumn, `duplicate column name: ${action.to}`, stmt.pos);
      }
      const from = col.name;
      col.name = action.to;
      const rename = (e: A.Expr | undefined) => e && renameColumnRefs(e, from, action.to);
      for (const c of t.columns) {
        rename(c.check);
        rename(c.default);
      }
      for (const ch of t.checks) rename(ch.expr);
      for (const ix of t.indexes) this.catalogUpdate(ix.catalogRowid, 'index', ix.name, t.name, ix.root, indexToSql(ix, t));
    }
    this.catalogUpdate(t.catalogRowid, 'table', t.name, t.name, t.root, tableToSql(t));
    this.bump();
  }

  /** Every b-tree root in the database, for integrity checks and the page map. */
  trees(): { name: string; kind: 'table' | 'index' | 'catalog'; tree: BTree }[] {
    const out: { name: string; kind: 'table' | 'index' | 'catalog'; tree: BTree }[] = [{ name: 'opus_schema', kind: 'catalog', tree: this.tree }];
    for (const t of this.tables.values()) {
      out.push({ name: t.name, kind: 'table', tree: this.tableTree(t) });
      for (const ix of t.indexes) out.push({ name: ix.name, kind: 'index', tree: this.indexTree(ix) });
    }
    return out;
  }
}

function renameColumnRefs(e: A.Expr, from: string, to: string): void {
  const visit = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      x.forEach(visit);
      return;
    }
    const o = x as Record<string, unknown>;
    if (o.type === 'column' && typeof o.name === 'string' && lower(o.name) === lower(from)) o.name = to;
    for (const v of Object.values(o)) visit(v);
  };
  visit(e);
}

function columnFromDef(def: A.ColumnDef): ColumnSchema {
  return {
    name: def.name,
    type: def.dataType,
    typeName: def.typeName,
    notNull: def.notNull,
    primaryKey: def.primaryKey,
    unique: def.unique,
    default: def.default,
    check: def.check,
    references: def.references,
  };
}

export function buildTableSchema(stmt: A.CreateTableStmt): { schema: TableSchema; uniqueSets: { columns: number[] }[] } {
  const columns: ColumnSchema[] = [];
  const seen = new Set<string>();
  for (const def of stmt.columns) {
    if (seen.has(lower(def.name))) throw new OpusError(ErrorCode.duplicateColumn, `duplicate column name: ${def.name}`, def.pos);
    seen.add(lower(def.name));
    columns.push(columnFromDef(def));
  }
  if (columns.length === 0) throw new OpusError(ErrorCode.syntax, 'a table must have at least one column', stmt.pos);
  const colIndex = (name: string, pos: number) => {
    const i = columns.findIndex((c) => lower(c.name) === lower(name));
    if (i < 0) throw new OpusError(ErrorCode.undefinedColumn, `no such column: ${name}`, pos);
    return i;
  };

  let pk: number[] = [];
  let pkDesc = false;
  let autoincrement = false;
  stmt.columns.forEach((def, i) => {
    if (def.primaryKey) {
      if (pk.length) throw new OpusError(ErrorCode.syntax, `table ${stmt.name} has more than one primary key`, def.pos);
      pk = [i];
      pkDesc = def.primaryKeyDesc;
      autoincrement = def.autoincrement;
    }
  });
  const checks: TableSchema['checks'] = [];
  const foreignKeys: TableSchema['foreignKeys'] = [];
  const uniqueSets: { columns: number[] }[] = [];
  for (const c of stmt.constraints) {
    if (c.type === 'primary_key') {
      if (pk.length) throw new OpusError(ErrorCode.syntax, `table ${stmt.name} has more than one primary key`, c.pos);
      pk = c.columns.map((n) => colIndex(n, c.pos));
    } else if (c.type === 'unique') uniqueSets.push({ columns: c.columns.map((n) => colIndex(n, c.pos)) });
    else if (c.type === 'check') checks.push({ expr: c.expr, name: 'check' });
    else foreignKeys.push({ columns: c.columns.map((n) => colIndex(n, c.pos)), table: c.table, refColumns: c.refColumns });
  }
  columns.forEach((col, i) => {
    if (col.check) checks.push({ expr: col.check, name: col.name });
    if (col.unique) uniqueSets.unshift({ columns: [i] });
    if (col.references) foreignKeys.push({ columns: [i], table: col.references.table, refColumns: col.references.column ? [col.references.column] : undefined });
  });
  for (const i of pk) {
    columns[i].primaryKey = true;
    columns[i].notNull = true;
  }
  const rowidCol = pk.length === 1 && columns[pk[0]].type === 'INTEGER' && !pkDesc ? pk[0] : -1;
  if (autoincrement && rowidCol < 0) throw new OpusError(ErrorCode.syntax, 'AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY', stmt.pos);
  if (pk.length && rowidCol < 0) uniqueSets.unshift({ columns: pk });
  // de-duplicate identical unique sets
  const keys = new Set<string>();
  const sets = uniqueSets.filter((s) => {
    const k = s.columns.join(',');
    if (keys.has(k) || (rowidCol >= 0 && k === String(rowidCol))) return false;
    keys.add(k);
    return true;
  });
  return {
    schema: {
      kind: 'table',
      name: stmt.name,
      columns,
      rowidCol,
      pk,
      autoincrement,
      root: 0,
      indexes: [],
      checks,
      foreignKeys,
      catalogRowid: 0,
    },
    uniqueSets: sets,
  };
}

function indexFromStmt(stmt: A.CreateIndexStmt, table: TableSchema): IndexSchema {
  const columns = stmt.columns.map((c) => {
    const i = table.columns.findIndex((col) => lower(col.name) === lower(c.name));
    if (i < 0) throw new OpusError(ErrorCode.corrupt, `index ${stmt.name} refers to missing column ${c.name}`);
    return i;
  });
  return {
    name: stmt.name,
    table: table.name,
    columns,
    desc: stmt.columns.map((c) => c.desc),
    unique: stmt.unique,
    root: 0,
    auto: stmt.name.startsWith(AUTOINDEX_PREFIX),
    catalogRowid: 0,
  };
}

export function tableToSql(t: TableSchema): string {
  const parts = t.columns.map((c, i) => {
    let s = quoteIdent(c.name);
    if (c.typeName) s += ' ' + c.typeName;
    if (i === t.rowidCol) s += ' PRIMARY KEY' + (t.autoincrement ? ' AUTOINCREMENT' : '');
    if (c.notNull && i !== t.rowidCol) s += ' NOT NULL';
    if (c.unique) s += ' UNIQUE';
    if (c.default) s += ` DEFAULT (${exprToSql(c.default)})`;
    if (c.check) s += ` CHECK (${exprToSql(c.check)})`;
    if (c.references) s += ` REFERENCES ${quoteIdent(c.references.table)}${c.references.column ? `(${quoteIdent(c.references.column)})` : ''}`;
    return s;
  });
  if (t.pk.length && t.rowidCol < 0) parts.push(`PRIMARY KEY (${t.pk.map((i) => quoteIdent(t.columns[i].name)).join(', ')})`);
  for (const ch of t.checks) {
    if (t.columns.some((c) => c.check === ch.expr)) continue;
    parts.push(`CHECK (${exprToSql(ch.expr)})`);
  }
  for (const fk of t.foreignKeys) {
    if (fk.columns.length === 1 && t.columns[fk.columns[0]].references) continue;
    parts.push(
      `FOREIGN KEY (${fk.columns.map((i) => quoteIdent(t.columns[i].name)).join(', ')}) REFERENCES ${quoteIdent(fk.table)}` +
        (fk.refColumns ? ` (${fk.refColumns.map(quoteIdent).join(', ')})` : ''),
    );
  }
  return `CREATE TABLE ${quoteIdent(t.name)} (${parts.join(', ')})`;
}

export function indexToSql(ix: IndexSchema, t: TableSchema): string {
  const cols = ix.columns.map((c, i) => quoteIdent(t.columns[c].name) + (ix.desc[i] ? ' DESC' : '')).join(', ');
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(ix.name)} ON ${quoteIdent(t.name)} (${cols})`;
}
