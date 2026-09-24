import type { SimContext } from '../../app/contracts.ts';
import type { Destructible } from '../Destructible.ts';
import { Terrain, type TerrainOptions } from './Terrain.ts';

export { Terrain, type TerrainOptions } from './Terrain.ts';
export type { PlazaFinish } from './material.ts';

/**
 * The ground of a scene: a deformable height field (plaza finish near the building, grass and
 * soil beyond) with craters, scorch and impact pocks, and its Rapier colliders. Replaces the
 * default physics slab and hides the basic pipeline's ground plane.
 */
export function createTerrain(ctx: SimContext, opts?: TerrainOptions): Destructible {
  const t = new Terrain(ctx, opts);
  ctx.addDestructible(t);
  return t;
}
