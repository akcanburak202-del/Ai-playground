import type { SimContext } from '../../app/contracts.ts';

/**
 * Deterministic, budgeted queue for large voxel fractures (panel failures, island and slab
 * releases, secondary fractures of landing debris). Splitting a whole wall into Voronoi slabs and
 * building their bodies is hundreds of milliseconds of work; done inside one fixed step it froze
 * the app for seconds when a confined charge failed several walls at once.
 *
 * A job is a generator that yields the work units it just spent (see STEP_UNITS; a spawned piece
 * is charged PIECE_UNITS plus its samples). The queue runs once per fixed step (whichever voxel
 * element steps first calls `tick`), first-in first-out, until the step's budget is spent; a job
 * queued during a step starts on what is left of it. The budget is counted in work units, never
 * in wall-clock time, so a run is the same under `__sim.advance()` on any machine. `budget` may
 * be lowered per quality level (tablets) at the cost of a slower-realising collapse.
 */
export type FractureWork = Generator<number, void, void>;

export interface FractureOwner {
  readonly disposed: boolean;
}

interface Job {
  owner: FractureOwner;
  work: FractureWork;
}

/**
 * Work units per fixed step. One unit ≈ 80–100 ns in Node on the dev machine (a sample copied
 * whole with its block; a sample through the per-sample Voronoi test costs 8), so a step spends
 * ≈ 6 ms; a job always makes at least one unit of progress per step.
 */
export const STEP_UNITS = 70_000;
/** Units charged per spawned rigid piece on top of its samples (hull, body, proxy ≈ 5–8 ms). */
export const PIECE_UNITS = 60_000;

export class FractureQueue {
  budget = STEP_UNITS;
  private jobs: Job[] = [];
  private lastTick = Number.NaN;
  /** Budget left in the current step (a job queued mid-step starts on it) */
  private left = 0;
  private running = false;
  private readonly time: { readonly now: number };
  /** Units spent in the last step and in total (reports, the sandbox HUD). */
  lastUnits = 0;
  totalUnits = 0;
  lastMs = 0;
  maxMs = 0;

  constructor(time: { readonly now: number }) {
    this.time = time;
  }

  /**
   * Queue a job. Queued during a step whose budget is not spent yet (a support check in a
   * voxel fixedUpdate), it starts at once: small and medium failures still realise in the step
   * that caused them; only the part beyond the budget waits for the next steps.
   */
  push(owner: FractureOwner, work: FractureWork): void {
    this.jobs.push({ owner, work });
    if (this.time.now === this.lastTick && this.left > 0) this.run(this.left);
  }

  get pending(): number {
    return this.jobs.length;
  }

  has(owner: FractureOwner): boolean {
    for (const j of this.jobs) if (j.owner === owner) return true;
    return false;
  }

  /** Called from every voxel element's fixedUpdate; runs the budget once per step time. */
  tick(now: number): void {
    if (now === this.lastTick) return;
    this.lastTick = now;
    this.left = this.budget;
    if (this.jobs.length) this.run(this.budget);
  }

  /** Spend up to `units` (Infinity drains the queue), oldest job first. */
  run(units: number): void {
    if (this.running) return;
    this.running = true;
    const t0 = performance.now();
    let left = units;
    try {
      while (this.jobs.length && left > 0) {
        const job = this.jobs[0]!;
        if (job.owner.disposed) {
          this.jobs.shift();
          continue;
        }
        const r = job.work.next();
        // Removed by identity: the job may have disposed its owner (forget) or queued others.
        if (r.done || job.owner.disposed) {
          const q = this.jobs.indexOf(job);
          if (q >= 0) this.jobs.splice(q, 1);
          // An abandoned job still runs its `finally` blocks (bookkeeping of its owner).
          if (!r.done) job.work.return();
        } else left -= Math.max(1, r.value);
      }
    } finally {
      this.running = false;
    }
    if (units !== Infinity) this.left = Math.min(this.left, left);
    this.lastUnits = units === Infinity ? 0 : units - left;
    this.totalUnits += this.lastUnits;
    this.lastMs = performance.now() - t0;
    this.maxMs = Math.max(this.maxMs, this.lastMs);
  }

  /** Finish every job of one owner now (a second failure of an element whose first is pending). */
  flush(owner: FractureOwner): void {
    if (this.running) return;
    this.running = true;
    try {
      for (let q = 0; q < this.jobs.length; ) {
        const job = this.jobs[q]!;
        if (job.owner !== owner) {
          q++;
          continue;
        }
        if (!owner.disposed) while (!job.work.next().done && !owner.disposed);
        this.jobs.splice(q, 1);
      }
    } finally {
      this.running = false;
    }
  }

  /** Drop the jobs of a disposed owner. */
  forget(owner: FractureOwner): void {
    this.jobs = this.jobs.filter((j) => j.owner !== owner);
  }
}

const queues = new WeakMap<SimContext, FractureQueue>();

export function fractureQueueFor(ctx: SimContext): FractureQueue {
  let q = queues.get(ctx);
  if (!q) queues.set(ctx, (q = new FractureQueue(ctx.time)));
  return q;
}
