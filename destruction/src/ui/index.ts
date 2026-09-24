import type { Simulation } from '../app/Simulation.ts';
import type { SceneDef, WeaponControllerApi } from '../app/contracts.ts';
import { Hud, type HudOptions } from './Hud.ts';

export { Hud, type HudOptions } from './Hud.ts';
export { ensureFonts, ensureStyle } from './theme.ts';

/**
 * Install the heads-up display and the scene menu (DOM overlay over the canvas). The menu is
 * shown at install; "Başla" loads the chosen scene through `onSelectScene`, locks the pointer
 * and unlocks audio. Esc (pointer lock released) brings it back.
 */
export function installHud(
  sim: Simulation,
  weapons: WeaponControllerApi,
  opts: { scenes: SceneDef[]; onSelectScene(id: string): void | Promise<void>; container?: HTMLElement } & Partial<Pick<HudOptions, 'startWithMenu' | 'pauseOnMenu'>>,
): { showMenu(show: boolean): void; dispose(): void; hud: Hud } {
  const hud = new Hud(sim, weapons, opts);
  return {
    hud,
    showMenu: (show: boolean) => hud.showMenu(show),
    dispose: () => hud.dispose(),
  };
}
