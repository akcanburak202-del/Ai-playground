/**
 * Level of detail of steel members: a pristine member is drawn with a coarse sweep (corners and
 * fillets only, a ring every 0.5 m), the first dent / hinge / bow switches it to the fine sweep.
 *
 *   node --test test/steel-lod.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../src/destructibles/Registry.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import type { SimContext, SimEvents, SteelBeamSpec } from '../src/app/contracts.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';
import type { ImpactEvent } from '../src/physics/ballistics/types.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { createBlastLoad } from '../src/physics/ballistics/blast.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import { createSteelBeam, SteelBeam } from '../src/destructibles/steel/index.ts';
import { sectionProps } from '../src/destructibles/steel/section.ts';
import { profileOutline, SweptMesh } from '../src/destructibles/steel/profileMesh.ts';

async function makeCtx() {
  const physics = await PhysicsWorld.create();
  const registry = new DestructibleRegistry();
  const world = new THREE.Group();
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null as unknown as THREE.WebGLRenderer, physics, registry,
    events: new EventBus<SimEvents>(), world, time: { now: 0, scale: 1, fixedDt: 1 / 60 }, rng: new Rng(3),
    projectiles: { spawn: () => { throw new Error('no projectiles'); }, active: [] },
    blasts: { detonate() {} },
    fx: { chips() {}, dust() {}, sparks() {}, smoke() {}, flash() {}, shake() {} },
    audio: { unlock() {}, setMuted() {}, muted: true },
    structure: { link: () => 'a', touch() {}, remove() {}, update() {} },
    addDestructible(d: Destructible) {
      registry.add(d);
      if (!d.root.parent) world.add(d.root);
    },
    ammo: getAmmo,
  } as unknown as SimContext;
  const step = (dt: number, n = 1) => {
    for (let k = 0; k < n; k++) {
      ctx.time.now += dt;
      physics.step(dt);
      for (const d of registry.all()) if (!d.disposed) d.fixedUpdate?.(dt);
      registry.sweep();
      for (const d of registry.all()) if (!d.disposed) d.frameUpdate?.(dt);
    }
  };
  return { ctx, step };
}

const HEB300 = { type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 } as const;
const beamSpec = (finish: SteelBeamSpec['finish'] = 'painted'): SteelBeamSpec => ({
  name: 'HEB 300', material: 'steel_s355', profile: HEB300, start: [0, 3, 0], end: [6, 3, 0], up: [0, 1, 0],
  ends: { start: 'fixed', end: 'fixed' }, finish,
});
const sweptOf = (b: SteelBeam) => (b as unknown as { swept: SweptMesh }).swept;

test('a pristine 6 m HEB 300 is drawn coarse (≤ 2 k triangles) with the fine sweep’s outline and texture mapping', async () => {
  const { ctx, step } = await makeCtx();
  const b = createSteelBeam(ctx, beamSpec()) as SteelBeam;
  ctx.addDestructible(b);
  step(1 / 60, 60);
  assert.ok(!b.fineMesh, 'at rest under its own weight it stays coarse');
  assert.ok(b.triangles <= 2000, `${b.triangles} triangles`);
  // Every coarse outline vertex is a fine outline vertex with the same perimeter parameter (texture u).
  const fine = profileOutline(HEB300, sectionProps(HEB300).rootRadius);
  const coarse = sweptOf(b).outline;
  assert.ok(Math.abs(coarse.perimeter - fine.perimeter) < 1e-9, 'same perimeter');
  for (const v of coarse.verts) {
    assert.ok(fine.verts.some((w) => Math.abs(w.y - v.y) < 1e-9 && Math.abs(w.z - v.z) < 1e-9 && Math.abs(w.p - v.p) < 1e-9 && w.ny === v.ny && w.nz === v.nz), `vertex (${v.y}, ${v.z}) of the fine outline`);
  }
  // The same surface: the fine sweep of the same state has the same bounds.
  const ref = new SweptMesh(fine, 6, 0, 0.05);
  const s = b.sim, plast = new Float64Array(s.n);
  ref.update({ n: s.n, ds: s.ds, x: s.x, u: s.u, s0: s.s0, temp: s.temp, plast }, [], null);
  const bc = sweptOf(b).geometry.boundingBox!, bf = ref.geometry.boundingBox!;
  assert.ok(bc.min.distanceTo(bf.min) < 1e-3 && bc.max.distanceTo(bf.max) < 1e-3, 'coarse bounds = fine bounds');
  ref.dispose();
});

test('a rifle crater (texture only) keeps the coarse sweep; the first dent switches to the fine one and draws the dish', async () => {
  const { ctx, step } = await makeCtx();
  const b = createSteelBeam(ctx, beamSpec()) as SteelBeam;
  ctx.addDestructible(b);
  step(1 / 60, 30);
  const a = getAmmo('m855');
  // Onto the top flange (19 mm, held across 0.3 m): the round's momentum dishes it by < 1 mm.
  const dir = new THREE.Vector3(0, -1, 0);
  const hit = b.raycast(new THREE.Vector3(2, 4, 0.08), dir, 5)!;
  const e: ImpactEvent = {
    time: 0, ammo: a, agent: 'projectile', point: hit.point, direction: dir, normal: hit.normal, obliquity: 0, speed: 900, mass: a.mass,
    kineticEnergy: 0.5 * a.mass * 900 * 900, outcome: 'shatter', depth: 0.0019, residualSpeed: 0, craterRadius: 0.004, craterDepth: 0.0019,
    tunnelRadius: 0, spallRadius: 0, spallDepth: 0, damageRadius: 0.02, energyAbsorbed: 1500, momentum: dir.clone().multiplyScalar(a.mass * 900),
    material: MATERIALS.steel_s355, targetKind: 'beam', summary: 'test',
  };
  b.applyImpact(e);
  step(1 / 60, 10);
  assert.ok(!b.fineMesh && b.stats.maxDish === 0, 'a rifle crater on a flange lives in the detail texture');
  const coarseTris = b.triangles;
  const coarseGeo = sweptOf(b).geometry;
  let disposed = false;
  coarseGeo.addEventListener('dispose', () => (disposed = true));
  // M908's 1.6 kg fill bursting 0.25 m above the top flange (the heavy-member test's load).
  b.applyBlast(createBlastLoad({ center: new THREE.Vector3(3, 3.4, 0), tntKg: 1.6, kind: 'he' }, ctx.time.now));
  step(1 / 60, 20);
  assert.ok(b.stats.maxDish > 0.001, `dished ${(b.stats.maxDish * 1000).toFixed(1)} mm`);
  assert.ok(b.fineMesh, 'switched to the fine sweep');
  assert.ok(disposed, 'the coarse geometry was disposed');
  const mesh = b.root.children[0] as THREE.Mesh;
  assert.equal(mesh.geometry, sweptOf(b).geometry, 'the mesh draws the fine geometry');
  assert.ok(b.triangles > 10 * coarseTris, `${coarseTris} → ${b.triangles} triangles`);
  // The dish is in the drawn surface: compare with a dent-free fine sweep of the same state.
  const s = b.sim, plast = new Float64Array(s.n);
  for (let i = 0; i < s.n; i++) plast[i] = Math.max(s.bendPlast[2 * i]!, s.bendPlast[2 * i + 1]!);
  const ref = new SweptMesh(sweptOf(b).outline, s.ds * (s.n - 1), 0, Math.min(0.05, s.ds / 3));
  ref.update({ n: s.n, ds: s.ds, x: s.x, u: s.u, s0: s.s0, temp: s.temp, plast }, [], null);
  const p = sweptOf(b).geometry.getAttribute('position'), q = ref.geometry.getAttribute('position');
  assert.equal(p.count, q.count);
  let dmax = 0;
  for (let i = 0; i < p.count; i++) dmax = Math.max(dmax, Math.hypot(p.getX(i) - q.getX(i), p.getY(i) - q.getY(i), p.getZ(i) - q.getZ(i)));
  assert.ok(dmax > 0.5 * Math.min(b.stats.maxDish, 0.05), `dish drawn: ${(dmax * 1000).toFixed(1)} mm`);
  ref.dispose();
});

test('fireproofing coat follows the steel sweep to the fine level; a released pristine member falls coarse', async () => {
  const { ctx, step } = await makeCtx();
  const b = createSteelBeam(ctx, beamSpec('fireproofed')) as SteelBeam;
  ctx.addDestructible(b);
  step(1 / 60, 10);
  const coat = () => (b as unknown as { coat: { swept: SweptMesh; mesh: THREE.Mesh } }).coat;
  assert.ok(!b.fineMesh && b.triangles <= 4000, `steel + coat ${b.triangles} triangles`);
  assert.equal(coat().swept.geometry.getAttribute('position').count, sweptOf(b).geometry.getAttribute('position').count);
  b.applyBlast(createBlastLoad({ center: new THREE.Vector3(3, 3, 0.45), tntKg: 1.6, kind: 'he' }, ctx.time.now));
  step(1 / 60, 20);
  assert.ok(b.fineMesh);
  assert.equal(coat().mesh.geometry, coat().swept.geometry);
  assert.equal(coat().swept.geometry.getAttribute('position').count, sweptOf(b).geometry.getAttribute('position').count, 'coat on the fine layout');
  // Texture coordinates of the coat are the steel's (so its scars line up).
  const cu = coat().swept.geometry.getAttribute('aDUv'), su = sweptOf(b).geometry.getAttribute('aDUv');
  for (let i = 0; i < su.count; i += 97) assert.ok(cu.getX(i) === su.getX(i) && cu.getY(i) === su.getY(i));

  // A member held by nothing becomes a rigid body; pristine, it keeps its coarse sweep.
  const free = createSteelBeam(ctx, { ...beamSpec(), name: 'loose', start: [0, 6, 2], end: [4, 6, 2], ends: { start: 'free', end: 'free' } }) as SteelBeam;
  ctx.addDestructible(free);
  step(1 / 60, 3);
  assert.equal(free.mode, 'rigid');
  assert.ok(!free.fineMesh, 'falls with the coarse sweep');
  step(1 / 60, 10);
  assert.ok(free.bounds.max.y < 6.2 && free.bounds.min.x < 0.1 && free.bounds.max.x > 3.9, 'bounds follow the body');
});
