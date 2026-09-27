import type { SimContext } from '../../app/contracts.ts';
import { gelBlock, mannequin, type V3 } from './anatomy.ts';
import { GelRig, type DummySpec } from './GelRig.ts';

export { GelRig, type DummySpec } from './GelRig.ts';
export { GelBody } from './GelBody.ts';
export { mannequin, gelBlock } from './anatomy.ts';

/**
 * A ballistic dummy: a 1.80 m, 76 kg mannequin of 10 % gelatin around a synthetic skeleton, in
 * eleven jointed pieces, pinned to a steel stand (unless `stand: false`). Every piece is a
 * destructible of kind 'gel'; the returned rig owns the bodies, joints, stand and debris.
 */
export function createDummy(ctx: SimContext, spec: DummySpec): GelRig {
  const rig = new GelRig(ctx, spec.name, spec.position, spec.rotY ?? 0);
  rig.build(mannequin(), spec.stand ?? true);
  ctx.addDestructible(rig);
  return rig;
}

export interface GelBlockSpec {
  name: string;
  /** Centre of the block, m */
  position: V3;
  rotY?: number;
  /** Full size x, y, z (default FBI block 15.2 × 15.2 × 40.6 cm, long along z) */
  size?: V3;
  /** Cast a synthetic femur shaft along the block's axis */
  bone?: boolean;
}

/** A free gel block (a rigid body resting where it is put: shots push it, a .50 throws it). */
export function createGelBlock(ctx: SimContext, spec: GelBlockSpec): GelRig {
  const rig = new GelRig(ctx, spec.name, spec.position, spec.rotY ?? 0);
  rig.build(gelBlock(spec.size, spec.bone), false);
  ctx.addDestructible(rig);
  return rig;
}
