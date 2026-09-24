import type { WeaponControllerApi } from '../app/contracts.ts';
import type { AmmoSpec } from '../physics/ballistics/types.ts';

/**
 * The player controls and the HUD are installed separately (either may be absent). They find
 * each other through this per-simulation bridge: the player publishes its view state (pointer
 * lock, aim-down-sights, bullet camera) and the HUD publishes its hooks (menu, help, toasts).
 * Whoever holds the weapon controller publishes it too (audio follows the trigger with it).
 */

export interface BulletCamView {
  ammo: AmmoSpec;
  speed: number;
  /** Distance flown from where the camera picked it up, m */
  distance: number;
  /** Following (true) or watching the impact point after the round ended (false) */
  following: boolean;
}

export interface PlayerView {
  readonly locked: boolean;
  /** Aim-down-sights blend 0..1 */
  readonly ads: number;
  readonly touch: boolean;
  /** Pointer lock was refused (sandboxed frame, browser policy): drag-look fallback is active */
  readonly lockUnavailable: boolean;
  readonly bulletCam: BulletCamView | null;
  /** C pressed with nothing to follow: waiting for the next slow round */
  readonly bulletCamArmed: boolean;
  /** Target time scale (slow motion on/off) */
  readonly slowMo: boolean;
  /**
   * Render-only recoil kick of the view, radians (+pitch up, +yaw left); zero when the camera
   * itself kicks. The aim stays put, so on screen it sits this far from the centre.
   */
  readonly kick: { readonly pitch: number; readonly yaw: number };
  requestLock(): void;
}

export interface HudHooks {
  readonly menuOpen: boolean;
  readonly helpOpen: boolean;
  showMenu(show: boolean): void;
  toggleHelp(): void;
  /** Rebuild the current scene */
  reload(): void;
  toast(text: string, accent?: boolean): void;
  /** Hide / show the play HUD (clean view for looking at the architecture) */
  toggleHud(): void;
}

export interface Bridge {
  player: PlayerView | null;
  hud: HudHooks | null;
  /** The viewer's weapon controller (rotary guns spin up while its trigger is held) */
  weapons: WeaponControllerApi | null;
}

const bridges = new WeakMap<object, Bridge>();

export function bridgeOf(sim: object): Bridge {
  let b = bridges.get(sim);
  if (!b) {
    b = { player: null, hud: null, weapons: null };
    bridges.set(sim, b);
  }
  return b;
}
