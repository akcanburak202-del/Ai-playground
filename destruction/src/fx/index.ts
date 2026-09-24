import type { Simulation } from '../app/Simulation.ts';
import type { FxApi } from '../app/contracts.ts';
import { FxSystem } from './FxSystem.ts';

export { FxSystem, BUDGET } from './FxSystem.ts';
export { groundOf, setGroundProvider, type GroundProvider } from './ground.ts';

/**
 * Install the visual effects: sets `sim.ctx.fx`, registers the per-frame system and subscribes to
 * shot / impact / blast / fracture / debrisContact / shatter / structuralFailure events.
 * Works under both render pipelines (soft particles and per-frame shake need `Pipeline`).
 */
export function installFx(sim: Simulation): FxApi {
  const fx = new FxSystem(sim);
  sim.ctx.fx = fx;
  sim.addSystem(fx);
  return fx;
}
