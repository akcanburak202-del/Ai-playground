import type { GlassPaneSpec, SimContext } from '../../app/contracts.ts';
import type { Destructible } from '../Destructible.ts';
import { GlassPane } from './GlassPane.ts';

export { GlassPane } from './GlassPane.ts';
export { DiceSystem, DICE_CAP } from './DiceSystem.ts';
export { ReflectionProbes } from './probes.ts';
export { CrackGraph, type Face } from './crackGraph.ts';
export { growStar } from './cracks.ts';
export { Membrane } from './membrane.ts';
export {
  CRACK_SPEED, TEMPER_TENSION, COMPRESSION_DEPTH, diceSize, diceEjectionSpeed, temperStrainEnergy, temperedFails,
  impactStar, blastStar, blastFragmentSpeed, shardPieces, type GlassType,
} from './model.ts';

/**
 * Build an architectural glass pane and register it with the simulation. The pane is centred on
 * `spec.position`, spans `width` × `height` in its local x/y plane and faces +z (after `rotation`).
 * `spec.framed` panes are held on all four edges (glazing bite); otherwise by stainless point
 * fittings at the corners, which the pane draws itself. The pane carries no load; scenes may still
 * `ctx.structure.link(frame, pane, region)` so the glass breaks and falls when its frame goes.
 */
export function createGlassPane(ctx: SimContext, spec: GlassPaneSpec): Destructible {
  const pane = new GlassPane(ctx, spec);
  ctx.addDestructible(pane);
  return pane;
}
