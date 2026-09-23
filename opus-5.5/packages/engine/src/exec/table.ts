import type { DataType, Row, Value } from '../types.ts';
import { ErrorCode, OpusError, describeValue, hashKey } from '../types.ts';
import type { Catalog, IndexSchema, TableSchema } from '../catalog.ts';
import type { BTree } from '../storage/btree.ts';
import { decodeRow, encodeRecord } from '../storage/codec.ts';
import type { Pager } from '../storage/pager.ts';
import type { Compiled } from './expr.ts';
import { truth } from './expr.ts';
import { castValue, toNumber } from './functions.ts';

/** Read access to a table: row decoding and rowid lookups. */
export class TableAccess {
  readonly schema: TableSchema;
  readonly tree: BTree;
  readonly ncols: number;
  readonly rowidCol: number;
  /** Values used for columns missing from old records (ALTER TABLE ADD COLUMN). */
  private readonly pad: Value[];

  constructor(catalog: Catalog, schema: TableSchema) {
    this.schema = schema;
    this.tree = catalog.tableTree(schema);
    this.ncols = schema.columns.length;
    this.rowidCol = schema.rowidCol;
    this.pad = schema.columns.map((c) => (c.default && c.default.type === 'literal' ? castValue(c.default.value, c.type) : null));
  }

  /** Decodes a record into [col0, ..., colN-1, rowid]; `need` limits which columns are materialised. */
  decode(payload: Uint8Array, rowid: number, need?: Uint8Array): Row {
    return decodeRow(payload, this.ncols, this.pad, rowid, need);
  }

  get(rowid: number, need?: Uint8Array): Row | undefined {
    const p = this.tree.get(rowid);
    return p ? decodeRow(p, this.ncols, this.pad, rowid, need) : undefined;
  }
}

/** Converts a value to the column's storage type; throws on values that cannot be represented. */
export function coerceToColumn(v: Value, type: DataType, table: string, column: string): Value {
  if (v === null) return null;
  const fail = (): never => {
    throw new OpusError(ErrorCode.datatypeMismatch, `cannot store ${describeValue(v)} in column ${table}.${column} of type ${type}`);
  };
  switch (type) {
    case 'INTEGER':
      if (typeof v === 'number') return Number.isInteger(v) ? v + 0 : fail();
      if (typeof v === 'boolean') return v ? 1 : 0;
      {
        const s = v.trim();
        if (/^[+-]?\d+$/.test(s)) return Number(s);
        if (/^[+-]?\d+\.0*$/.test(s)) return Math.trunc(Number(s));
        return fail();
      }
    case 'REAL':
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      {
        const s = v.trim();
        if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
        return fail();
      }
    case 'TEXT':
      if (typeof v === 'string') return v;
      return castValue(v, 'TEXT', typeof v === 'number' && !Number.isInteger(v) ? 'REAL' : 'ANY');
    case 'BOOLEAN':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      {
        const b = castValue(v, 'BOOLEAN');
        const s = v.trim().toLowerCase();
        if (['true', 'false', 't', 'f', 'yes', 'no', 'y', 'n', 'on', 'off', '1', '0'].includes(s)) return b;
        return fail();
      }
    default:
      return v;
  }
}

/** Applies a column type's comparison affinity to a probe value (SQLite style). */
export function affinityFor(type: DataType): (v: Value) => Value {
  if (type === 'INTEGER' || type === 'REAL') {
    return (v) => {
      if (typeof v === 'string') {
        const s = v.trim();
        if (s !== '' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return toNumber(s);
      }
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    };
  }
  if (type === 'TEXT') return (v) => (typeof v === 'number' ? castValue(v, 'TEXT', Number.isInteger(v) ? 'INTEGER' : 'REAL') : v);
  return (v) => v;
}

export interface ConflictInfo {
  rowid: number;
  index: IndexSchema | 'rowid';
}

/**
 * Write access to a table: enforces types, NOT NULL, CHECK and UNIQUE
 * constraints and keeps every index in sync with the table b-tree.
 */
export class TableHandle extends TableAccess {
  private readonly catalog: Catalog;
  private readonly pager: Pager;
  readonly indexes: { schema: IndexSchema; tree: BTree }[];
  /** Default value producers per column (undefined = NULL). */
  defaults: (Compiled | undefined)[] = [];
  /** CHECK constraints compiled over [cols..., rowid]. */
  checks: { fn: Compiled; name: string }[] = [];

  constructor(catalog: Catalog, schema: TableSchema) {
    super(catalog, schema);
    this.catalog = catalog;
    this.pager = catalog.pager;
    this.indexes = schema.indexes.map((ix) => ({ schema: ix, tree: catalog.indexTree(ix) }));
  }

  rowCount(): number {
    const s = this.schema;
    if (!s.rowCount || s.rowCount.epoch !== this.pager.epoch) s.rowCount = { epoch: this.pager.epoch, value: this.tree.count() };
    return s.rowCount.value;
  }

  private adjustCount(delta: number): void {
    const s = this.schema;
    if (s.rowCount && s.rowCount.epoch === this.pager.epoch) s.rowCount.value += delta;
  }

  /** SQLite rule: new rowid = largest existing rowid + 1. */
  private newRowid(): number {
    const last = this.tree.lastKey() as number | undefined;
    const id = last === undefined ? 1 : last + 1;
    if (id > Number.MAX_SAFE_INTEGER) throw new OpusError(ErrorCode.numericOutOfRange, 'database or disk is full (rowid space exhausted)');
    return id;
  }

  indexKey(ix: IndexSchema, row: Row, rowid: number): Value[] {
    const key = ix.columns.map((c) => row[c]);
    key.push(rowid);
    return key;
  }

  private constraintName(ix: IndexSchema | 'rowid'): string {
    if (ix === 'rowid') return `${this.schema.name}.${this.schema.columns[this.schema.rowidCol]?.name ?? 'rowid'}`;
    return ix.columns.map((c) => `${this.schema.name}.${this.schema.columns[c].name}`).join(', ');
  }

  uniqueViolation(ix: IndexSchema | 'rowid'): OpusError {
    return new OpusError(ErrorCode.uniqueViolation, `UNIQUE constraint failed: ${this.constraintName(ix)}`);
  }

  /** Finds an existing row conflicting with `row` on the rowid or any unique index. */
  findConflicts(row: Row, rowid: number, ignoreRowid?: number): ConflictInfo[] {
    const out: ConflictInfo[] = [];
    if (rowid !== ignoreRowid && this.tree.get(rowid) !== undefined) out.push({ rowid, index: 'rowid' });
    for (const { schema: ix, tree } of this.indexes) {
      if (!ix.unique) continue;
      const key = ix.columns.map((c) => row[c]);
      if (key.some((v) => v === null)) continue;
      const c = tree.cursor();
      for (let ok = c.seek(key); ok && tree.cmpPrefix(c.key(), key) === 0; ok = c.next()) {
        const k = c.key() as Value[];
        const other = k[k.length - 1] as number;
        if (other !== ignoreRowid) {
          out.push({ rowid: other, index: ix });
          break;
        }
      }
    }
    return out;
  }

  /** Validates types, NOT NULL and CHECK constraints; returns the normalised row. */
  prepareRow(values: Row, rowid: number): Row {
    const cols = this.schema.columns;
    const row = new Array<Value>(cols.length + 1);
    for (let i = 0; i < cols.length; i++) {
      const v = coerceToColumn(values[i] ?? null, cols[i].type, this.schema.name, cols[i].name);
      if (v === null && cols[i].notNull && i !== this.rowidCol) {
        throw new OpusError(ErrorCode.notNullViolation, `NOT NULL constraint failed: ${this.schema.name}.${cols[i].name}`);
      }
      row[i] = v;
    }
    if (this.rowidCol >= 0) row[this.rowidCol] = rowid;
    row[cols.length] = rowid;
    for (const ch of this.checks) {
      if (truth(ch.fn(row)) === false) throw new OpusError(ErrorCode.checkViolation, `CHECK constraint failed: ${ch.name}`);
    }
    return row;
  }

  /** Resolves the rowid for a new row (INTEGER PRIMARY KEY value, explicit rowid or auto-assigned). */
  resolveRowid(values: Row, explicit: Value | undefined): number {
    let v: Value | undefined = this.rowidCol >= 0 ? values[this.rowidCol] : explicit;
    if (v === undefined || v === null) return this.newRowid();
    if (typeof v === 'string') v = coerceToColumn(v, 'INTEGER', this.schema.name, this.schema.columns[this.rowidCol]?.name ?? 'rowid');
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new OpusError(ErrorCode.datatypeMismatch, `datatype mismatch: rowid must be an integer, got ${describeValue(v as Value)}`);
    }
    return v;
  }

  /** Inserts a fully prepared row (constraints already checked). */
  insertRow(row: Row): void {
    const n = this.ncols;
    const rowid = row[n] as number;
    this.tree.insert(rowid, encodeRecord(row.slice(0, n)));
    for (const { schema, tree } of this.indexes) tree.insert(this.indexKey(schema, row, rowid));
    this.adjustCount(1);
  }

  deleteRow(row: Row): void {
    const n = this.ncols;
    const rowid = row[n] as number;
    if (!this.tree.delete(rowid)) throw new OpusError(ErrorCode.corrupt, `row ${rowid} vanished during delete`);
    for (const { schema, tree } of this.indexes) {
      if (!tree.delete(this.indexKey(schema, row, rowid))) {
        throw new OpusError(ErrorCode.corrupt, `index ${schema.name} is missing an entry for row ${rowid}`);
      }
    }
    this.adjustCount(-1);
  }

  /** Replaces `oldRow` with `newRow` (both prepared; rowid may change). */
  updateRow(oldRow: Row, newRow: Row): void {
    const n = this.ncols;
    const oldId = oldRow[n] as number;
    const newId = newRow[n] as number;
    if (oldId !== newId) {
      this.deleteRow(oldRow);
      this.insertRow(newRow);
      return;
    }
    this.tree.insert(oldId, encodeRecord(newRow.slice(0, n)), true);
    for (const { schema, tree } of this.indexes) {
      let changed = false;
      for (const c of schema.columns) {
        if (hashKey(oldRow[c]) !== hashKey(newRow[c]) || typeof oldRow[c] !== typeof newRow[c]) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      tree.delete(this.indexKey(schema, oldRow, oldId));
      tree.insert(this.indexKey(schema, newRow, newId));
    }
  }

  /** Removes every row (DELETE without WHERE). */
  truncate(): number {
    const count = this.rowCount();
    this.tree.destroy(true);
    for (const { tree } of this.indexes) tree.destroy(true);
    this.schema.rowCount = { epoch: this.pager.epoch, value: 0 };
    return count;
  }
}
