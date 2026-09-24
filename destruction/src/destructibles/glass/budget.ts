import type { SimContext } from '../../app/contracts.ts';

/**
 * Wall-clock budget per simulation step for the deferrable fracture work of all the glass in a
 * scene (blast fracture of further panes, spawning pieces and dice, re-breaking shards), ms. A blast
 * along a curtain wall reaches every pane in the same step; past the budget the rest continues in
 * the next steps (a few ms of simulated time later) instead of stalling one frame. Every job still
 * gets a small floor per step, so nothing starves.
 */
export const STEP_BUDGET = 16;

interface Ledger {
  time: number;
  used: number;
  /** Blasts processed this step */
  blasts: number;
}

const ledgers = new WeakMap<SimContext, Ledger>();

function ledger(ctx: SimContext): Ledger {
  const now = ctx.time.now;
  let l = ledgers.get(ctx);
  if (!l) ledgers.set(ctx, (l = { time: now, used: 0, blasts: 0 }));
  else if (l.time !== now) {
    l.time = now;
    l.used = 0;
    l.blasts = 0;
  }
  return l;
}

/** Time a job may take now: its own cap, clipped by what the scene has left this step, at least `floor`. */
export function allowance(ctx: SimContext, cap: number, floor: number): number {
  return Math.max(floor, Math.min(cap, STEP_BUDGET - ledger(ctx).used));
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
 * (so a queue of deferred panes drains at least one per step). Books the blast when it says yes.
 */
export function admitBlast(ctx: SimContext): boolean {
  const l = ledger(ctx);
  if (l.used >= STEP_BUDGET && l.blasts > 0) return false;
  l.blasts++;
  return true;
}
