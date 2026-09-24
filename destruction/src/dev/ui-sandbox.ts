import * as THREE from 'three';
import { createSandbox } from './sandboxKit.ts';
import type { Simulation } from '../app/Simulation.ts';
import type {
  ChargeEvent, FxApi, GlassPaneSpec, RenderPipelineApi, SceneDef, SimContext, SteelBeamSpec, SteelPlateSpec, System, VoxelElementSpec,
  WeaponControllerApi, WeaponSpec,
} from '../app/contracts.ts';
import { allocateDestructibleId, rayBoxEntry, type Destructible, type RayHit } from '../destructibles/Destructible.ts';
import { MATERIALS, type MaterialId, type MaterialProps } from '../physics/materials.ts';
import type { AmmoSpec, BlastKind, BlastLoad, ImpactEvent, ImpactOutcome, ThicknessProbe } from '../physics/ballistics/types.ts';
import { installAudio, renderOfflineTest, type AudioSystem } from '../audio/index.ts';
import { installPlayer, type PlayerController } from '../player/index.ts';
import { installHud, ensureFonts, type Hud } from '../ui/index.ts';
import type { HitGroups } from '../ui/telemetry.ts';

/**
 * UI sandbox: BasicPipeline and a few blocks, the M6 stack (audio, player, HUD + menu) driven by
 * a small mock weapon controller that emits real-shaped shot / impact / blast events — or, with
 * `?real`, the real ballistics and weapon controller. `window.__ui` scripts screenshots:
 * synthetic telemetry, menu / help / scope states, the offline audio render test and timing.
 *
 * `?full` is the integration check: M5's production pipeline, effects and terrain, the real
 * ballistics and weapon controller, and real voxel / steel / glass elements on the range — the
 * HUD over the real look, and the hit-group readout over real progressive damage.
 *
 * URL: `?real` real weapons · `?full` real everything · `?touch` force touch controls ·
 * `?menu=0` start without the menu · `?q=0|1|2` pipeline quality (full).
 */

const params = new URLSearchParams(location.search);
const FULL = params.has('full');
const REAL = FULL || params.has('real');

// Optional modules for `?full`: each one missing degrades the range instead of breaking it.
type Factory<S> = (ctx: SimContext, spec: S) => Destructible;
const optional = async <T>(what: string, load: () => Promise<T>): Promise<T | null> => {
  try {
    return await load();
  } catch (err) {
    console.warn(`ui sandbox: ${what} unavailable`, err);
    return null;
  }
};
const mods = {
  Pipeline: null as (new (o: { quality?: 0 | 1 | 2 }) => RenderPipelineApi) | null,
  installFx: null as ((sim: Simulation) => FxApi) | null,
  terrain: null as ((ctx: SimContext, opts?: { plaza?: { halfX: number; halfZ: number; finish: 'pavers' | 'travertine' | 'concrete' } }) => Destructible) | null,
  voxel: null as Factory<VoxelElementSpec> | null,
  plate: null as Factory<SteelPlateSpec> | null,
  beam: null as Factory<SteelBeamSpec> | null,
  glass: null as Factory<GlassPaneSpec> | null,
};
if (FULL) {
  mods.Pipeline = await optional('pipeline', async () => (await import('../render/Pipeline.ts')).Pipeline as unknown as typeof mods.Pipeline);
  mods.installFx = await optional('fx', async () => (await import('../fx/index.ts')).installFx);
  mods.terrain = await optional('terrain', async () => (await import('../destructibles/terrain/index.ts')).createTerrain as unknown as typeof mods.terrain);
  mods.voxel = await optional('voxel', async () => (await import('../destructibles/voxel/index.ts')).createVoxelElement);
  const steel = await optional('steel', async () => await import('../destructibles/steel/index.ts'));
  mods.plate = steel?.createSteelPlate ?? null;
  mods.beam = steel?.createSteelBeam ?? null;
  mods.glass = await optional('glass', async () => (await import('../destructibles/glass/index.ts')).createGlassPane);
}

/** Static box that projectiles and the aim ray can hit (it does not change shape). */
class Block implements Destructible {
  readonly id = allocateDestructibleId();
  readonly kind: Destructible['kind'];
  readonly root = new THREE.Object3D();
  readonly bounds: THREE.Box3;
  readonly disposed = false;
  readonly name: string;
  readonly material: MaterialProps;
  constructor(name: string, box: THREE.Box3, material: MaterialProps, kind: Destructible['kind']) {
    this.name = name;
    this.bounds = box.clone();
    this.material = material;
    this.kind = kind;
  }
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    const t = rayBoxEntry(this.bounds, origin, dir, maxDist);
    if (!Number.isFinite(t) || t > maxDist) return null;
    const point = origin.clone().addScaledVector(dir, t);
    const b = this.bounds, e = 1e-4;
    const normal = new THREE.Vector3(
      Math.abs(point.x - b.min.x) < e ? -1 : Math.abs(point.x - b.max.x) < e ? 1 : 0,
      Math.abs(point.y - b.min.y) < e ? -1 : Math.abs(point.y - b.max.y) < e ? 1 : 0,
      Math.abs(point.z - b.min.z) < e ? -1 : Math.abs(point.z - b.max.z) < e ? 1 : 0,
    );
    if (normal.lengthSq() === 0) normal.copy(dir).negate();
    return { target: this, point, normal: normal.normalize(), distance: t, material: this.material };
  }
  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    const o = hit.point, lo = this.bounds.min, hi = this.bounds.max;
    let tExit = Infinity;
    for (const a of ['x', 'y', 'z'] as const) {
      const inv = 1 / dir[a];
      tExit = Math.min(tExit, Math.max((lo[a] - o[a]) * inv, (hi[a] - o[a]) * inv));
    }
    const end = Math.max(1e-4, Math.min(tExit, maxDepth));
    return { segments: [{ material: this.material, start: 0, end, strength: 1 }], exits: tExit <= maxDepth };
  }
  applyImpact(): void {}
  applyBlast(_l: BlastLoad): void {}
  dispose(): void {}
}

const disposables: { dispose(): void }[] = [];

function addBlock(ctx: SimContext, name: string, size: [number, number, number], pos: [number, number, number], mat: MaterialId, look: THREE.Material): void {
  const geo = new THREE.BoxGeometry(...size);
  disposables.push(geo);
  const m = new THREE.Mesh(geo, look);
  m.position.set(...pos);
  m.castShadow = m.receiveShadow = true;
  ctx.world.add(m);
  const kind: Destructible['kind'] = MATERIALS[mat].class === 'glass' ? 'glass' : MATERIALS[mat].class === 'ductile' ? (size[1] > 2.5 * Math.max(size[0], size[2]) && Math.min(...size) > 0.1 ? 'beam' : 'plate') : 'voxel';
  ctx.addDestructible(new Block(name, new THREE.Box3().setFromObject(m), MATERIALS[mat], kind));
}

const looks = {
  concrete: new THREE.MeshStandardMaterial({ color: 0xbdb8ae, roughness: 0.88 }),
  marble: new THREE.MeshStandardMaterial({ color: 0xece8e0, roughness: 0.35 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x5b5f64, roughness: 0.45, metalness: 0.85 }),
  corten: new THREE.MeshStandardMaterial({ color: 0x6e3b22, roughness: 0.7, metalness: 0.4 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xcfe3e6, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.28 }),
  travertine: new THREE.MeshStandardMaterial({ color: 0xd8ccb2, roughness: 0.8 }),
};
disposables.push(...Object.values(looks));

function buildBase(ctx: SimContext): void {
  addBlock(ctx, 'wall', [8, 4, 0.4], [0, 2, 0], 'concrete', looks.concrete);
  addBlock(ctx, 'steel plate', [1.6, 2, 0.02], [-2.6, 1, 3], 'steel_s355', looks.corten);
  addBlock(ctx, 'pane', [1.8, 2.4, 0.012], [0.4, 1.2, 3.4], 'glass_tempered', looks.glass);
  addBlock(ctx, 'column', [0.5, 4, 0.5], [3.2, 2, 3], 'marble', looks.marble);
}

/**
 * The integration range: a reinforced board-formed concrete wall (the burst target), a welded
 * 12 mm S355 plate, a framed tempered pane and a loaded HEB 300 column, on a concrete plaza.
 * Falls back to plain blocks for any element module that is missing.
 */
function buildFull(ctx: SimContext): void {
  mods.terrain?.(ctx, { plaza: { halfX: 30, halfZ: 20, finish: 'concrete' } });
  if (mods.voxel) {
    const wall = mods.voxel(ctx, {
      name: 'RC duvar', material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [5, 3, 0.25] }, position: [0, 1.5, 0],
      rebar: { diameter: 0.012, spacing: 0.15, cover: 0.03, layout: 'two-faces' },
    });
    const b = wall.bounds;
    ctx.structure.link('ground', wall, new THREE.Box3(new THREE.Vector3(b.min.x, -0.05, b.min.z), new THREE.Vector3(b.max.x, 0.06, b.max.z)));
  } else addBlock(ctx, 'wall', [5, 3, 0.25], [0, 1.5, 0], 'concrete', looks.concrete);
  if (mods.plate) mods.plate(ctx, { name: 'S355 levha 12 mm', material: 'steel_s355', width: 1.2, height: 1.2, thickness: 0.012, position: [-4.2, 1.3, 2], edges: { top: true, bottom: true, left: true, right: true }, finish: 'mill-scale' });
  else addBlock(ctx, 'steel plate', [1.2, 1.2, 0.012], [-4.2, 1.3, 2], 'steel_s355', looks.steel);
  if (mods.glass) mods.glass(ctx, { name: 'temperli cam', type: 'tempered', width: 1.6, height: 2.2, thickness: 0.012, position: [4.2, 1.2, 2], framed: true });
  else addBlock(ctx, 'pane', [1.6, 2.2, 0.012], [4.2, 1.2, 2], 'glass_tempered', looks.glass);
  if (mods.beam) {
    const col = mods.beam(ctx, { name: 'HEB 300 kolon', material: 'steel_s355', profile: { type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 }, start: [7, 0.02, -1.5], end: [7, 4, -1.5], up: [0, 0, 1], ends: { start: 'fixed', end: 'pinned' }, finish: 'painted', paintColor: 0x8a2a1c });
    col.structural?.setImposedLoad(1.2e6);
  }
}

const MOCK_SCENES: SceneDef[] = [
  {
    id: 'proving-ground', name: 'Proving ground', nameTr: 'Atış poligonu',
    blurb: 'Calibration targets', blurbTr: 'Kalibrasyon hedefleri: C40 beton blok, S355 ve RHA levhalar, temperli cam. Modelleri tek tek sına.',
    spawn: { position: [0, 1.7, 14], lookAt: [0, 1.6, 0] }, build: FULL ? buildFull : buildBase,
  },
  {
    id: 'chapel', name: 'Chapel of Light', nameTr: 'Işık Şapeli',
    blurb: 'Board-formed concrete chapel', blurbTr: 'Tadao Ando çizgisinde kalıp izli brüt beton; sunak duvarını kesen ışık haçı ve 15° açılı serbest duvar.',
    spawn: { position: [4, 1.7, 12], lookAt: [0, 2, 0] },
    build(ctx) {
      addBlock(ctx, 'chapel wall', [10, 6, 0.45], [0, 3, 0], 'concrete', looks.concrete);
      addBlock(ctx, 'free wall', [0.35, 4, 9], [-4, 2, 4], 'concrete', looks.concrete);
    },
  },
  {
    id: 'pavilion', name: 'Barcelona-style pavilion', nameTr: 'Barselona pavyonu',
    blurb: 'Travertine, chrome, glass, onyx', blurbTr: 'Mies van der Rohe esintisi: traverten plint, krom kaplı haç kesitli kolonlar, cam paneller, oniks duvar ve ince çatı döşemesi.',
    spawn: { position: [0, 1.7, 13], lookAt: [0, 1.5, 0] },
    build(ctx) {
      addBlock(ctx, 'plinth', [16, 0.4, 8], [0, 0.2, 0], 'travertine', looks.travertine);
      addBlock(ctx, 'glass 1', [3, 3, 0.012], [-2, 1.9, 1], 'glass_tempered', looks.glass);
      addBlock(ctx, 'column', [0.2, 3.2, 0.2], [2, 2, 1], 'stainless', looks.steel);
    },
  },
  {
    id: 'tower', name: 'Steel-frame tower', nameTr: 'Çelik iskeletli kule',
    blurb: 'Steel frame with a glass curtain wall', blurbTr: 'Cam giydirme cepheli çelik çerçeve: I kesitli kolonlar, rüzgâr çaprazları ve kat döşemeleri.',
    spawn: { position: [6, 2, 18], lookAt: [0, 6, 0] },
    build(ctx) {
      addBlock(ctx, 'core', [6, 14, 6], [0, 7, 0], 'concrete', looks.concrete);
      addBlock(ctx, 'column', [0.4, 14, 0.4], [3.6, 7, 3.6], 'steel_s355', looks.steel);
    },
  },
  {
    id: 'temple', name: 'Doric temple', nameTr: 'Dor tapınağı',
    blurb: 'Marble drum columns', blurbTr: 'Tamburlardan örülmüş yivli mermer kolonlar, arşitrav ve alınlık; harçsız taş yığma, yalnızca ağırlıkla ayakta.',
    spawn: { position: [0, 1.7, 16], lookAt: [0, 3, 0] },
    build(ctx) {
      for (let i = 0; i < 4; i++) addBlock(ctx, `column ${i}`, [0.9, 6, 0.9], [-4.5 + i * 3, 3, 0], 'marble', looks.marble);
      addBlock(ctx, 'architrave', [11, 1, 1.2], [0, 6.5, 0], 'marble', looks.marble);
    },
  },
];

// ─── Mock weapon controller ──────────────────────────────────────────────────────────────────

const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Stand-in for the weapon controller: real arsenal data, rate of fire and cooldowns, shot events
 * from the camera, and synthetic impacts at the aim point after the flight time.
 */
class MockWeapons implements WeaponControllerApi, System {
  readonly name = 'mock-weapons';
  readonly weapons: readonly WeaponSpec[];
  current: WeaponSpec;
  currentAmmo: AmmoSpec;
  roundsFired = 0;
  cooldown = 0;
  aimPoint: THREE.Vector3 | null = null;
  charges: ChargeEvent[] = [];
  private readonly ctx: SimContext;
  private trigger = false;
  private wasDown = false;
  private next = 0;
  private aimHit: RayHit | null = null;
  private pending: { at: number; e: ImpactEvent | null; blast?: { center: THREE.Vector3; tnt: number; kind: BlastKind; ammo: AmmoSpec } }[] = [];
  private nextCharge = 1;

  constructor(ctx: SimContext, weapons: readonly WeaponSpec[]) {
    this.ctx = ctx;
    this.weapons = weapons;
    this.current = weapons[0]!;
    this.currentAmmo = ctx.ammo(this.current.ammo[0]!);
  }
  select(id: string): void {
    const w = this.weapons.find((x) => x.id === id);
    if (!w || w === this.current) return;
    this.current = w;
    this.currentAmmo = this.ctx.ammo(w.ammo[0]!);
    this.cooldown = 0.3;
  }
  setAmmo(id: string): void {
    if (this.current.ammo.includes(id)) this.currentAmmo = this.ctx.ammo(id);
  }
  cycleAmmo(): void {
    const l = this.current.ammo;
    this.currentAmmo = this.ctx.ammo(l[(l.indexOf(this.currentAmmo.id) + 1) % l.length]!);
  }
  setTrigger(down: boolean): void {
    this.trigger = down;
  }
  detonate(seq = 0): void {
    this.charges.forEach((c, i) => this.pending.push({ at: this.ctx.time.now + i * seq, e: null, blast: { center: c.position, tnt: c.tntKg, kind: 'contact', ammo: this.ctx.ammo('c4') } }));
    for (const c of this.charges) this.ctx.events.emit('chargeRemoved', { id: c.id });
    this.charges = [];
  }
  fixedUpdate(dt: number): void {
    const ctx = this.ctx;
    ctx.camera.updateMatrixWorld();
    ctx.camera.getWorldPosition(_pos);
    ctx.camera.getWorldDirection(_fwd);
    this.aimHit = ctx.registry.raycast(_pos, _fwd, 3000);
    this.aimPoint = this.aimHit ? this.aimHit.point : _fwd.y < -1e-3 ? _pos.clone().addScaledVector(_fwd, -_pos.y / _fwd.y) : null;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const now = ctx.time.now;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.at > now) continue;
      this.pending.splice(i, 1);
      if (p.e) ctx.events.emit('impact', p.e);
      if (p.blast) emitBlast(ctx, p.blast.center, p.blast.tnt, p.blast.kind, p.blast.ammo);
    }
    const w = this.current;
    const pressed = this.trigger && !this.wasDown;
    this.wasDown = this.trigger;
    if (w.delivery === 'placed') {
      if (pressed && this.cooldown <= 0 && this.aimHit) {
        const ev: ChargeEvent = { time: now, id: this.nextCharge++, position: this.aimHit.point.clone(), normal: this.aimHit.normal.clone(), tntKg: this.currentAmmo.explosiveTNT ?? 0.5, label: this.currentAmmo.name };
        this.charges = [...this.charges, ev];
        ctx.events.emit('chargePlaced', ev);
        this.cooldown = 0.4;
      }
      return;
    }
    if (w.fireMode === 'auto' && this.trigger && this.cooldown <= 0) {
      this.next -= dt;
      while (this.next <= 0) {
        this.fire(-this.next);
        this.next += 60 / w.rpm;
      }
    } else if (!this.trigger) this.next = 0;
    if (w.fireMode !== 'auto' && pressed && this.cooldown <= 0) {
      this.fire(0);
      this.cooldown = w.fireMode === 'semi' ? 60 / w.rpm : Math.min(4, 60 / w.rpm);
    }
  }
  private fire(delay: number): void {
    const ctx = this.ctx, w = this.current, a = this.currentAmmo;
    const t = ctx.time.now + delay;
    this.roundsFired++;
    ctx.events.emit('shot', { time: t, weapon: w, ammo: a, origin: _pos.clone().add(new THREE.Vector3(0.15, -0.12, -0.4).applyQuaternion(ctx.camera.quaternion)), direction: _fwd.clone() });
    const hit = this.aimHit;
    if (w.delivery === 'indirect') {
      if (this.aimPoint) this.pending.push({ at: t + 1.2, e: null, blast: { center: this.aimPoint.clone(), tnt: a.explosiveTNT ?? 10, kind: 'he', ammo: a } });
      return;
    }
    if (!hit) return;
    const flight = hit.distance / Math.max(50, a.muzzleVelocity);
    const e = syntheticImpact(ctx, a, hit.material, hit.point, hit.normal, _fwd.clone(), hit.target);
    this.pending.push({ at: t + flight, e, blast: (a.explosiveTNT ?? 0) > 0.05 ? { center: hit.point.clone(), tnt: a.explosiveTNT!, kind: a.kind === 'thermobaric' ? 'thermobaric' : 'he', ammo: a } : undefined });
  }
}

function emitBlast(ctx: SimContext, center: THREE.Vector3, tntKg: number, kind: BlastKind, ammo?: AmmoSpec, gasPressure?: number): void {
  ctx.events.emit('blast', { center: center.clone(), tntKg, kind, time: ctx.time.now, fireballRadius: 1.75 * Math.cbrt(tntKg), normal: new THREE.Vector3(0, 1, 0), source: ammo, label: ammo?.name, gasPressure });
}

/**
 * Plausible (not resolved) impact numbers so the telemetry fills in; with `?real` the terminal
 * ballistics module produces the real ones.
 */
function syntheticImpact(ctx: SimContext, a: AmmoSpec, m: MaterialProps, point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, target: Destructible, outcome?: ImpactOutcome): ImpactEvent {
  const v = a.muzzleVelocity * 0.96;
  const E = 0.5 * a.mass * v * v;
  const obl = Math.acos(Math.min(1, Math.max(-1, -dir.dot(normal))));
  const d = a.diameter;
  const brittle = m.class === 'brittle';
  const out: ImpactOutcome = outcome ?? (m.class === 'glass' ? 'perforate' : obl > 1.3 ? 'ricochet' : m.class === 'ductile' && a.kind === 'ball' ? 'shatter' : 'embed');
  const depth = out === 'ricochet' ? 0 : brittle ? Math.min(0.4, 6 * d * Math.sqrt(E / 1600)) : m.class === 'ductile' ? Math.min(0.02, 1.2 * d) : 0.012;
  const residual = out === 'perforate' ? v * 0.62 : out === 'ricochet' ? v * 0.55 : 0;
  return {
    time: ctx.time.now, ammo: a, agent: 'projectile', point: point.clone(), direction: dir.clone(), normal: normal.clone(), obliquity: obl,
    speed: v, mass: a.mass, kineticEnergy: E, outcome: out, depth, residualSpeed: residual,
    craterRadius: brittle ? 4.5 * d : 1.5 * d, craterDepth: brittle ? 2.4 * d : 0.4 * d, tunnelRadius: d / 2,
    spallRadius: 0, spallDepth: 0, damageRadius: brittle ? 16 * d : 4 * d, energyAbsorbed: E - 0.5 * a.mass * residual * residual,
    momentum: dir.clone().multiplyScalar(a.mass * (v - residual)), material: m, targetKind: target.kind, targetName: target.name,
    summary: `mock: ${a.name} → ${m.name}, synthetic numbers (open ?real for the resolver)`,
  };
}

// ─── Page ────────────────────────────────────────────────────────────────────────────────────

let weapons: WeaponControllerApi | null = null;
let audio: AudioSystem | null = null;

const kit = await createSandbox({
  title: 'ui sandbox',
  camera: { position: [0, 1.7, 14], lookAt: [0, 1.6, 0] },
  pipeline: mods.Pipeline ? new mods.Pipeline({ quality: Number(params.get('q') ?? 1) as 0 | 1 | 2 }) : undefined,
  async install(sim: Simulation) {
    let arsenal: readonly WeaponSpec[] = [];
    try {
      arsenal = (await import('../weapons/arsenal.ts')).WEAPONS;
    } catch (err) {
      console.warn('ui sandbox: arsenal unavailable', err);
    }
    if (REAL) {
      const { installBallistics } = await import('../systems/index.ts');
      const { createWeaponController } = await import('../weapons/index.ts');
      installBallistics(sim);
      weapons = createWeaponController(sim);
      if (mods.installFx) mods.installFx(sim);
    } else {
      const mock = new MockWeapons(sim.ctx, arsenal);
      sim.addSystem(mock);
      weapons = mock;
    }
    audio = installAudio(sim) as AudioSystem;
  },
  build: FULL ? buildFull : buildBase,
});

const sim = kit.sim;
const ctx = sim.ctx;
// The player owns the camera here: neutralise the kit's orbit controls.
kit.controls.enabled = false;
kit.controls.update = () => false;
kit.controls.dispose();

const player = installPlayer(sim, weapons!, { canvas: ctx.renderer.domElement, touch: params.has('touch') }).player as PlayerController;
const hudHandle = installHud(sim, weapons!, {
  scenes: MOCK_SCENES,
  onSelectScene: (id) => sim.loadScene(MOCK_SCENES.find((s) => s.id === id)!),
  startWithMenu: params.get('menu') !== '0',
});
const hud: Hud = hudHandle.hud;

const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

const api = {
  sim, player, hud, weapons: weapons!, audio: audio!,
  /** Camera pose the player adopts */
  view(position: number[], target: number[]) {
    ctx.camera.position.copy(v3(position));
    ctx.camera.lookAt(v3(target));
    ctx.camera.updateMatrixWorld();
  },
  menu(show: boolean) {
    hud.showMenu(show);
  },
  help(show: boolean) {
    const open = hud.root.querySelector('.dx-help')!.classList.contains('dx-show');
    if (open !== show) hud.toggleHelp();
  },
  select(id: string, ammo?: string) {
    player.select(id);
    if (ammo) weapons!.setAmmo(ammo);
  },
  ads(on: boolean) {
    player.setAds(on, true);
  },
  slowmo(on: boolean) {
    if (player.slowMo !== on) player.toggleSlowMo();
  },
  toast(t: string, accent = false) {
    hud.toast(t, accent);
  },
  /** Emit synthetic impacts of several materials and outcomes (telemetry fill). */
  impacts() {
    const cam = ctx.camera.position;
    const list: [string, MaterialId, ImpactOutcome, number[]][] = [
      ['m855', 'concrete', 'embed', [0.3, 1.8, 0.2]],
      ['m995', 'steel_s355', 'perforate', [-2.6, 1.1, 3.01]],
      ['m80', 'glass_tempered', 'perforate', [0.4, 1.3, 3.406]],
      ['m33', 'marble', 'ricochet', [3.2, 2.2, 3.25]],
      ['m2ap', 'concrete', 'embed', [-0.5, 2.1, 0.2]],
    ];
    for (const [ammo, mat, outcome, p] of list) {
      const point = v3(p);
      const dir = point.clone().sub(cam).normalize();
      const target = ctx.registry.all()[0]!;
      ctx.events.emit('impact', syntheticImpact(ctx, ctx.ammo(ammo), MATERIALS[mat], point, new THREE.Vector3(0, 0, 1), dir, target, outcome));
    }
  },
  /**
   * Mock burst on one spot (no resolver): each round meets the floor the earlier ones dug, a few
   * millimetres deeper, the way a real burst deepens a crater; the last one goes through.
   */
  burstDemo(n = 40, ammo = 'm855', at: number[] = [0.3, 1.7, 0.2]) {
    const cam = ctx.camera.position;
    const target = ctx.registry.all()[0]!;
    let floor = 0;
    for (let i = 0; i < n; i++) {
      const point = v3(at).add(new THREE.Vector3(0.012 * Math.sin(i * 2.1), 0.012 * Math.cos(i * 1.7), -floor));
      const dir = point.clone().sub(cam).normalize();
      const last = i === n - 1;
      const e = syntheticImpact(ctx, ctx.ammo(ammo), MATERIALS.concrete, point, new THREE.Vector3(0, 0, 1), dir, target, last ? 'perforate' : 'embed');
      e.time = ctx.time.now + i * 0.075;
      e.depth = last ? Math.max(0.02, 0.25 - floor) : 0.035 + 0.0008 * i;
      if (last) e.exitPoint = v3(at).add(new THREE.Vector3(0, 0, -0.25));
      ctx.events.emit('impact', e);
      floor += 0.0035 + 0.00008 * i;
    }
  },
  /** Mock blast; `gasPressure` (Pa) stands for a confined detonation's quasi-static gas load. */
  blast(at: number[], tntKg: number, kind: BlastKind = 'he', ammo = 'pg7vl', gasPressure?: number) {
    emitBlast(ctx, v3(at), tntKg, kind, ctx.ammo(ammo), gasPressure);
  },
  /** Hold the trigger for `seconds` of sim time (advancing the simulation). */
  fire(seconds: number) {
    player.setTrigger(true);
    sim.advance(seconds);
    player.setTrigger(false);
    sim.advance(0.02);
  },
  /**
   * CPU cost of the M6 event handlers (audio voices + HUD telemetry) under a synthetic barrage:
   * `n` shots, `n` impacts on mixed materials, n/10 blasts, n debris contacts. ms per event.
   */
  loadTest(n = 200) {
    const cam = ctx.camera.position;
    const w = weapons!.current;
    const a = weapons!.currentAmmo;
    const mats: MaterialId[] = ['concrete', 'steel_s355', 'glass_tempered', 'soil', 'marble'];
    const target = ctx.registry.all()[0]!;
    const shots: { time: number; weapon: WeaponSpec; ammo: AmmoSpec; origin: THREE.Vector3; direction: THREE.Vector3 }[] = [];
    const impacts: ImpactEvent[] = [];
    for (let i = 0; i < n; i++) {
      shots.push({ time: ctx.time.now, weapon: w, ammo: a, origin: cam.clone(), direction: new THREE.Vector3(0, 0, -1) });
      const p = new THREE.Vector3((i % 9) - 4, 1 + (i % 3), 0.2);
      impacts.push(syntheticImpact(ctx, ctx.ammo('m855'), MATERIALS[mats[i % mats.length]!], p, new THREE.Vector3(0, 0, 1), p.clone().sub(cam).normalize(), target));
    }
    const t0 = performance.now();
    for (const s of shots) ctx.events.emit('shot', s);
    const t1 = performance.now();
    for (const e of impacts) ctx.events.emit('impact', e);
    const t2 = performance.now();
    for (let i = 0; i < n / 10; i++) emitBlast(ctx, new THREE.Vector3(i - 10, 0.2, -8), 0.5 + i * 0.1, 'he');
    const t3 = performance.now();
    for (let i = 0; i < n; i++) ctx.events.emit('debrisContact', { time: ctx.time.now, position: new THREE.Vector3(i % 7, 0.1, 1), impulse: 1 + (i % 20), size: 0.05 + (i % 10) * 0.08, material: MATERIALS[mats[i % mats.length]!] });
    const t4 = performance.now();
    return { shotMs: (t1 - t0) / n, impactMs: (t2 - t1) / n, blastMs: (t3 - t2) / (n / 10), debrisMs: (t4 - t3) / n, audio: audio!.stats() };
  },
  reloadFonts() {
    ensureFonts(document, String(Date.now()));
    return document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
  },
  audioTest: () => renderOfflineTest(),
  /** The HUD's hit group (progressive damage on one spot) */
  groupState() {
    const gs = (hud as unknown as { groups: HitGroups }).groups;
    const g = gs.current;
    const mm = (x: number) => Math.round(x * 1000);
    if (!g) return null;
    return {
      count: g.count, firstMm: mm(g.first), deepestMm: mm(g.deepest), perforatedAt: g.perforatedAt, thicknessMm: mm(g.thickness),
      profileMm: g.profile.map(mm), stride: g.stride, material: g.material, groups: gs.list.map((x) => x.count),
    };
  },
  /**
   * Slow motion at a tiny fixed step: `seconds` of sim time in steps of `dt`, a rendered-frame
   * update every `frameDt` of real time at the current time scale. Reports anything non-finite.
   */
  slowRun(seconds: number, dt = 0.001, frameDt = 1 / 60) {
    let t = 0, sinceFrame = 0, frames = 0;
    const bad: string[] = [];
    while (t < seconds - 1e-9) {
      const h = Math.min(dt, seconds - t);
      sim.fixedStep(h);
      t += h;
      sinceFrame += h;
      const simFrame = frameDt * ctx.time.scale;
      if (sinceFrame >= simFrame) {
        sim.frameStep(sinceFrame, frameDt);
        sinceFrame = 0;
        frames++;
        const c = ctx.camera;
        if (![c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.w, c.fov, ctx.time.scale].every(Number.isFinite)) bad.push(`camera at t=${t}`);
      }
    }
    const txt = hud.root.textContent ?? '';
    if (/NaN|Infinity|undefined/.test(txt)) bad.push('HUD text');
    return { frames, scale: ctx.time.scale, bad, simTime: ctx.time.now };
  },
  /**
   * Whole frames through the pipeline (GPU finished by a 1-px read-back) and the M6 share of the
   * CPU: player + audio (systems) and HUD (frame listener) as timed inside the frame.
   */
  framePerf(frames = 20) {
    const gl = ctx.renderer.getContext();
    const px = new Uint8Array(4);
    let total = 0, m6 = 0;
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      const p0 = performance.now();
      player.frameUpdate(0, 1 / 60);
      const p1 = performance.now();
      (hud as unknown as { frame(dt: number): void }).frame(1 / 60);
      const p2 = performance.now();
      audio!.frameUpdate(0, 1 / 60);
      m6 += performance.now() - p2 + (p2 - p1) + (p1 - p0);
      sim.render(1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      total += performance.now() - t0;
    }
    const info = ctx.renderer.info.render;
    return { frameMs: total / frames, m6Ms: m6 / frames, drawCalls: info.calls, triangles: info.triangles };
  },
  /** Per-frame CPU cost of the M6 systems, ms (HUD DOM work, audio scheduling, player). */
  perf(frames = 120) {
    const t: number[] = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      player.frameUpdate(0, 1 / 60);
      const t1 = performance.now();
      (hud as unknown as { frame(dt: number): void }).frame(1 / 60);
      const t2 = performance.now();
      audio!.frameUpdate(0, 1 / 60);
      const t3 = performance.now();
      t.push(t1 - t0, t2 - t1, t3 - t2);
    }
    const avg = (k: number) => t.filter((_, i) => i % 3 === k).reduce((s, x) => s + x, 0) / frames;
    return { playerMs: avg(0), hudMs: avg(1), audioMs: avg(2) };
  },
};
(window as unknown as { __ui: typeof api }).__ui = api;
window.addEventListener('beforeunload', () => disposables.forEach((d) => d.dispose()));
