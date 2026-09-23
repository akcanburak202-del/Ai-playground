import type { Row, Value } from '../types.ts';
import { ErrorCode, OpusError } from '../types.ts';
import type { FunctionEnv } from './functions.ts';

/** Per-execution state shared by every operator and compiled expression of a statement. */
export class ExecContext {
  params: Value[] = [];
  /** Values of columns referenced from an enclosing scope, indexed by column id. */
  outer: Value[] = [];
  /** Incremented on every execution; invalidates per-execution caches. */
  execId = 0;
  /** Working tables of recursive CTEs, by work id. */
  readonly work = new Map<number, Row[]>();
  readonly env: FunctionEnv;
  private nowMs = 0;
  private ticks = 0;
  deadline = Infinity;
  interrupted = false;
  /** Rows produced by base-table scans (for statistics). */
  rowsScanned = 0;

  constructor() {
    this.env = { now: () => this.nowMs, random: Math.random };
  }

  begin(params: Value[], timeoutMs?: number): void {
    this.params = params;
    this.execId++;
    this.nowMs = Date.now();
    this.ticks = 0;
    this.rowsScanned = 0;
    this.interrupted = false;
    this.deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  }

  /** Called from loops; throws when the statement exceeded its time budget or was cancelled. */
  tick(): void {
    if ((++this.ticks & 0xfff) === 0) {
      if (this.interrupted) throw new OpusError(ErrorCode.lockNotAvailable, 'query was interrupted');
      if (this.deadline !== Infinity && Date.now() > this.deadline) {
        throw new OpusError(ErrorCode.lockNotAvailable, 'query exceeded its time limit');
      }
    }
  }
}
