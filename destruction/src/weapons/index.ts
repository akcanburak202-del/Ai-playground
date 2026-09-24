import type { Simulation } from '../app/Simulation.ts';
import type { WeaponControllerApi } from '../app/contracts.ts';
import { ChargeMarkers } from './ChargeMarkers.ts';
import { WeaponController } from './WeaponController.ts';

export { WeaponController } from './WeaponController.ts';
export { ChargeMarkers } from './ChargeMarkers.ts';
export { WEAPONS, getWeapon, PLAY_RELOAD_SCALE, type WeaponData } from './arsenal.ts';

/**
 * Create the viewer's weapon controller and register it as a fixed-step system, together with the
 * markers that show its placed charges in the world (cleared with the scene).
 */
export function createWeaponController(sim: Simulation): WeaponControllerApi {
  const wc = new WeaponController(sim);
  sim.addSystem(wc);
  sim.addSystem(new ChargeMarkers(sim.ctx));
  return wc;
}
