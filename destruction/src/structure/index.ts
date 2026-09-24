import type { Simulation } from '../app/Simulation.ts';
import type { SimContext } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { StructureGraph } from './StructureGraph.ts';
import { guardDegenerateHulls } from './guards.ts';

export { StructureGraph, PRESENCE_MIN, delay, bearingHits, type GraphHost, type LinkInfo } from './StructureGraph.ts';
export { guardDegenerateHulls } from './guards.ts';

/**
 * Install the structure graph: sets `sim.ctx.structure` (the Simulation calls its `update` after
 * every fixed step) and clears it on scene loads. Also guards rigid-body creation against
 * degenerate rubble hulls, which collapses produce by the hundred (see guards.ts).
 */
export function installStructure(sim: Simulation): StructureGraph {
  guardDegenerateHulls(sim.ctx.physics);
  const graph = new StructureGraph(sim.ctx);
  sim.ctx.structure = graph;
  sim.addSystem({ name: 'structure', reset: () => graph.reset() });
  return graph;
}

/**
 * Dead load on an element that the graph cannot see (a test rig's jacks, plant on a roof), N.
 * Without the graph installed it goes straight to the element.
 */
export function setExternalLoad(ctx: SimContext, el: Destructible, newtons: number): void {
  if (ctx.structure instanceof StructureGraph) ctx.structure.setExternalLoad(el, newtons);
  else el.structural?.setImposedLoad(newtons);
}
