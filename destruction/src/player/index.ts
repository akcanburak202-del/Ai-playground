import type { Simulation } from '../app/Simulation.ts';
import type { WeaponControllerApi } from '../app/contracts.ts';
import { PlayerController, type PlayerOptions } from './PlayerController.ts';

export { PlayerController, type PlayerOptions } from './PlayerController.ts';

/**
 * Install the viewer's controls: pointer-locked fly camera with the weapon (keyboard + mouse),
 * or touch controls on phones. Registers a per-frame system on the simulation.
 */
export function installPlayer(sim: Simulation, weapons: WeaponControllerApi, opts?: { canvas: HTMLCanvasElement } & PlayerOptions): { dispose(): void; player: PlayerController } {
  const player = new PlayerController(sim, weapons, opts ?? {});
  sim.addSystem(player);
  return {
    player,
    dispose: () => player.dispose(),
  };
}
