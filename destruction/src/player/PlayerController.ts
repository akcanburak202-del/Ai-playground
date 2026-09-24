import * as THREE from 'three';
import type { Simulation } from '../app/Simulation.ts';
import type { Projectile, ShotEvent, SimContext, System, WeaponControllerApi } from '../app/contracts.ts';
import type { AmmoSpec } from '../physics/ballistics/types.ts';
import { groundOf } from '../fx/ground.ts';
import { bridgeOf, type Bridge, type BulletCamView, type PlayerView } from '../ui/bridge.ts';
import { fovForZoom, approach, isFollowable, rampTimeScale, RecoilSpring } from './motion.ts';
import { buildSlots, stepWeapon, weaponForKey, type Slot } from './slots.ts';
import { TouchControls } from './touch.ts';

export interface PlayerOptions {
  canvas?: HTMLCanvasElement;
  /** R key: rebuild the scene (defaults to the HUD's reload) */
  onReload?: () => void;
  /** Force the touch controls on (otherwise: coarse pointer or the first touch) */
  touch?: boolean;
}

/** Fly speeds, m/s */
const WALK = 6;
const SPRINT = 25;
const MIN_HEIGHT = 0.3;
const PITCH_LIMIT = THREE.MathUtils.degToRad(88);
/** Mouse sensitivity at the base field of view, rad per pixel */
const MOUSE_SENS = 0.0021;
const TOUCH_SENS = 0.0048;
const SLOW = 0.1;

const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyE', 'KeyQ', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight']);

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _target = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);

interface BulletCam {
  proj: Projectile;
  id: number;
  ammo: AmmoSpec;
  phase: 'follow' | 'hold' | 'return';
  timer: number;
  start: THREE.Vector3;
  last: THREE.Vector3;
  offset: THREE.Vector3;
  savedPos: THREE.Vector3;
  savedYaw: number;
  savedPitch: number;
  fromPos: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  autoSlow: boolean;
  speed: number;
}

/**
 * The viewer: a free-flying spectator camera with the weapon. Pointer-locked mouse look, WASD
 * flight, aim-down-sights zoom, recoil on the camera, slow motion, and a bullet camera that rides
 * behind rockets, tank rounds and bombs. On phones it is driven by the touch controls.
 *
 * The camera pose belongs to whoever set it last: when something else moves it (a scene load,
 * a scripted `setCamera`), the controller adopts the new pose instead of fighting it.
 */
export class PlayerController implements System, PlayerView {
  readonly name = 'player';
  locked = false;
  ads = 0;
  touch = false;
  lockUnavailable = false;
  slowMo = false;
  bulletCamArmed = false;
  private readonly ctx: SimContext;
  private readonly weapons: WeaponControllerApi;
  private readonly canvas: HTMLCanvasElement;
  private readonly bridge: Bridge;
  private readonly slots: Slot[];
  private readonly opts: PlayerOptions;
  private readonly keys = new Set<string>();
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private mouseDX = 0;
  private mouseDY = 0;
  private wheelAcc = 0;
  private lastWheelStep = 0;
  private adsHeld = false;
  private adsToggle = false;
  private baseFov = 70;
  private lastFov = -1;
  private readonly recoilPitch = new RecoilSpring(16, 0.75);
  private readonly recoilYaw = new RecoilSpring(18, 0.8);
  private readonly lastPos = new THREE.Vector3(NaN, NaN, NaN);
  private readonly lastQuat = new THREE.Quaternion(NaN, NaN, NaN, NaN);
  private triggerHeld = false;
  private triggerOut = false;
  private triggerSince = -1;
  private pulse = false;
  private lockFailures = 0;
  private lockPromised = false;
  private lastTouch = -1e9;
  private lockedAt = -1e9;
  private dragging = false;
  private scaleWritten = 1;
  private frames = 0;
  private touchWasHidden = false;
  private disposed = false;
  private cam: BulletCam | null = null;
  private armedUntil = 0;
  private armedAfterId = 0;
  private touchUi: TouchControls | null = null;
  private listeners: [EventTarget, string, EventListenerOrEventListenerObject, AddEventListenerOptions | boolean | undefined][] = [];
  private unsub: (() => void)[] = [];

  constructor(sim: Simulation, weapons: WeaponControllerApi, opts: PlayerOptions = {}) {
    this.ctx = sim.ctx;
    this.weapons = weapons;
    this.opts = opts;
    this.canvas = opts.canvas ?? sim.ctx.renderer.domElement;
    this.bridge = bridgeOf(sim);
    this.slots = buildSlots(weapons.weapons);
    this.adopt();
    this.bind();
    this.unsub.push(
      this.ctx.events.on('shot', (e) => this.onShot(e)),
      this.ctx.events.on('sceneLoaded', () => {
        this.endBulletCam(true);
        this.releaseAll();
      }),
    );
    this.bridge.player = this;
    if (opts.touch || matchMedia('(pointer: coarse)').matches) this.enableTouch();
  }

  /** Aim down sights on/off (scripts, touch); `instant` skips the zoom animation. */
  setAds(on: boolean, instant = false): void {
    this.adsToggle = on;
    if (instant) {
      this.ads = on ? 1 : 0;
      this.updateFov(0, this.ads);
    }
  }

  get bulletCam(): BulletCamView | null {
    const c = this.cam;
    if (!c || c.phase === 'return') return null;
    return { ammo: c.ammo, speed: c.speed, distance: c.last.distanceTo(c.start), following: c.phase === 'follow' };
  }

  // ─── Input binding ─────────────────────────────────────────────────────────────────────────

  private on<K extends string>(target: EventTarget, type: K, fn: (e: never) => void, o?: AddEventListenerOptions | boolean): void {
    const h = fn as unknown as EventListener;
    target.addEventListener(type, h, o);
    this.listeners.push([target, type, h, o]);
  }

  private bind(): void {
    const c = this.canvas;
    this.on(c, 'mousedown', (e: MouseEvent) => this.onMouseDown(e));
    this.on(window, 'mouseup', (e: MouseEvent) => this.onMouseUp(e));
    this.on(document, 'mousemove', (e: MouseEvent) => this.onMouseMove(e));
    this.on(c, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    this.on(c, 'contextmenu', (e: Event) => e.preventDefault());
    this.on(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    this.on(window, 'keyup', (e: KeyboardEvent) => this.onKeyUp(e));
    this.on(window, 'blur', () => this.releaseAll());
    this.on(document, 'visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    this.on(document, 'pointerlockchange', () => this.onLockChange());
    // Promise-based requests report failures through the promise; the event is for older browsers.
    this.on(document, 'pointerlockerror', () => {
      if (!this.lockPromised) this.onLockError();
    });
    this.on(window, 'touchstart', () => this.enableTouch(), { passive: true, once: true });
    // Mouse events synthesised from a touch arrive right after it: remember when touches happen.
    const touched = () => (this.lastTouch = performance.now());
    this.on(window, 'touchstart', touched, { passive: true, capture: true });
    this.on(window, 'touchend', touched, { passive: true, capture: true });
    // Ctrl+W closes the tab and cannot be intercepted; while playing, ask before leaving.
    this.on(window, 'beforeunload', (e: BeforeUnloadEvent) => {
      if (this.locked) e.preventDefault();
    });
  }

  /** Ask for pointer lock (from a user gesture). On touch-first devices only a real mouse (`force`) asks. */
  requestLock(force = false): void {
    if (this.locked || this.lockUnavailable || (this.touch && !force)) return;
    try {
      const r = (this.canvas.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | void).call(this.canvas, { unadjustedMovement: true });
      this.lockPromised = !!r && typeof (r as Promise<void>).catch === 'function';
      if (this.lockPromised) {
        (r as Promise<void>).catch((err: DOMException) => {
          // Raw input is not supported everywhere: retry with plain pointer lock.
          if (err?.name === 'NotSupportedError') {
            const r2 = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
            r2?.catch?.(() => this.onLockError());
          } else this.onLockError(err);
        });
      }
    } catch {
      this.onLockError();
    }
  }

  private onLockError(err?: DOMException): void {
    // Re-locking within ~1 s of Esc is refused by browsers; that is not a missing capability.
    if (err && /exited|user gesture|activation/i.test(err.message ?? '')) return;
    if (++this.lockFailures >= 2) this.lockUnavailable = true;
  }

  private onLockChange(): void {
    const was = this.locked;
    this.locked = document.pointerLockElement === this.canvas;
    if (this.locked) {
      this.lockFailures = 0;
      this.lockedAt = performance.now();
      this.mouseDX = this.mouseDY = 0;
    } else if (was) {
      this.releaseAll();
      const hud = this.bridge.hud;
      if (hud && !hud.menuOpen) hud.showMenu(true);
    }
  }

  private get menuOpen(): boolean {
    return !!this.bridge.hud?.menuOpen;
  }

  private onMouseDown(e: MouseEvent): void {
    if (this.menuOpen || performance.now() - this.lastTouch < 800) return;
    this.ctx.audio.unlock();
    if (!this.locked && !this.lockUnavailable) {
      this.requestLock(true);
      return;
    }
    if (e.button === 0) this.setTrigger(true);
    else if (e.button === 2) {
      if (this.locked) this.adsHeld = true;
      else this.dragging = true;
    } else if (e.button === 1) {
      e.preventDefault();
      this.cycleAmmo();
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (performance.now() - this.lastTouch < 800 && !this.locked) return;
    if (e.button === 0) this.setTrigger(false);
    else if (e.button === 2) {
      this.adsHeld = false;
      this.dragging = false;
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked && !this.dragging) return;
    let dx = e.movementX, dy = e.movementY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // Some browsers report one huge jump right after the lock engages.
    if (performance.now() - this.lockedAt < 120 && Math.abs(dx) + Math.abs(dy) > 250) return;
    dx = Math.max(-400, Math.min(400, dx));
    dy = Math.max(-400, Math.min(400, dy));
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  private onWheel(e: WheelEvent): void {
    if (this.menuOpen) return;
    e.preventDefault();
    this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    const now = performance.now();
    if (Math.abs(this.wheelAcc) >= 50 && now - this.lastWheelStep > 70) {
      const id = stepWeapon(this.slots, this.weapons.current.id, this.wheelAcc > 0 ? 1 : -1);
      this.wheelAcc = 0;
      this.lastWheelStep = now;
      if (id) this.select(id);
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    // The HUD may have consumed it (menu keys) if its listener ran first.
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (this.menuOpen) return;
    const code = e.code;
    if (MOVE_CODES.has(code)) {
      this.keys.add(code);
      if (code === 'Space' || code.startsWith('Arrow')) e.preventDefault();
    }
    if (code === 'Tab') e.preventDefault();
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (digit) {
      const id = weaponForKey(this.slots, Number(digit[1]), this.weapons.current.id);
      if (id) this.select(id);
      return;
    }
    const hud = this.bridge.hud;
    switch (code) {
      case 'KeyT':
        this.cycleAmmo();
        break;
      case 'KeyF':
      case 'Tab':
        this.toggleSlowMo();
        break;
      case 'KeyG':
        this.demolition();
        break;
      case 'KeyX':
        this.detonate(0);
        break;
      case 'KeyB':
        this.detonate(0.25);
        break;
      case 'KeyC':
        this.toggleBulletCam();
        break;
      case 'KeyR':
        if (this.opts.onReload) this.opts.onReload();
        else hud?.reload();
        break;
      case 'KeyH':
        hud?.toggleHelp();
        break;
      case 'KeyM':
        this.toggleMute();
        break;
      case 'KeyZ':
        this.adsToggle = !this.adsToggle;
        break;
      case 'KeyV':
        hud?.toggleHud();
        break;
      case 'Escape':
        // (While locked the browser takes Esc to release the pointer; the lock change opens the menu.)
        if (this.cam) this.endBulletCam(false);
        else if (hud?.helpOpen) hud.toggleHelp();
        else if (this.locked) document.exitPointerLock();
        else hud?.showMenu(true);
        e.preventDefault();
        break;
      default:
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
  }

  /** Nothing stays pressed when focus, visibility or the pointer lock goes away. */
  releaseAll(): void {
    this.keys.clear();
    this.adsHeld = false;
    this.dragging = false;
    this.mouseDX = this.mouseDY = 0;
    this.triggerHeld = false;
    this.pulse = false;
    this.applyTrigger(false);
    this.touchUi?.release();
  }

  // ─── Actions ───────────────────────────────────────────────────────────────────────────────

  /**
   * Trigger with a latch: a click shorter than one simulation step is held until the weapon
   * controller has seen it (it fires on the press edge inside its fixed step).
   */
  setTrigger(down: boolean): void {
    if (down) {
      if (this.cam) return;
      this.triggerHeld = true;
      this.triggerSince = this.ctx.time.now;
      this.applyTrigger(true);
    } else {
      this.triggerHeld = false;
      if (this.ctx.time.now > this.triggerSince) this.applyTrigger(false);
    }
  }

  private applyTrigger(down: boolean): void {
    if (down === this.triggerOut) return;
    this.triggerOut = down;
    this.weapons.setTrigger(down);
  }

  select(id: string): void {
    if (id === this.weapons.current.id) return;
    this.applyTrigger(false);
    this.weapons.select(id);
    if (this.triggerHeld) this.applyTrigger(true);
  }

  cycleAmmo(): void {
    const before = this.weapons.currentAmmo.id;
    this.weapons.cycleAmmo();
    const a = this.weapons.currentAmmo;
    if (a.id !== before) this.bridge.hud?.toast(`Mühimmat · ${a.name}`);
  }

  toggleSlowMo(): void {
    this.slowMo = !this.slowMo;
    if (this.cam) this.cam.autoSlow = false;
    this.bridge.hud?.toast(this.slowMo ? 'Ağır çekim ×0,10' : 'Gerçek zaman ×1,00', this.slowMo);
  }

  toggleMute(): void {
    const a = this.ctx.audio;
    a.unlock();
    a.setMuted(!a.muted);
    this.bridge.hud?.toast(a.muted ? 'Ses kapalı' : 'Ses açık');
  }

  /** G: switch to the demolition charges, or with them in hand place one on the aimed surface. */
  demolition(): void {
    const demo = this.weapons.weapons.find((w) => w.delivery === 'placed');
    if (!demo) return;
    if (this.weapons.current.id !== demo.id) {
      this.select(demo.id);
      return;
    }
    this.setTrigger(true);
    this.pulse = true;
  }

  detonate(sequence: number): void {
    const n = this.weapons.charges.length;
    if (!n) {
      this.bridge.hud?.toast('Yerleştirilmiş şarj yok');
      return;
    }
    this.weapons.detonate(sequence);
    this.bridge.hud?.toast(sequence > 0 ? `Ateşleme · ${n} şarj sırayla` : `Ateşleme · ${n} şarj`, true);
  }

  private onShot(e: ShotEvent): void {
    if (this.cam || e.weapon.delivery !== 'direct') return;
    // Per-round kick; at very high rates the kicks blur into vibration, so scale by 600 / rpm.
    const rate = Math.min(1, 600 / Math.max(1, e.weapon.rpm));
    const v = 2.4 * e.weapon.recoil * rate;
    this.recoilPitch.kick(v);
    this.recoilYaw.kick((this.ctx.rng.next() - 0.5) * 0.5 * v);
  }

  // ─── Touch ─────────────────────────────────────────────────────────────────────────────────

  private enableTouch(): void {
    if (this.touchUi) return;
    this.touch = true;
    this.touchUi = new TouchControls({
      fire: (down) => this.setTrigger(down),
      nextWeapon: () => {
        const id = stepWeapon(this.slots, this.weapons.current.id, 1);
        if (id) this.select(id);
      },
      cycleAmmo: () => this.cycleAmmo(),
      slowMo: () => this.toggleSlowMo(),
      ads: () => (this.adsToggle = !this.adsToggle),
      detonate: () => this.detonate(0),
      bulletCam: () => this.toggleBulletCam(),
      menu: () => this.bridge.hud?.showMenu(true),
      unlockAudio: () => this.ctx.audio.unlock(),
      state: () => ({ slowMo: this.slowMo, ads: this.adsToggle, charges: this.weapons.charges.length, placed: this.weapons.current.delivery === 'placed', hidden: this.menuOpen }),
    });
  }

  // ─── Per frame ─────────────────────────────────────────────────────────────────────────────

  /** Take over the camera's current pose (scene load, scripted camera, first frame). */
  private adopt(): void {
    const cam = this.ctx.camera;
    this.pos.copy(cam.position);
    _e.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = this.lookYaw = _e.y;
    this.pitch = this.lookPitch = THREE.MathUtils.clamp(_e.x, -PITCH_LIMIT, PITCH_LIMIT);
    this.vel.set(0, 0, 0);
    this.recoilPitch.reset();
    this.recoilYaw.reset();
    if (this.ads < 0.01) this.baseFov = cam.fov;
    this.lastFov = cam.fov;
  }

  frameUpdate(_simDt: number, realDt: number): void {
    if (this.disposed) return;
    const dt = Number.isFinite(realDt) ? Math.min(Math.max(realDt, 0), 0.1) : 0;
    const cam = this.ctx.camera;
    // Somebody else moved the camera since our last write: follow them.
    const same = Math.abs(cam.quaternion.dot(this.lastQuat));
    if (!this.cam && (!(cam.position.distanceToSquared(this.lastPos) < 1e-10) || !(same > 1 - 1e-9))) this.adopt();
    if (cam.fov !== this.lastFov && this.lastFov > 0 && this.ads < 0.01) this.baseFov = cam.fov;

    // Trigger latch: release a short click once the weapon has seen at least one step.
    if (this.triggerOut && (!this.triggerHeld || this.pulse) && this.ctx.time.now > this.triggerSince) {
      this.pulse = false;
      this.triggerHeld = false;
      this.applyTrigger(false);
    }
    if (this.menuOpen && this.triggerOut) this.applyTrigger(false);

    this.updateTimeScale(dt);
    if (this.touchUi && ((++this.frames & 7) === 0 || this.menuOpen !== this.touchWasHidden)) {
      this.touchWasHidden = this.menuOpen;
      this.touchUi.refresh();
    }
    if (this.cam) {
      this.updateBulletCam(dt);
      this.updateFov(dt, 0);
      return;
    }
    if (this.bulletCamArmed) this.watchForBulletCam();

    // Look: mouse / touch deltas scaled by the current zoom so the angular feel stays constant.
    const zoomScale = Math.tan((cam.fov * Math.PI) / 360) / Math.tan((this.baseFov * Math.PI) / 360);
    const touchLook = this.touchUi?.takeLook() ?? null;
    const dx = this.mouseDX * MOUSE_SENS + (touchLook ? touchLook.x * TOUCH_SENS : 0);
    const dy = this.mouseDY * MOUSE_SENS + (touchLook ? touchLook.y * TOUCH_SENS : 0);
    this.mouseDX = this.mouseDY = 0;
    this.lookYaw -= dx * zoomScale;
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * zoomScale, -PITCH_LIMIT, PITCH_LIMIT);
    // Light smoothing (8 ms) removes the stair-stepping of high-rate mice without felt lag.
    this.yaw = approach(this.yaw, this.lookYaw, dt, 0.008);
    this.pitch = approach(this.pitch, this.lookPitch, dt, 0.008);

    // Fly: W/S along the view, A/D level strafe, Space/E up, Q/Ctrl down.
    const k = this.keys;
    const stick = this.touchUi?.move ?? null;
    let f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let u = (k.has('Space') || k.has('KeyE') || this.touchUi?.up ? 1 : 0) - (k.has('KeyQ') || k.has('ControlLeft') || k.has('ControlRight') || this.touchUi?.down ? 1 : 0);
    if (stick) {
      f += stick.y;
      r += stick.x;
    }
    f = THREE.MathUtils.clamp(f, -1, 1);
    r = THREE.MathUtils.clamp(r, -1, 1);
    u = THREE.MathUtils.clamp(u, -1, 1);
    _e.set(this.pitch, this.yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _move.set(0, 0, 0).addScaledVector(_fwd, f).addScaledVector(_right, r).addScaledVector(UP, u);
    if (_move.lengthSq() > 1) _move.normalize();
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = (sprint ? SPRINT : WALK) * (this.ads > 0.5 ? 0.5 : 1);
    _target.copy(_move).multiplyScalar(speed);
    const a = 1 - Math.exp(-dt / 0.12);
    this.vel.lerp(_target, a);
    this.pos.addScaledVector(this.vel, dt);
    const floor = groundOf(this.ctx.scene).heightAt(this.pos.x, this.pos.z) + MIN_HEIGHT;
    if (!(this.pos.y >= floor)) {
      this.pos.y = Number.isFinite(floor) ? floor : MIN_HEIGHT;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    this.updateFov(dt, this.adsHeld || this.adsToggle ? 1 : 0);
    const kp = this.recoilPitch.update(dt);
    const ky = this.recoilYaw.update(dt);
    cam.position.copy(this.pos);
    cam.rotation.set(THREE.MathUtils.clamp(this.pitch + kp, -PITCH_LIMIT, PITCH_LIMIT), this.yaw + ky, 0, 'YXZ');
    this.commit();
  }

  private commit(): void {
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this.lastPos.copy(cam.position);
    this.lastQuat.copy(cam.quaternion);
  }

  private updateFov(dt: number, adsTarget: number): void {
    const cam = this.ctx.camera;
    this.ads = approach(this.ads, adsTarget, dt, 0.06);
    if (this.ads < 1e-3) this.ads = 0;
    if (this.ads > 0.999) this.ads = 1;
    const zoom = 1 + (Math.max(1, this.weapons.current.zoom) - 1) * this.ads;
    const fov = fovForZoom(this.baseFov, zoom);
    if (Math.abs(fov - cam.fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this.lastFov = cam.fov;
  }

  private updateTimeScale(dt: number): void {
    const t = this.ctx.time;
    // Adopt a time scale set by someone else (sandbox, script).
    if (Math.abs(t.scale - this.scaleWritten) > 1e-6) this.slowMo = t.scale < 0.5;
    const target = this.slowMo || this.cam?.autoSlow ? SLOW : 1;
    if (t.scale !== target) t.scale = rampTimeScale(t.scale, target, dt);
    this.scaleWritten = t.scale;
  }

  // ─── Bullet camera ─────────────────────────────────────────────────────────────────────────

  private candidate(afterId: number): Projectile | null {
    let best: Projectile | null = null;
    for (const p of this.ctx.projectiles.active) {
      if (!p.alive || p.id <= afterId) continue;
      if (!isFollowable(p.ammo, p.velocity.length())) continue;
      if (!best || p.id > best.id) best = p;
    }
    return best;
  }

  toggleBulletCam(): void {
    if (this.cam) {
      this.endBulletCam(false);
      return;
    }
    if (this.bulletCamArmed) {
      this.bulletCamArmed = false;
      return;
    }
    const p = this.candidate(0);
    if (p) this.startBulletCam(p);
    else {
      this.bulletCamArmed = true;
      this.armedUntil = performance.now() + 6000;
      this.armedAfterId = this.ctx.projectiles.active.reduce((m, x) => Math.max(m, x.id), 0);
    }
  }

  private watchForBulletCam(): void {
    if (performance.now() > this.armedUntil) {
      this.bulletCamArmed = false;
      return;
    }
    const p = this.candidate(this.armedAfterId);
    if (p) {
      this.bulletCamArmed = false;
      this.startBulletCam(p);
    }
  }

  private startBulletCam(p: Projectile): void {
    const cam = this.ctx.camera;
    this.applyTrigger(false);
    this.triggerHeld = false;
    const speed = p.velocity.length();
    this.cam = {
      proj: p, id: p.id, ammo: p.ammo, phase: 'follow', timer: 0,
      start: p.position.clone(), last: p.position.clone(),
      offset: cam.position.clone().sub(p.position),
      savedPos: this.pos.clone(), savedYaw: this.yaw, savedPitch: this.pitch,
      fromPos: new THREE.Vector3(), fromQuat: new THREE.Quaternion(),
      // Fast rounds are only watchable in slow motion.
      autoSlow: !this.slowMo && speed > 450,
      speed,
    };
  }

  private updateBulletCam(dt: number): void {
    const c = this.cam!;
    const cam = this.ctx.camera;
    const p = c.proj;
    if (c.phase === 'follow') {
      if (!p.alive || p.id !== c.id) {
        c.phase = 'hold';
        c.timer = 1.8;
      } else {
        c.last.copy(p.position);
        c.speed = p.velocity.length();
        const dir = _fwd.copy(p.velocity);
        if (c.speed > 1) dir.divideScalar(c.speed);
        else dir.set(0, -1, 0);
        // Ride behind and a little above/right of the round; the offset (not the position) is
        // smoothed, so the camera keeps up at any speed and swings round when the round turns.
        const back = 2.5 + 3 * Math.min(2.5, p.ammo.length);
        _target.copy(dir).multiplyScalar(-back);
        _right.crossVectors(dir, UP);
        if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
        _right.normalize();
        _target.addScaledVector(UP, 0.6 + 0.15 * back).addScaledVector(_right, 0.35 * back);
        c.offset.lerp(_target, 1 - Math.exp(-dt / 0.12));
        cam.position.copy(p.position).add(c.offset);
        _move.copy(p.position).addScaledVector(dir, 6);
        this.lookAt(_move);
      }
    }
    if (c.phase === 'hold') {
      // Watch the impact: pull back slowly from where the round ended.
      c.timer -= dt;
      _move.copy(cam.position).sub(c.last);
      const d = _move.length();
      if (d < 14) cam.position.addScaledVector(_move.normalize(), dt * 3);
      this.lookAt(c.last);
      if (c.timer <= 0) {
        c.phase = 'return';
        c.timer = 0.55;
        c.fromPos.copy(cam.position);
        c.fromQuat.copy(cam.quaternion);
        c.autoSlow = false;
      }
    }
    if (c.phase === 'return') {
      c.timer -= dt;
      const s = THREE.MathUtils.smoothstep(1 - Math.max(0, c.timer) / 0.55, 0, 1);
      _e.set(c.savedPitch, c.savedYaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      cam.position.lerpVectors(c.fromPos, c.savedPos, s);
      cam.quaternion.slerpQuaternions(c.fromQuat, _q, s);
      if (c.timer <= 0) this.endBulletCam(true);
    }
    this.commit();
  }

  private lookAt(p: THREE.Vector3): void {
    const cam = this.ctx.camera;
    _m.lookAt(cam.position, p, UP);
    cam.quaternion.setFromRotationMatrix(_m);
  }

  /** Leave the bullet camera; `instant` snaps back to the saved pose. */
  endBulletCam(instant: boolean): void {
    const c = this.cam;
    if (!c) {
      this.bulletCamArmed = false;
      return;
    }
    if (!instant && c.phase !== 'return') {
      c.phase = 'return';
      c.timer = 0.45;
      c.fromPos.copy(this.ctx.camera.position);
      c.fromQuat.copy(this.ctx.camera.quaternion);
      c.autoSlow = false;
      return;
    }
    this.cam = null;
    const cam = this.ctx.camera;
    this.pos.copy(c.savedPos);
    this.yaw = this.lookYaw = c.savedYaw;
    this.pitch = this.lookPitch = c.savedPitch;
    this.vel.set(0, 0, 0);
    cam.position.copy(this.pos);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.commit();
  }

  reset(): void {
    this.endBulletCam(true);
  }

  dispose(): void {
    this.disposed = true;
    this.releaseAll();
    for (const [t, type, h, o] of this.listeners) t.removeEventListener(type, h, o);
    this.listeners = [];
    for (const u of this.unsub) u();
    this.unsub = [];
    this.touchUi?.dispose();
    this.touchUi = null;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (this.bridge.player === this) this.bridge.player = null;
  }
}
