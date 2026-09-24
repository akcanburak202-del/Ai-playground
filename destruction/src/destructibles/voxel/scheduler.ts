import type { SimContext } from '../../app/contracts.ts';

/**
 * One remesh budget shared by every voxel element of a simulation. Elements queue dirty chunks
 * with a priority (squared distance to the camera, nearest first); whichever element runs its
 * `frameUpdate` first in a frame spends the budget on behalf of all of them. A frame boundary is
 * detected when an element calls in a second time.
 */
export interface RemeshClient {
  /** Rebuild one chunk's mesh; returns false if the chunk no longer needed work. */
  remesh(ci: number): boolean;
  readonly disposed: boolean;
}

interface Job {
  el: RemeshClient;
  ci: number;
  prio: number;
}

export class RemeshScheduler {
  /** Milliseconds of remeshing per rendered frame */
  budgetMs = 4;
  private jobs: Job[] = [];
  private seen = new Set<RemeshClient>();
  private queued = new Map<RemeshClient, Set<number>>();
  /** Stats of the last frame (for the sandbox HUD / reports). */
  lastFrameMs = 0;
  lastFrameChunks = 0;
  totalChunks = 0;
  totalMs = 0;

  request(el: RemeshClient, ci: number, prio: number): void {
    let set = this.queued.get(el);
    if (!set) this.queued.set(el, (set = new Set()));
    if (set.has(ci)) return;
    set.add(ci);
    this.jobs.push({ el, ci, prio });
  }

  get pending(): number {
    return this.jobs.length;
  }

  /** Called from each element's frameUpdate. */
  tick(el: RemeshClient): void {
    if (this.seen.has(el)) this.seen.clear();
    const first = this.seen.size === 0;
    this.seen.add(el);
    if (first) this.run(this.budgetMs);
  }

  /**
   * Spend up to `ms` milliseconds, nearest chunks first; urgent jobs (debris that just broke
   * off, prio < 0) come first and may use up to `urgentMs`. Infinity flushes everything.
   */
  run(ms: number, urgentMs = Math.max(ms, 12)): void {
    const t0 = performance.now();
    let n = 0;
    if (this.jobs.length > 1) this.jobs.sort((a, b) => b.prio - a.prio);
    while (this.jobs.length) {
      const job = this.jobs[this.jobs.length - 1]!;
      const limit = job.prio < 0 ? urgentMs : ms;
      if (n > 0 && performance.now() - t0 >= limit) break;
      this.jobs.pop();
      this.queued.get(job.el)?.delete(job.ci);
      if (job.el.disposed) continue;
      job.el.remesh(job.ci);
      n++;
    }
    for (const [el, set] of this.queued) if (el.disposed || set.size === 0) this.queued.delete(el);
    this.lastFrameMs = performance.now() - t0;
    this.lastFrameChunks = n;
    this.totalChunks += n;
    this.totalMs += this.lastFrameMs;
  }

  /** Drop queued work of one element (disposed or re-meshed synchronously). */
  forget(el: RemeshClient): void {
    this.queued.delete(el);
    this.jobs = this.jobs.filter((j) => j.el !== el);
  }
}

const schedulers = new WeakMap<SimContext, RemeshScheduler>();

export function schedulerFor(ctx: SimContext): RemeshScheduler {
  let s = schedulers.get(ctx);
  if (!s) schedulers.set(ctx, (s = new RemeshScheduler()));
  return s;
}
