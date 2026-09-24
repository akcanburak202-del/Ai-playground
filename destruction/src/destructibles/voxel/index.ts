import type { SimContext, VoxelElementSpec } from '../../app/contracts.ts';
import type { Destructible } from '../Destructible.ts';
import { VoxelElement } from './VoxelElement.ts';

export { VoxelElement, type VoxelStats } from './VoxelElement.ts';
export { schedulerFor, RemeshScheduler } from './scheduler.ts';

/**
 * Build a brittle voxel element (concrete, stone, brick; optionally reinforced) and register it
 * with the simulation (`ctx.addDestructible`, idempotent). Static unless `spec.dynamic`; anchor it
 * with `ctx.structure.link(...)` to make it part of the structural graph.
 */
export function createVoxelElement(ctx: SimContext, spec: VoxelElementSpec): Destructible {
  const el = new VoxelElement(ctx, spec);
  ctx.addDestructible(el);
  return el;
}
