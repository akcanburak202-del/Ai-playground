import type { Simulation } from '../app/Simulation.ts';
import type { WeaponControllerApi } from '../app/contracts.ts';
import { WeaponController } from './WeaponController.ts';

export { WeaponController } from './WeaponController.ts';
export { WEAPONS, getWeapon, PLAY_RELOAD_SCALE, type WeaponData } from './arsenal.ts';

/** Create the viewer's weapon controller and register it as a fixed-step system. */
export function createWeaponController(sim: Simulation): WeaponControllerApi {
  const wc = new WeaponController(sim);
  sim.addSystem(wc);
  return wc;
}
