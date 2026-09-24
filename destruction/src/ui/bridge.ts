import type { AmmoSpec } from '../physics/ballistics/types.ts';

/**
 * The player controls and the HUD are installed separately (either may be absent). They find
 * each other through this per-simulation bridge: the player publishes its view state (pointer
 * lock, aim-down-sights, bullet camera) and the HUD publishes its hooks (menu, help, toasts).
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
}

const bridges = new WeakMap<object, Bridge>();

export function bridgeOf(sim: object): Bridge {
  let b = bridges.get(sim);
  if (!b) {
    b = { player: null, hud: null };
    bridges.set(sim, b);
  }
  return b;
}
