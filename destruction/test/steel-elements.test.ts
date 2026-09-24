import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../src/destructibles/Registry.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import type { SimContext, SimEvents, SteelPlateSpec } from '../src/app/contracts.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';
import type { ImpactEvent } from '../src/physics/ballistics/types.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { createBlastLoad } from '../src/physics/ballistics/blast.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import { createSteelBeam, createSteelPlate, SteelBeam, SteelPlate } from '../src/destructibles/steel/index.ts';

/**
 * The steel elements (SteelPlate / SteelBeam) against a headless context: real Rapier world and
 * registry, no renderer, stub effects and structure graph that count what they are asked to do.
 */
async function makeCtx() {
  const physics = await PhysicsWorld.create();
  const registry = new DestructibleRegistry();
  const world = new THREE.Group();
  const calls: Record<string, number> = {};
  const count = (k: string) => () => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null as unknown as THREE.WebGLRenderer, physics, registry,
    events: new EventBus<SimEvents>(), world, time: { now: 0, scale: 1, fixedDt: 1 / 60 }, rng: new Rng(3),
    projectiles: { spawn: () => { throw new Error('no projectiles'); }, active: [] },
    blasts: { detonate() {} },
    fx: { chips: count('chips'), dust: count('dust'), sparks: count('sparks'), smoke: count('smoke'), flash: count('flash'), shake: count('shake') },
    audio: { unlock() {}, setMuted() {}, muted: true },
    structure: { link: () => 'a', touch: count('touch'), remove: count('remove'), update() {} },
    addDestructible(d: Destructible) {
      registry.add(d);
      if (!d.root.parent) world.add(d.root);
    },
    ammo: getAmmo,
  } as unknown as SimContext;
  const step = (dt: number, frames = true) => {
    ctx.time.now += dt;
    physics.step(dt);
    for (const d of registry.all()) if (!d.disposed) d.fixedUpdate?.(dt);
    registry.sweep();
    if (frames) for (const d of registry.all()) if (!d.disposed) d.frameUpdate?.(dt);
  };
  return { ctx, step, calls };
}

const S355_PLATE: SteelPlateSpec = {
  name: 'S355', material: 'steel_s355', width: 2, height: 2, thickness: 0.02, position: [0, 1.5, 0],
  edges: { top: true, bottom: true, left: true, right: true }, finish: 'mill-scale',
};

test('contact charge on a 20 mm plate breaches it and bends the petals out (energy ≤ ring KE)', async () => {
  const { ctx, step, calls } = await makeCtx();
  const p = createSteelPlate(ctx, S355_PLATE) as SteelPlate;
  const load = createBlastLoad({ center: new THREE.Vector3(0.003, 1.5, 0.05), tntKg: 1.6, kind: 'he', contactTargetId: p.id }, 0);
  p.applyBlast(load);
  for (let k = 0; k < 30; k++) step(1 / 60);
  const s = p.sim;
  let dead = 0;
  for (let t = 0; t < s.nt; t++) if (!s.talive[t]) dead++;
  let back = 0;
  for (let i = 0; i < s.n; i++) if (s.palive[i]) back = Math.min(back, s.x[3 * i + 2]!);
  assert.ok(dead > 0, 'holed');
  // Petals fold away from the charge (−z): the ring around a 6 cm hole moves by centimetres.
  assert.ok(back < -0.01, `petals folded (${(back * 1000).toFixed(1)} mm)`);
  assert.ok(s.plasticWork > 5e3 && s.plasticWork < 4e5, `plastic work ${(s.plasticWork / 1e3).toFixed(0)} kJ`);
  for (let i = 0; i < 3 * s.n; i++) assert.ok(Number.isFinite(s.x[i]!));
  assert.ok((calls.touch ?? 0) > 0, 'structure graph told about the torn plate');
});

test('distant blast costs nothing and changes nothing', async () => {
  const { ctx } = await makeCtx();
  const p = createSteelPlate(ctx, S355_PLATE) as SteelPlate;
  const x0 = Float64Array.from(p.sim.x.subarray(0, 3 * p.sim.n));
  const t0 = performance.now();
  p.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 1.5, 15), tntKg: 1.6, kind: 'he' }, 0));
  const ms = performance.now() - t0;
  assert.ok(!p.sim.busy, 'no deformation queued');
  assert.deepEqual(Float64Array.from(p.sim.x.subarray(0, 3 * p.sim.n)), x0);
  assert.ok(ms < 20, `took ${ms.toFixed(1)} ms`);
});

function ballSplash(p: SteelPlate, at: THREE.Vector3): ImpactEvent {
  const a = getAmmo('m855');
  const dir = new THREE.Vector3(0, 0, -1);
  const hit = p.raycast(at.clone().setZ(1), dir, 5)!;
  return {
    time: 0, ammo: a, agent: 'projectile', point: hit.point, direction: dir, normal: hit.normal, obliquity: 0, speed: 900, mass: a.mass,
    kineticEnergy: 0.5 * a.mass * 900 * 900, outcome: 'shatter', depth: 0.0019, residualSpeed: 0, craterRadius: 0.004, craterDepth: 0.0019,
    tunnelRadius: 0, spallRadius: 0, spallDepth: 0, damageRadius: 0.02, energyAbsorbed: 1500, momentum: dir.clone().multiplyScalar(a.mass * 900),
    material: MATERIALS.steel_s355, targetKind: 'plate', summary: 'test',
  };
}

test('rifle hits on one spot deepen the crater and thin what the next round meets', async () => {
  const { ctx } = await makeCtx();
  const p = createSteelPlate(ctx, S355_PLATE) as SteelPlate;
  const at = new THREE.Vector3(0.31, 1.62, 0);
  const thick: number[] = [];
  for (let k = 0; k < 4; k++) {
    const e = ballSplash(p, at);
    const hit = p.raycast(at.clone().setZ(1), new THREE.Vector3(0, 0, -1), 5)!;
    thick.push(p.probe(hit, e.direction, 1).segments[0]!.end);
    p.applyImpact(e);
  }
  for (let k = 1; k < thick.length; k++) assert.ok(thick[k]! < thick[k - 1]! - 1e-3, `thickness under the crater ${thick.map((t) => (t * 1000).toFixed(1)).join(' → ')} mm`);
});

test('warm steel below the visible range cools without touching the mesh; glowing steel refreshes it', async () => {
  const { ctx, step } = await makeCtx();
  const p = createSteelPlate(ctx, S355_PLATE) as SteelPlate;
  p.applyImpact(ballSplash(p, new THREE.Vector3(0, 1.5, 0)));
  const i = p.sim.nearestParticle(0, 0, 0);
  const heat = (p as unknown as { geometry: THREE.BufferGeometry }).geometry.getAttribute('aHeat') as THREE.BufferAttribute;
  const refreshes = (frames: number) => {
    let n = 0;
    for (let k = 0; k < frames; k++) {
      const v = heat.version;
      step(1 / 60);
      if (heat.version !== v) n++;
    }
    return n;
  };
  refreshes(5);
  p.sim.temp[i] = 140;
  (p as unknown as { warm(): void }).warm();
  const T0 = p.sim.temp[i]!;
  assert.ok(refreshes(300) <= 1, 'no mesh refresh for invisible heat (one check after it was added)');
  assert.ok(p.sim.temp[i]! < T0, 'but it keeps cooling');
  p.sim.temp[i] = 700;
  (p as unknown as { warm(): void }).warm();
  assert.ok(refreshes(60) > 50, 'glowing steel is redrawn every frame');
});

test('severed member: pieces keep the original arc coordinates (hits land on the right node)', async () => {
  const { ctx, step } = await makeCtx();
  const b = createSteelBeam(ctx, {
    name: 'IPE', material: 'steel_s355', profile: { type: 'I', h: 0.3, b: 0.15, tw: 0.0071, tf: 0.0107 },
    start: [0, 2, 0], end: [6, 2, 0], up: [0, 1, 0], ends: { start: 'fixed', end: 'fixed' }, finish: 'painted',
  }) as SteelBeam;
  const k = 25;
  for (let q = 0; q < 3; q++) b.sim.frac[3 * k + q] = 0.05;
  b.sim.updateSection(k);
  step(1 / 60);
  const pieces = ctx.registry.all().filter((d) => !d.disposed) as SteelBeam[];
  assert.equal(pieces.length, 2);
  for (const piece of pieces) {
    const x = piece.name.endsWith('a') ? 1.0 : 4.9;
    assert.ok(piece.raycast(new THREE.Vector3(x, 2, 3), new THREE.Vector3(0, 0, -1), 10), `${piece.name} is hit at x = ${x}`);
    const c = (piece as unknown as { hitCache: { s: number } }).hitCache;
    assert.ok(Math.abs(c.s - x) < 0.01, `${piece.name}: arc ${c.s} vs ${x}`);
  }
});

test('plate contact charge in slow motion (dt = 0.001) ends like dt = 1/60', async () => {
  const run = async (dt: number) => {
    const { ctx, step } = await makeCtx();
    const p = createSteelPlate(ctx, { ...S355_PLATE, thickness: 0.012 }) as SteelPlate;
    p.applyBlast(createBlastLoad({ center: new THREE.Vector3(0.2, 1.4, 0.6), tntKg: 3, kind: 'he' }, 0));
    for (let t = 0; t < 0.2; t += dt) step(dt, false);
    const s = p.sim;
    let z = 0;
    for (let i = 0; i < s.n; i++) {
      assert.ok(Number.isFinite(s.x[3 * i + 2]!));
      if (s.palive[i]) z = Math.min(z, s.x[3 * i + 2]!);
    }
    return { z, W: s.plasticWork };
  };
  const a = await run(1 / 60), b = await run(0.001);
  assert.ok(a.z < -0.005, `dished (${(a.z * 1000).toFixed(1)} mm)`);
  assert.ok(Math.abs(a.z / b.z - 1) < 0.1 && Math.abs(a.W / b.W - 1) < 0.1, `1/60: ${a.z}, ${a.W}; 0.001: ${b.z}, ${b.W}`);
});
