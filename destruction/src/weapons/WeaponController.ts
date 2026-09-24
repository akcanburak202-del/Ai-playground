import * as THREE from 'three';
import type { Simulation } from '../app/Simulation.ts';
import type { ChargeEvent, SimContext, SpawnProjectileOptions, System, WeaponControllerApi, WeaponSpec } from '../app/contracts.ts';
import type { Rng } from '../core/rng.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import type { AmmoData } from '../physics/ballistics/ammo.ts';
import { planArrival } from '../physics/ballistics/flight.ts';
import type { AmmoSpec } from '../physics/ballistics/types.ts';
import { ProjectileSystem } from '../systems/ProjectileSystem.ts';
import type { ExtendedBlastRequest } from '../systems/BlastSystem.ts';
import { PLAY_RELOAD_SCALE, WEAPONS, getWeapon, type WeaponData } from './arsenal.ts';

/** 1 MOA in radians */
const MOA = (1 / 60) * (Math.PI / 180);

interface PlacedCharge {
  event: ChargeEvent;
  ammo: AmmoData;
  target: Destructible | null;
  /** In-surface direction of a linear charge */
  along: THREE.Vector3;
}

const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The viewer's weapon. Each fixed step it reads the camera pose, finds where the aim ray meets
 * the world, and fires at the weapon's cyclic rate while the trigger is held (rounds are spaced
 * inside the step, so a 3 900 rpm GAU-8 puts one round every 15 ms however long the step is).
 * The shot line starts at the camera so rounds land under the crosshair; the muzzle offset only
 * places the muzzle flash. Indirect weapons bring the round in from the sky onto the aim point;
 * placed charges stick to the aimed surface and wait for the detonator.
 */
export class WeaponController implements WeaponControllerApi, System {
  readonly name = 'weapons';
  readonly weapons: readonly WeaponData[] = WEAPONS;
  current: WeaponData;
  currentAmmo: AmmoSpec;
  roundsFired = 0;
  aimPoint: THREE.Vector3 | null = null;
  /** Surface normal and target under the crosshair (charge placement) */
  aimNormal = new THREE.Vector3(0, 1, 0);
  aimTarget: Destructible | null = null;
  private readonly ctx: SimContext;
  private readonly sim: Simulation;
  private readonly rng: Rng;
  private trigger = false;
  private wasDown = false;
  /**
   * A press that has not fired yet: a single-shot weapon fires as soon as it is ready while the
   * trigger stays held (a click during the last moments of a reload is not lost), and needs a new
   * press for the next round.
   */
  private armed = false;
  /**
   * Reload / cycling time left per weapon, s. Each weapon keeps its own: switching from the tank
   * gun to the RPG does not carry the gun's reload over, and a weapon reloads while holstered.
   */
  private readonly cooldowns = new Map<string, number>();
  /** Time until the next automatic round may fire, s (may go negative inside a step) */
  private nextShot = 0;
  private spin = 0;
  private tracerCount = 0;
  private mixCount = 0;
  private placed: PlacedCharge[] = [];
  private chargeEvents: ChargeEvent[] = [];
  private fuses: { time: number; charge: PlacedCharge }[] = [];
  private nextChargeId = 1;
  private aim = new THREE.Vector3();
  /** Length of the fixed step being simulated (rounds are timed inside it) */
  private stepDt = 0;
  /** Reused spawn options: the projectile system copies what it needs, so nothing is allocated per round */
  private readonly spawnOpts: SpawnProjectileOptions & { origin: THREE.Vector3; velocity: THREE.Vector3; target?: THREE.Vector3 } = {
    ammo: null as unknown as AmmoSpec, origin: new THREE.Vector3(), velocity: new THREE.Vector3(), tracer: false, target: undefined,
  };
  private readonly spawnTarget = new THREE.Vector3();

  constructor(sim: Simulation) {
    this.sim = sim;
    this.ctx = sim.ctx;
    this.rng = sim.ctx.rng.fork();
    this.current = WEAPONS[0]!;
    this.currentAmmo = this.ctx.ammo(this.current.ammo[0]!);
  }

  get charges(): readonly ChargeEvent[] {
    return this.chargeEvents;
  }

  /** Seconds until the current weapon can fire again (its own reload / cycling). */
  get cooldown(): number {
    return this.cooldowns.get(this.current.id) ?? 0;
  }

  /** Trigger currently held (rotary guns spin while it is). */
  get triggerDown(): boolean {
    return this.trigger;
  }

  private setCooldown(seconds: number): void {
    this.cooldowns.set(this.current.id, Math.max(0, seconds));
  }

  select(weaponId: string): void {
    const w = getWeapon(weaponId);
    if (w === this.current) return;
    this.current = w;
    this.currentAmmo = this.ctx.ammo(w.ammo[0]!);
    this.nextShot = 0;
    this.spin = 0;
    // A press made with the previous weapon does not fire the new one.
    this.armed = false;
    this.wasDown = this.trigger;
  }

  setAmmo(ammoId: string): void {
    if (!this.current.ammo.includes(ammoId)) return;
    this.currentAmmo = this.ctx.ammo(ammoId);
  }

  cycleAmmo(): void {
    const list = this.current.ammo;
    const i = list.indexOf(this.currentAmmo.id);
    this.currentAmmo = this.ctx.ammo(list[(i + 1) % list.length]!);
  }

  setTrigger(down: boolean): void {
    this.trigger = down;
    if (!down) this.armed = false;
  }

  detonate(sequenceDelay = 0): void {
    const now = this.ctx.time.now;
    this.placed.forEach((c, i) => this.fuses.push({ time: now + i * Math.max(0, sequenceDelay), charge: c }));
    this.placed = [];
  }

  reset(): void {
    this.placed = [];
    this.chargeEvents = [];
    this.fuses = [];
    this.roundsFired = 0;
    this.cooldowns.clear();
    this.nextShot = 0;
    this.spin = 0;
    this.trigger = false;
    this.wasDown = false;
    this.armed = false;
    this.aimPoint = null;
  }

  fixedUpdate(dt: number): void {
    this.stepDt = dt;
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    cam.getWorldPosition(_pos);
    cam.getWorldDirection(_fwd);
    _right.crossVectors(_fwd, UP);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _fwd);
    this.updateAim();
    // Every weapon's reload runs, held or holstered.
    for (const [id, c] of this.cooldowns) if (c > 0) this.cooldowns.set(id, Math.max(0, c - dt));
    this.runFuses();

    const w = this.current;
    if (this.trigger && !this.wasDown) this.armed = true;
    this.wasDown = this.trigger;
    const ready = this.armed && this.cooldown <= 0;
    if (w.delivery === 'placed') {
      if (ready) {
        this.armed = false;
        this.placeCharge();
      }
      return;
    }
    if (w.delivery === 'indirect') {
      if (ready && this.aimPoint) {
        this.armed = false;
        this.callFire();
        this.setCooldown((w.reloadTime ?? 10) * PLAY_RELOAD_SCALE);
      }
      return;
    }
    if (w.fireMode === 'auto') {
      if (!this.trigger) {
        this.spin = Math.max(0, this.spin - dt);
        this.nextShot = Math.max(this.nextShot - dt, 0);
        return;
      }
      if (this.cooldown > 0) return;
      // Rotary guns fire once the barrels are up to speed.
      let t = 0;
      if (w.spinUp) {
        const need = w.spinUp - this.spin;
        this.spin = Math.min(w.spinUp, this.spin + dt);
        if (need >= dt) return;
        t = Math.max(0, need);
      }
      const interval = 60 / w.rpm;
      if (this.nextShot < t) this.nextShot = t;
      while (this.nextShot < dt) {
        this.fireRound(this.nextShot);
        this.nextShot += interval;
      }
      this.nextShot -= dt;
      return;
    }
    if (ready) {
      this.armed = false;
      this.fireRound(0);
      this.setCooldown(w.fireMode === 'semi' ? 60 / w.rpm : (w.reloadTime ?? 60 / w.rpm) * PLAY_RELOAD_SCALE);
    }
  }

  /** Aim ray from the camera: first destructible, else loose bodies / ground plane y = 0. */
  private updateAim(): void {
    const hit = this.ctx.registry.raycast(_pos, _fwd, 3000);
    if (hit) {
      this.aim.copy(hit.point);
      this.aimNormal.copy(hit.normal);
      this.aimTarget = hit.target;
      this.aimPoint = this.aim;
      return;
    }
    this.aimTarget = null;
    const phys = this.ctx.physics.castRay(_pos, _fwd, 3000);
    if (phys) {
      this.aim.copy(phys.point);
      this.aimNormal.copy(phys.normal);
      this.aimPoint = this.aim;
      return;
    }
    if (_fwd.y < -1e-3) {
      const s = -_pos.y / _fwd.y;
      this.aim.copy(_pos).addScaledVector(_fwd, s);
      this.aimNormal.set(0, 1, 0);
      this.aimPoint = this.aim;
      return;
    }
    this.aimPoint = null;
  }

  private projectileSystem(): ProjectileSystem | null {
    const p = this.ctx.projectiles;
    return p instanceof ProjectileSystem ? p : null;
  }

  /**
   * One direct-fire round, `delay` seconds into the current step. The step being simulated spans
   * [now − dt, now], so the round leaves at now − dt + delay: the projectile system flies it from
   * that moment whether it runs before or after this system.
   */
  private fireRound(delay: number): void {
    const w = this.current;
    let ammo = this.currentAmmo as AmmoData;
    if (w.mix && ammo.id === w.ammo[0] && ++this.mixCount % w.mix.every === 0) ammo = this.ctx.ammo(w.mix.ammo) as AmmoData;
    // Normal jitter per axis (σ = dispersion in MOA).
    const sigma = w.dispersionMOA * MOA;
    _dir.copy(_fwd);
    if (sigma > 0) _dir.addScaledVector(_right, this.rng.gaussian(0, sigma)).addScaledVector(_up, this.rng.gaussian(0, sigma)).normalize();
    // The top-attack launcher needs an aim point: its arc is scripted from the muzzle to that point
    // (ProjectileSystem → LoftPath); with nothing under the crosshair it flies straight.
    const tracer = !!ammo.tracer || (w.tracerEvery > 0 && ++this.tracerCount % w.tracerEvery === 0);
    const opts = this.spawnOpts;
    opts.ammo = ammo;
    opts.origin.copy(_pos).addScaledVector(_dir, 0.05);
    opts.velocity.copy(_dir).multiplyScalar(ammo.muzzleVelocity);
    opts.tracer = tracer;
    opts.target = this.aimPoint ? this.spawnTarget.copy(this.aimPoint) : undefined;
    const t = this.ctx.time.now - this.stepDt + delay;
    const ps = this.projectileSystem();
    if (ps) ps.spawnAt(opts, t);
    else this.ctx.projectiles.spawn({ ...opts, origin: opts.origin.clone(), velocity: opts.velocity.clone(), target: opts.target?.clone() });
    this.roundsFired++;
    this.ctx.events.emit('shot', { time: t, weapon: w as WeaponSpec, ammo, origin: this.muzzle(), direction: _dir.clone() });
  }

  private muzzle(): THREE.Vector3 {
    // (right, up, forward) from the eye; the table's negative y puts the muzzle below the eye.
    const [r, u, f] = this.current.muzzleOffset;
    return _pos.clone().addScaledVector(_right, r).addScaledVector(_up, u).addScaledVector(_fwd, f);
  }

  /**
   * Indirect fire: plan the last seconds of the trajectory backwards from the (dispersed) aim point
   * with the real impact speed and descent angle, arriving from the viewer's side.
   */
  private callFire(): void {
    const w = this.current;
    const ind = w.indirect!;
    const ammo = this.currentAmmo as AmmoData;
    const target = this.aimPoint!.clone();
    target.x += this.rng.gaussian(0, ind.errorM);
    target.z += this.rng.gaussian(0, ind.errorM);
    const h = _fwd.clone().setY(0);
    if (h.lengthSq() < 1e-6) h.set(0, 0, -1);
    h.normalize();
    const a = THREE.MathUtils.degToRad(ind.descentDeg);
    const vImp = h.multiplyScalar(Math.cos(a) * ind.impactSpeed).addScaledVector(UP, -Math.sin(a) * ind.impactSpeed);
    const plan = planArrival(ammo, target, vImp, ind.height, ind.maxTime);
    this.ctx.projectiles.spawn({ ammo, origin: plan.position, velocity: plan.velocity, tracer: false, target });
    this.roundsFired++;
    this.ctx.events.emit('shot', { time: this.ctx.time.now, weapon: w, ammo, origin: plan.position.clone(), direction: plan.velocity.clone().normalize() });
  }

  private placeCharge(): void {
    const w = this.current;
    const p = this.aimPoint;
    if (!p || p.distanceTo(_pos) > (w.placeRange ?? 80)) return;
    const ammo = this.currentAmmo as AmmoData;
    const n = this.aimNormal.clone().normalize();
    const along = _right.clone().addScaledVector(n, -_right.dot(n));
    if (along.lengthSq() < 1e-6) along.set(1, 0, 0).addScaledVector(n, -n.x);
    along.normalize();
    const event: ChargeEvent = {
      time: this.ctx.time.now, id: this.nextChargeId++, position: p.clone().addScaledVector(n, 0.03), normal: n,
      tntKg: ammo.explosiveTNT ?? 0, label: ammo.name,
    };
    this.placed.push({ event, ammo, target: this.aimTarget, along });
    this.chargeEvents = [...this.chargeEvents, event];
    this.setCooldown((w.reloadTime ?? 1) * PLAY_RELOAD_SCALE);
    this.ctx.events.emit('chargePlaced', event);
  }

  private runFuses(): void {
    if (!this.fuses.length) return;
    const now = this.ctx.time.now;
    const left: typeof this.fuses = [];
    for (const f of this.fuses) {
      if (f.time <= now) this.fire(f.charge, Math.max(f.time, now - this.stepDt));
      else left.push(f);
    }
    this.fuses = left;
  }

  /** Fire one placed charge; `time` is when its detonator fired (inside the current step). */
  private fire(c: PlacedCharge, time: number): void {
    const { event, ammo } = c;
    const ps = this.projectileSystem();
    if (ammo.linearCut && ps) {
      // Linear shaped charge: a blade jet along the charge, resolved as closely spaced jets.
      const n = event.normal;
      const inward = n.clone().negate();
      const L = ammo.linearCut.length;
      const count = 9;
      for (let i = 0; i < count; i++) {
        const s = (i / (count - 1) - 0.5) * L;
        const o = event.position.clone().addScaledVector(c.along, s).addScaledVector(n, 0.02);
        ps.jet(ammo, ammo.linearCut.depthRHA, ammo.heatConeDiameter ?? 0.02, o, inward, 'cutting jet', 0.15, time);
      }
    }
    if ((ammo.explosiveTNT ?? 0) > 0) {
      const req: ExtendedBlastRequest = {
        center: event.position.clone(), tntKg: ammo.explosiveTNT!, kind: ammo.linearCut ? 'shaped' : 'contact', normal: event.normal.clone(),
        contactTargetId: c.target?.id, source: ammo, label: ammo.name, time,
      };
      this.ctx.blasts.detonate(req);
    }
    this.chargeEvents = this.chargeEvents.filter((e) => e.id !== event.id);
    this.ctx.events.emit('chargeRemoved', { id: event.id });
  }

  /** Access for tests/sandboxes */
  get simulation(): Simulation {
    return this.sim;
  }
}
