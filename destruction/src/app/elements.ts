import type { ElementFactories, SimContext } from './contracts.ts';
import { createVoxelElement } from '../destructibles/voxel/index.ts';
import { createSteelBeam, createSteelPlate } from '../destructibles/steel/index.ts';
import { createGlassPane } from '../destructibles/glass/index.ts';

/**
 * The element factories scenes build with. Each factory creates the element and registers it with
 * the simulation (`ctx.addDestructible`); supports are declared afterwards through
 * `ctx.structure.link(...)`.
 */
export function createElementFactories(ctx: SimContext): ElementFactories {
  return {
    voxel: (spec) => createVoxelElement(ctx, spec),
    plate: (spec) => createSteelPlate(ctx, spec),
    beam: (spec) => createSteelBeam(ctx, spec),
    glass: (spec) => createGlassPane(ctx, spec),
  };
}
