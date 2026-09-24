import * as THREE from 'three';
import { createSandbox } from './sandboxKit.ts';
import type { Simulation } from '../app/Simulation.ts';
import type { FxApi, GlassPaneSpec, RenderPipelineApi, SceneDef, SimContext, SteelBeamSpec, SteelPlateSpec, VoxelElementSpec } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createVoxelElement } from '../destructibles/voxel/index.ts';
import { createSteelBeam, createSteelPlate } from '../destructibles/steel/index.ts';
import { installBallistics, type BlastSystem, type ProjectileSystem } from '../systems/index.ts';
import { getAmmo } from '../physics/ballistics/ammo.ts';
import { blastAt, hemisphericalCharge, obliqueReflection, piDamage } from '../physics/ballistics/blast.ts';
import { MATERIALS } from '../physics/materials.ts';
import { stepFlight } from '../physics/ballistics/flight.ts';
import type { BlastKind, ImpactEvent } from '../physics/ballistics/types.ts';

/**
 * Ballistics range (M1 integration check): the real element modules on one proving ground.
 *
 *  - two 3 × 2.5 m, 0.25 m reinforced-concrete walls (Ø12 @ 150 mm both faces, 30 mm cover),
 *  - a 12 mm and a 20 mm S355 plate (edges welded) and an HEB 300 column carrying 1.5 MN,
 *  - a row of framed 6 mm annealed 1.5 × 1 m windows at increasing distance from wall B,
 *  - terrain, the production render pipeline and the FX system when those modules are present.
 *
 * Everything that happens goes through `installBallistics`: projectiles are flown, resolved and
 * realised by the targets; blasts reach each target when the shock front does. `window.__range`
 * drives scripted scenarios for scripts/shot.ts (`window.__sim` is the generic harness).
 */

// Optional modules: the range still works (on the basic pipeline, flat ground) without them.
type PipelineCtor = new (o: { quality: 0 | 1 | 2 }) => RenderPipelineApi;
type Factory<S> = (ctx: SimContext, spec: S) => Destructible;
let PipelineClass: PipelineCtor | null = null;
let installFx: ((sim: Simulation) => FxApi) | null = null;
let createTerrain: ((ctx: SimContext, opts?: { plaza?: { halfX: number; halfZ: number; finish: 'pavers' | 'travertine' | 'concrete' } }) => Destructible) | null = null;
let createGlassPane: Factory<GlassPaneSpec> | null = null;
const optional = async <T>(what: string, load: () => Promise<T>): Promise<T | null> => {
  try {
    return await load();
  } catch (err) {
    console.warn(`ballistics range: ${what} unavailable`, err);
    return null;
  }
};
const params = new URLSearchParams(location.search);
if (!params.has('basic')) PipelineClass = (await optional('render pipeline', async () => (await import('../render/Pipeline.ts')).Pipeline as unknown as PipelineCtor));
if (!params.has('nofx')) installFx = await optional('fx', async () => (await import('../fx/index.ts')).installFx);
createTerrain = await optional('terrain', async () => (await import('../destructibles/terrain/index.ts')).createTerrain);
createGlassPane = await optional('glass', async () => (await import('../destructibles/glass/index.ts')).createGlassPane);

const els: Record<string, Destructible> = {};
const disposables: { dispose(): void }[] = [];
type V3 = [number, number, number];
const v3 = (a: V3 | THREE.Vector3) => (a instanceof THREE.Vector3 ? a.clone() : new THREE.Vector3(a[0], a[1], a[2]));

/** Where the targets stand (the shooter is on +z). */
export const RANGE = {
  wallA: [0, 1.25, 0] as V3,
  wallB: [9, 1.25, 0] as V3,
  plate12: [-4, 1.3, 0] as V3,
  plate20: [-7.2, 1.5, 0] as V3,
  column: [-10.6, 0, 0] as V3,
  /** Windows face wall B from these distances (m) along +x, 2 m back from its face */
  windowDistances: [8, 16, 28, 45, 70],
  wall: { width: 3, height: 2.5, thickness: 0.25 },
};

function voxel(ctx: SimContext, spec: VoxelElementSpec): Destructible {
  const el = createVoxelElement(ctx, spec);
  els[spec.name] = el;
  const b = el.bounds;
  ctx.structure.link('ground', el, new THREE.Box3(new THREE.Vector3(b.min.x, -0.05, b.min.z), new THREE.Vector3(b.max.x, 0.06, b.max.z)));
  return el;
}
function plate(ctx: SimContext, spec: SteelPlateSpec): Destructible {
  return (els[spec.name] = createSteelPlate(ctx, spec));
}
function beam(ctx: SimContext, spec: SteelBeamSpec): Destructible {
  return (els[spec.name] = createSteelBeam(ctx, spec));
}
function block(ctx: SimContext, size: V3, pos: V3, color = 0xb9b4aa): THREE.Mesh {
  const g = new THREE.BoxGeometry(...size);
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  disposables.push(g, m);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(...pos);
  mesh.castShadow = mesh.receiveShadow = true;
  ctx.world.add(mesh);
  const p = ctx.physics;
  // Plain concrete plinths: rounds and fragments that strike them are resolved as concrete.
  p.createFixed(mesh.position.clone(), undefined, [p.R.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)], { kind: 'plinth', material: MATERIALS.concrete });
  return mesh;
}

/** Framed-window positions (centre) for each distance from wall B's blast point. */
function windowSpots(): { name: string; pos: V3; distance: number }[] {
  const [bx, , bz] = RANGE.wallB;
  return RANGE.windowDistances.map((d) => ({ name: `window ${d} m`, pos: [bx + d, 1.4, bz + 2.5] as V3, distance: d }));
}

const pipeline = PipelineClass ? new PipelineClass({ quality: (Number(params.get('q') ?? 1) as 0 | 1 | 2) }) : undefined;
let fxApi: FxApi | null = null;

const kit = await createSandbox({
  title: 'ballistics range',
  pipeline,
  camera: { position: [-2, 2.2, 13], lookAt: [-2, 1.2, 0] },
  install(sim) {
    installBallistics(sim);
    if (installFx) fxApi = installFx(sim);
  },
  build(ctx) {
    for (const d of disposables.splice(0)) d.dispose();
    for (const k of Object.keys(els)) delete els[k];
    if (createTerrain) els.terrain = createTerrain(ctx, { plaza: { halfX: 40, halfZ: 18, finish: 'concrete' } });
    const W = RANGE.wall;
    const rc = (name: string, at: V3): Destructible => voxel(ctx, {
      name, material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [W.width, W.height, W.thickness] }, position: at,
      rebar: { diameter: 0.012, spacing: 0.15, cover: 0.03, layout: 'two-faces' },
    });
    rc('RC wall A', RANGE.wallA);
    rc('RC wall B', RANGE.wallB);
    // Steel: plates welded on all edges (the weld line is the support), an HEB 300 column under load.
    plate(ctx, { name: 'S355 plate 12 mm', material: 'steel_s355', width: 1.2, height: 1.2, thickness: 0.012, position: RANGE.plate12, edges: { top: true, bottom: true, left: true, right: true }, finish: 'mill-scale' });
    block(ctx, [1.4, RANGE.plate12[1] - 0.6, 0.4], [RANGE.plate12[0], (RANGE.plate12[1] - 0.6) / 2, 0]);
    plate(ctx, { name: 'S355 plate 20 mm', material: 'steel_s355', width: 2, height: 2, thickness: 0.02, position: RANGE.plate20, edges: { top: true, bottom: true, left: true, right: true }, finish: 'painted', paintColor: 0x6d7a70 });
    block(ctx, [2.2, RANGE.plate20[1] - 1.0, 0.4], [RANGE.plate20[0], (RANGE.plate20[1] - 1.0) / 2, 0]);
    const [cx, , cz] = RANGE.column;
    const col = beam(ctx, { name: 'HEB 300 column', material: 'steel_s355', profile: { type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 }, start: [cx, 0.02, cz], end: [cx, 4.0, cz], up: [0, 0, 1], ends: { start: 'fixed', end: 'pinned' }, finish: 'painted', paintColor: 0x8a2a1c });
    col.structural?.setImposedLoad(1.5e6);
    block(ctx, [1.4, 0.4, 1.4], [cx, 4.2, cz]);
    // Windows at increasing distance from wall B, facing it (normal −x).
    if (createGlassPane) {
      for (const w of windowSpots()) {
        els[w.name] = createGlassPane(ctx, { name: w.name, type: 'annealed', width: 1.5, height: 1.0, thickness: 0.006, position: w.pos, rotation: [0, -Math.PI / 2, 0], framed: true });
        block(ctx, [0.3, 0.9, 1.7], [w.pos[0] + 0.1, 0.45, w.pos[2]], 0xd8d2c6);
      }
    }
  },
});

const { sim, controls } = kit;
const ctx = sim.ctx;
if (pipeline) {
  const def: SceneDef = {
    id: 'range', name: 'ballistics range', nameTr: 'atış alanı', blurb: '', blurbTr: '',
    spawn: { position: [-2, 2.2, 13], lookAt: [-2, 1.2, 0] }, sun: { elevation: 22, azimuth: 250 }, build: () => {},
  };
  pipeline.setup(ctx, def);
}

/** Every impact since the page loaded (the Simulation's own log keeps only the last 200). */
const allImpacts: ImpactEvent[] = [];
ctx.events.on('impact', (e) => allImpacts.push(e));

/**
 * Launch direction that brings a round from `from` down onto `at` (sight zeroing): bisection on the
 * elevation angle with the real flight model, so slow rounds (RPG, 40 mm) are aimed like the sight
 * would aim them instead of dropping short.
 */
function zeroedDirection(ammo: string, from: THREE.Vector3, at: THREE.Vector3): THREE.Vector3 {
  const spec = ctx.ammo(ammo);
  const flat = at.clone().sub(from);
  const range = Math.hypot(flat.x, flat.z);
  const base = flat.clone().normalize();
  if (spec.guidance || range < 1) return base;
  const heightAt = (elev: number): number => {
    const h = new THREE.Vector3(flat.x, 0, flat.z).normalize();
    const pitch = Math.atan2(flat.y, range) + elev;
    const b = { position: from.clone(), velocity: h.multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch)).multiplyScalar(spec.muzzleVelocity), mass: spec.mass, age: 0, burning: false };
    for (let i = 0; i < 20000; i++) {
      const prev = b.position.clone();
      stepFlight(b, spec, 1 / 240);
      const r0 = Math.hypot(prev.x - from.x, prev.z - from.z), r1 = Math.hypot(b.position.x - from.x, b.position.z - from.z);
      if (r1 >= range) return prev.y + ((b.position.y - prev.y) * (range - r0)) / Math.max(r1 - r0, 1e-9);
      if (b.velocity.lengthSq() < 1) break;
    }
    return -1e9;
  };
  let lo = -0.05, hi = 0.35;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (heightAt(mid) < at.y) lo = mid;
    else hi = mid;
  }
  const pitch = Math.atan2(flat.y, range) + 0.5 * (lo + hi);
  return new THREE.Vector3(flat.x, 0, flat.z).normalize().multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch));
}

const summarise = (e: ImpactEvent) => ({
  t: +e.time.toFixed(4), ammo: e.ammo.id, agent: e.agent, target: e.targetName ?? e.targetKind, material: e.material.id, outcome: e.outcome,
  speed: Math.round(e.speed), depth: +(e.depth * 1000).toFixed(1), crater: +(2 * e.craterRadius * 1000).toFixed(0), craterDepth: +(e.craterDepth * 1000).toFixed(1),
  spall: +(2 * e.spallRadius * 1000).toFixed(0), residual: Math.round(e.residualSpeed), summary: e.summary,
  point: [+e.point.x.toFixed(3), +e.point.y.toFixed(3), +e.point.z.toFixed(3)], dir: [+e.direction.x.toFixed(3), +e.direction.y.toFixed(3), +e.direction.z.toFixed(3)],
});

/** Blast records: every destructible's applyBlast is wrapped so we can log who got loaded, when. */
const blastLog: { t: number; target: string; kind: string; tnt: number; dist: number; pr: number; damage: number }[] = [];
const watched = new WeakSet<Destructible>();
function watchBlasts(): void {
  for (const d of ctx.registry.all()) {
    if (watched.has(d)) continue;
    watched.add(d);
    const orig = d.applyBlast.bind(d);
    d.applyBlast = (load) => {
      const p = d.bounds.clampPoint(load.center, new THREE.Vector3());
      const n = load.center.clone().sub(p);
      if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
      n.normalize();
      const glass = d.kind === 'glass';
      const th = glass ? 0.006 : d.kind === 'voxel' ? RANGE.wall.thickness : 0.02;
      const mat = glass ? MATERIALS.glass_annealed : d.kind === 'voxel' ? MATERIALS.concrete : MATERIALS.steel_s355;
      blastLog.push({
        t: +ctx.time.now.toFixed(4), target: d.name, kind: d.kind, tnt: load.tntKg, dist: +p.distanceTo(load.center).toFixed(2),
        pr: Math.round(load.reflectedPressureAt(p, n)), damage: +load.damageAt(p, n, mat, th).toFixed(2),
      });
      orig(load);
    };
  }
}
watchBlasts();
// A scene reload (`__sim.sim.loadScene(__sim.sim.currentScene)`) builds new elements: watch those too.
ctx.events.on('sceneLoaded', () => watchBlasts());

const range = {
  sim, THREE, els, RANGE, blastLog,
  get fx() { return fxApi; },
  get projectiles() { return ctx.projectiles as ProjectileSystem; },
  get blasts() { return ctx.blasts as BlastSystem; },
  view(position: V3, lookAt: V3, fov?: number) {
    ctx.camera.position.set(...position);
    controls.target.set(...lookAt);
    if (fov) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
    controls.update();
    ctx.camera.lookAt(...lookAt);
  },
  /** Fire `count` rounds from → at, `interval` s apart, and return the impact records they produced. */
  fire(ammo: string, from: V3, at: V3, count = 1, interval = 0.075, spreadM = 0, settle = 0.3) {
    const spec = ctx.ammo(ammo);
    const o = v3(from);
    const n0 = allImpacts.length;
    const t0 = performance.now();
    for (let k = 0; k < count; k++) {
      const target = v3(at).add(new THREE.Vector3(ctx.rng.gaussian(0, spreadM), ctx.rng.gaussian(0, spreadM), 0));
      const dir = zeroedDirection(ammo, o, target);
      ctx.projectiles.spawn({ ammo: spec, origin: o.clone(), velocity: dir.multiplyScalar(spec.muzzleVelocity), tracer: !!spec.tracer || k % 5 === 4, target });
      sim.advance(interval);
    }
    if (settle > 0) sim.advance(settle);
    return { ms: Math.round(performance.now() - t0), impacts: allImpacts.slice(n0).map(summarise) };
  },
  /**
   * Launch one round (zeroed onto `at`) without advancing time — for visible-flight shots. The
   * returned projectile is pooled: once it is gone its object may carry a new round, so follow it
   * with `p.alive && p.id === idAtLaunch`.
   */
  launch(ammo: string, from: V3, at: V3) {
    const spec = ctx.ammo(ammo);
    const o = v3(from);
    const dir = zeroedDirection(ammo, o, v3(at));
    return ctx.projectiles.spawn({ ammo: spec, origin: o, velocity: dir.multiplyScalar(spec.muzzleVelocity), target: v3(at) });
  },
  /** Impacts recorded since index `from` (see `impactCount`). */
  impactsSince(from: number) {
    return allImpacts.slice(from).map(summarise);
  },
  get impactCount() { return allImpacts.length; },
  /** Detonate a charge (contact with a named element when `contact` is given). */
  detonate(o: { at: V3; tntKg?: number; ammo?: string; kind?: BlastKind; normal?: V3; contact?: string }) {
    const a = o.ammo ? getAmmo(o.ammo) : undefined;
    const target = o.contact ? els[o.contact] : undefined;
    ctx.blasts.detonate({
      center: v3(o.at), tntKg: o.tntKg ?? a?.explosiveTNT ?? 1, kind: o.kind ?? 'contact', normal: o.normal ? v3(o.normal).normalize() : undefined,
      contactTargetId: target?.id, casingMass: a?.casingMass, gurney: a?.gurney, source: a, label: a?.name ?? 'charge',
    });
  },
  /** Predicted P–I damage of each window for a charge at `at` (what the physics says should break). */
  windowForecast(at: V3, tntKg: number) {
    const c = v3(at);
    const W = hemisphericalCharge(tntKg, c.y, true);
    return windowSpots().map((w) => {
      const p = v3(w.pos);
      const R = p.distanceTo(c);
      const b = blastAt(W, R);
      // Panes face −x (towards wall B): angle of incidence from the pane normal.
      const cosA = Math.max(0, -c.clone().sub(p).normalize().x);
      const P = obliqueReflection(b.ps, b.pr, cosA), I = obliqueReflection(b.is, b.ir, cosA);
      return { name: w.name, R: +R.toFixed(1), ps: Math.round(b.ps), pReflected: Math.round(P), arrivalMs: +(b.ta * 1000).toFixed(1), damage: +piDamage(P, I, MATERIALS.glass_annealed, 0.006).toFixed(2) };
    });
  },
  /** Status of every element: disposed / failed flags and the glass panes' own state. */
  status() {
    return Object.entries(els).map(([k, d]) => {
      const s = d as unknown as { stats?: unknown; broken?: boolean; state?: unknown };
      return { name: k, kind: d.kind, disposed: d.disposed, failed: d.structural?.hasFailed() ?? false, state: s.state ?? s.broken ?? null };
    });
  },
  impacts(n = 30) {
    return allImpacts.slice(-n).map(summarise);
  },
};
(window as unknown as { __range: typeof range }).__range = range;
