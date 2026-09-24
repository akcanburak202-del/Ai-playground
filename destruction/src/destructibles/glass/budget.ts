import type { SimContext } from '../../app/contracts.ts';

/**
 * Wall-clock budget per simulation step for the deferrable fracture work of all the glass in a
 * scene (blast fracture of further panes, spawning pieces and dice, drawing cracks), ms. A blast
 * along a curtain wall reaches every pane in the same step, and a collapse breaks a pane per step
 * while earlier ones are still pouring out their dice; past the budget the rest continues in the
 * next steps (a few ms of simulated time later) instead of stalling one frame. When the budget is
 * spent, one job per step still gets its floor, so every queue drains and nothing starves.
 */
export const STEP_BUDGET = 10;

interface Ledger {
  time: number;
  used: number;
  /** Blasts processed this step */
  blasts: number;
  /** Over-budget floor grants this step */
  floors: number;
  /** The deferred-blast queue was drained this step */
  drained: boolean;
}

const ledgers = new WeakMap<SimContext, Ledger>();

interface Deferred {
  owner: object;
  job: () => void;
}

/** Blasts deferred by the budget, scene-wide, in arrival order (the shock front's order). */
const queues = new WeakMap<SimContext, Deferred[]>();

function ledger(ctx: SimContext): Ledger {
  const now = ctx.time.now;
  let l = ledgers.get(ctx);
  if (!l) ledgers.set(ctx, (l = { time: now, used: 0, blasts: 0, floors: 0, drained: false }));
  else if (l.time !== now) {
    l.time = now;
    l.used = 0;
    l.blasts = 0;
    l.floors = 0;
    l.drained = false;
  }
  return l;
}

/**
 * Time a job may take now: its own cap, clipped by what the scene has left this step. Over budget
 * it is 0 (skip this step), except for the first such job of the step, which gets `floor`.
 */
export function allowance(ctx: SimContext, cap: number, floor: number): number {
  const l = ledger(ctx);
  const left = STEP_BUDGET - l.used;
  if (left >= floor && left > 0) return Math.min(cap, left);
  if (l.floors > 0) return 0;
  l.floors++;
  return floor;
}

/** Book wall-clock time spent on glass work this step. */
export function spend(ctx: SimContext, ms: number): void {
  ledger(ctx).used += ms;
}

/** Whether this step's budget is used up. */
export function exhausted(ctx: SimContext): boolean {
  return ledger(ctx).used >= STEP_BUDGET;
}

/**
 * Whether a pane may process a blast now: within the budget, and always the first blast of a step
 * (so the deferred queue drains at least one per step). Books the blast when it says yes.
 */
export function admitBlast(ctx: SimContext): boolean {
  const l = ledger(ctx);
  if (l.used >= STEP_BUDGET && l.blasts > 0) return false;
  l.blasts++;
  return true;
}

/**
 * Run `job` (the blast fracture of the pane `owner`) now if the budget admits it, else queue it for
 * the next steps.
 */
export function blastJob(ctx: SimContext, owner: object, job: () => void): void {
  const q = queues.get(ctx);
  // Behind earlier deferred blasts: keep the order in which the shock front reached the panes.
  if ((q && q.length) || !admitBlast(ctx)) {
    if (q) q.push({ owner, job });
    else queues.set(ctx, [{ owner, job }]);
    return;
  }
  timed(ctx, job);
}

/** Forget the deferred blasts of a disposed pane. */
export function dropBlasts(ctx: SimContext, owner: object): void {
  const q = queues.get(ctx);
  if (!q) return;
  for (let i = q.length - 1; i >= 0; i--) if (q[i]!.owner === owner) q.splice(i, 1);
}

/**
 * Process deferred blasts first thing in a step (before dice and pieces: a pane still standing
 * after its neighbours broke shows more than dice that start their flight a step late). Cheap to
 * call from every pane; only the first call of a step does anything.
 */
export function drainBlasts(ctx: SimContext): void {
  const l = ledger(ctx);
  if (l.drained) return;
  l.drained = true;
  const q = queues.get(ctx);
  while (q && q.length && admitBlast(ctx)) timed(ctx, q.shift()!.job);
}

/** Deferred blasts waiting in a scene. */
export function pendingBlasts(ctx: SimContext): number {
  return queues.get(ctx)?.length ?? 0;
}

function timed(ctx: SimContext, job: () => void): void {
  const t0 = performance.now();
  try {
    job();
  } finally {
    spend(ctx, performance.now() - t0);
  }
}
