import type { Row, Value } from '../types.ts';
import { ErrorCode, OpusError } from '../types.ts';
import type { IndexSchema } from '../catalog.ts';
import type { ExecContext } from './context.ts';
import type { Compiled } from './expr.ts';
import { truth } from './expr.ts';
import { Operator } from './operators.ts';
import type { TableHandle } from './table.ts';

/** Base class for INSERT / UPDATE / DELETE: does all the work in open(), yields RETURNING rows. */
abstract class DmlOperator extends Operator {
  rowsAffected = 0;
  lastInsertRowid: number | undefined;
  protected out: Row[] = [];
  private i = 0;
  protected readonly handle: TableHandle;
  protected readonly returning?: Compiled[];

  constructor(ctx: ExecContext, handle: TableHandle, returning: Compiled[] | undefined, layout: number[]) {
    super(ctx);
    this.handle = handle;
    this.returning = returning;
    this.layout = layout;
  }

  protected emit(row: Row): void {
    if (this.returning) this.out.push(this.returning.map((f) => f(row)));
  }

  protected collect(source: Operator): Row[] {
    const rows: Row[] = [];
    source.open();
    for (let r = source.next(); r; r = source.next()) rows.push(r);
    source.close();
    return rows;
  }

  abstract run(): void;

  open(): void {
    this.rowsAffected = 0;
    this.out = [];
    this.i = 0;
    this.run();
  }

  next(): Row | null {
    return this.i < this.out.length ? this.out[this.i++] : null;
  }
  override close(): void {}
}

export interface UpsertSpec {
  index?: IndexSchema | 'rowid';
  action: 'NOTHING' | { sets: { col: number; fn: Compiled }[]; where?: Compiled };
}

export class InsertOp extends DmlOperator {
  readonly name: string;
  private readonly source: Operator | null;
  private readonly targets: number[];
  private readonly conflict?: 'REPLACE' | 'IGNORE';
  private readonly upsert?: UpsertSpec;

  constructor(
    ctx: ExecContext,
    handle: TableHandle,
    source: Operator | null,
    targets: number[],
    opts: { conflict?: 'REPLACE' | 'IGNORE'; upsert?: UpsertSpec; returning?: Compiled[]; layout: number[] },
  ) {
    super(ctx, handle, opts.returning, opts.layout);
    this.source = source;
    this.targets = targets;
    this.conflict = opts.conflict;
    this.upsert = opts.upsert;
    this.children = source ? [source] : [];
    this.name = `Insert on ${handle.schema.name}`;
    if (opts.conflict) this.details.push(`Conflict: ${opts.conflict}`);
    if (opts.upsert) this.details.push(`On Conflict: ${opts.upsert.action === 'NOTHING' ? 'DO NOTHING' : 'DO UPDATE'}`);
  }

  run(): void {
    const h = this.handle;
    const n = h.ncols;
    const srcRows = this.source ? this.collect(this.source) : [[]];
    for (const src of srcRows) {
      this.ctx.tick();
      const values = new Array<Value | undefined>(n).fill(undefined);
      let explicitRowid: Value | undefined;
      for (let i = 0; i < this.targets.length; i++) {
        const t = this.targets[i];
        if (t === -1) explicitRowid = src[i];
        else values[t] = src[i];
      }
      for (let c = 0; c < n; c++) {
        if (values[c] === undefined) {
          const d = h.defaults[c];
          values[c] = d ? d([]) : null;
        }
      }
      const rowid = h.resolveRowid(values as Row, explicitRowid);
      const row = h.prepareRow(values as Row, rowid);
      const conflicts = h.findConflicts(row, rowid);
      if (conflicts.length) {
        if (this.upsert) {
          const relevant = this.upsert.index ? conflicts.find((c) => c.index === this.upsert!.index) : conflicts[0];
          if (!relevant) throw h.uniqueViolation(conflicts[0].index);
          if (this.upsert.action === 'NOTHING') continue;
          const existing = h.get(relevant.rowid)!;
          const env = existing.concat(row);
          if (this.upsert.action.where && truth(this.upsert.action.where(env)) !== true) continue;
          const next = existing.slice(0, n);
          for (const s of this.upsert.action.sets) next[s.col] = s.fn(env);
          const newRowid = h.rowidCol >= 0 ? h.resolveRowid(next, undefined) : relevant.rowid;
          const newRow = h.prepareRow(next, newRowid);
          const again = h.findConflicts(newRow, newRowid, relevant.rowid);
          if (again.length) throw h.uniqueViolation(again[0].index);
          h.updateRow(existing, newRow);
          this.rowsAffected++;
          this.emit(newRow);
          continue;
        }
        if (this.conflict === 'IGNORE') continue;
        if (this.conflict === 'REPLACE') {
          const seen = new Set<number>();
          for (const c of conflicts) {
            if (seen.has(c.rowid)) continue;
            seen.add(c.rowid);
            const old = h.get(c.rowid);
            if (old) h.deleteRow(old);
          }
          // a replaced row may also collide on another unique index that was not reported yet
          const more = h.findConflicts(row, rowid);
          for (const c of more) {
            const old = h.get(c.rowid);
            if (old) h.deleteRow(old);
          }
        } else throw h.uniqueViolation(conflicts[0].index);
      }
      h.insertRow(row);
      this.rowsAffected++;
      this.lastInsertRowid = rowid;
      this.emit(row);
    }
  }
}

export class UpdateOp extends DmlOperator {
  readonly name: string;
  private readonly source: Operator;
  private readonly colPos: number[];
  private readonly rowidPos: number;
  private readonly sets: { col: number; fn: Compiled }[];

  constructor(
    ctx: ExecContext,
    handle: TableHandle,
    source: Operator,
    colPos: number[],
    rowidPos: number,
    sets: { col: number; fn: Compiled }[],
    returning: Compiled[] | undefined,
    layout: number[],
  ) {
    super(ctx, handle, returning, layout);
    this.source = source;
    this.colPos = colPos;
    this.rowidPos = rowidPos;
    this.sets = sets;
    this.children = [source];
    this.name = `Update on ${handle.schema.name}`;
  }

  run(): void {
    const h = this.handle;
    const n = h.ncols;
    const rows = this.collect(this.source);
    const seen = new Set<number>();
    const touchesRowid = h.rowidCol >= 0 && this.sets.some((s) => s.col === h.rowidCol);
    for (const src of rows) {
      this.ctx.tick();
      const oldRowid = src[this.rowidPos] as number;
      if (seen.has(oldRowid)) continue;
      seen.add(oldRowid);
      const old = new Array<Value>(n + 1);
      for (let i = 0; i < n; i++) old[i] = src[this.colPos[i]];
      old[n] = oldRowid;
      const next = old.slice(0, n);
      for (const s of this.sets) next[s.col] = s.fn(src);
      const newRowid = touchesRowid ? h.resolveRowid(next, undefined) : oldRowid;
      const newRow = h.prepareRow(next, newRowid);
      const conflicts = h.findConflicts(newRow, newRowid, oldRowid);
      if (conflicts.length) throw h.uniqueViolation(conflicts[0].index);
      h.updateRow(old, newRow);
      this.rowsAffected++;
      this.emit(newRow);
    }
  }
}

export class DeleteOp extends DmlOperator {
  readonly name: string;
  private readonly source: Operator;
  private readonly colPos: number[];
  private readonly rowidPos: number;
  private readonly all: boolean;

  constructor(
    ctx: ExecContext,
    handle: TableHandle,
    source: Operator,
    colPos: number[],
    rowidPos: number,
    all: boolean,
    returning: Compiled[] | undefined,
    layout: number[],
  ) {
    super(ctx, handle, returning, layout);
    this.source = source;
    this.colPos = colPos;
    this.rowidPos = rowidPos;
    this.all = all;
    this.children = all && !returning ? [] : [source];
    this.name = all && !returning ? `Truncate ${handle.schema.name}` : `Delete on ${handle.schema.name}`;
  }

  run(): void {
    const h = this.handle;
    if (this.all && !this.returning) {
      this.rowsAffected = h.truncate();
      return;
    }
    const n = h.ncols;
    const rows = this.collect(this.source);
    const seen = new Set<number>();
    for (const src of rows) {
      this.ctx.tick();
      const rowid = src[this.rowidPos] as number;
      if (seen.has(rowid)) continue;
      seen.add(rowid);
      const old = new Array<Value>(n + 1);
      for (let i = 0; i < n; i++) old[i] = src[this.colPos[i]];
      old[n] = rowid;
      h.deleteRow(old);
      this.rowsAffected++;
      this.emit(old);
    }
    if (rows.length > 0 && seen.size === 0) throw new OpusError(ErrorCode.internal, 'delete produced no row ids');
  }
}
