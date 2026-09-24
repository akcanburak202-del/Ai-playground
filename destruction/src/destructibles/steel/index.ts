import type { SimContext, SteelBeamSpec, SteelPlateSpec } from '../../app/contracts.ts';
import type { Destructible } from '../Destructible.ts';
import { SteelPlate } from './SteelPlate.ts';
import { SteelBeam } from './SteelBeam.ts';

export { SteelPlate } from './SteelPlate.ts';
export { SteelBeam } from './SteelBeam.ts';
export { PlateSim } from './plateSim.ts';
export { BeamSim } from './beamSim.ts';
export { sectionProps, damagedSection, type SectionProps } from './section.ts';
export { steelParams, fractureStrain, type SteelParams } from './steelMaterial.ts';

/**
 * Build a steel plate (facade panel, armour, web or cladding sheet) and register it with the
 * simulation. Edges flagged in `spec.edges` are welded (clamped); further supports come from
 * `ctx.structure.link(...)` (anchors). It stays static until hit; when nothing holds it any more it
 * falls as a rigid body.
 */
export function createSteelPlate(ctx: SimContext, spec: SteelPlateSpec): Destructible {
  const plate = new SteelPlate(ctx, spec);
  ctx.addDestructible(plate);
  return plate;
}

/**
 * Build a steel member (column, beam, brace) and register it. End conditions come from
 * `spec.ends`; the upper end of a column with both ends supported is a roller that carries the
 * imposed load (`structural.setImposedLoad`) down the member.
 */
export function createSteelBeam(ctx: SimContext, spec: SteelBeamSpec): Destructible {
  const beam = new SteelBeam(ctx, spec);
  ctx.addDestructible(beam);
  return beam;
}
