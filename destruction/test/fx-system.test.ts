import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FxSystem, BUDGET, fractureDustRadius } from '../src/fx/FxSystem.ts';
import { ParticleLayer, newRecord } from '../src/fx/ParticleLayer.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import { MATERIALS, type MaterialId } from '../src/physics/materials.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { getAtmosphere } from '../src/render/atmosphere.ts';
import { motionAt } from '../src/fx/motion.ts';
import type { Simulation } from '../src/app/Simulation.ts';
import type { Projectile, SimContext, SimEvents } from '../src/app/contracts.ts';
import type { ImpactEvent } from '../src/physics/ballistics/types.ts';

test('particle layer: ring buffer, minimal upload ranges, rejects non-finite particles', () => {
  const layer = new ParticleLayer('t', 8, new THREE.ShaderMaterial());
  const p = newRecord();
  p.life = 2;
  for (let i = 0; i < 3; i++) layer.emit(p);
  const a0 = layer.mesh.geometry.getAttribute('a0') as THREE.InstancedBufferAttribute;
  layer.flush(0);
  assert.deepEqual(a0.updateRanges, [{ start: 0, count: 12 }]);
  a0.clearUpdateRanges();
  for (let i = 0; i < 7; i++) layer.emit(p); // wraps
  layer.flush(0);
  assert.deepEqual(a0.updateRanges, [{ start: 0, count: 32 }]);
  p.x = Number.NaN;
  const before = layer.emitted;
  layer.emit(p);
  assert.equal(layer.emitted, before, 'NaN particle dropped');
  assert.equal(layer.countAlive(1), 8);
  assert.equal(layer.countAlive(3), 0);
  layer.flush(3);
  assert.equal(layer.mesh.visible, false, 'hidden once everything is dead');
  layer.dispose();
});

test('particle layer: frames stepped without a draw keep their particles queued for upload', () => {
  const layer = new ParticleLayer('t', 16, new THREE.ShaderMaterial());
  const p = newRecord();
  p.life = 2;
  const a0 = layer.mesh.geometry.getAttribute('a0') as THREE.InstancedBufferAttribute;
  const a5 = layer.mesh.geometry.getAttribute('a5') as THREE.InstancedBufferAttribute;
  // Two frames, no render in between (Simulation.advance): both frames' slots must go up.
  for (let i = 0; i < 3; i++) layer.emit(p);
  layer.flush(0);
  for (let i = 0; i < 2; i++) layer.emit(p);
  layer.flush(0);
  assert.deepEqual(a0.updateRanges, [{ start: 0, count: 20 }]);
  assert.deepEqual(a5.updateRanges, [{ start: 0, count: 20 }]);
  // The renderer uploads (three.js clears the ranges and reports it): the next frame starts afresh.
  for (const a of [a0, a5]) a.clearUpdateRanges();
  a0.onUploadCallback();
  layer.emit(p);
  layer.flush(0);
  assert.deepEqual(a0.updateRanges, [{ start: 20, count: 4 }]);
  // A scene reset queues the whole pool (every slot was killed).
  layer.clear();
  layer.emit(p);
  layer.flush(0);
  assert.deepEqual(a0.updateRanges, [{ start: 0, count: 64 }]);
  layer.dispose();
});

test('sorted particle layer: draws only the live particles, farthest first, at their current positions', () => {
  const layer = new ParticleLayer('t', 16, new THREE.ShaderMaterial(), { sorted: true });
  const p = newRecord();
  p.life = 2;
  p.drag = 1e-4;
  // Camera at the origin looking down −Z; particles at depths 3, 9, 1, 6 (and one already dead).
  for (const z of [-3, -9, -1, -6]) {
    p.z = z;
    layer.emit(p);
  }
  p.z = -20;
  p.t0 = -5;
  layer.emit(p);
  const cam = new THREE.PerspectiveCamera();
  cam.updateMatrixWorld();
  layer.flush(0.5);
  layer.sort(cam, 0.5, new THREE.Vector3());
  const a0 = layer.mesh.geometry.getAttribute('a0') as THREE.InstancedBufferAttribute;
  const g = layer.mesh.geometry as THREE.InstancedBufferGeometry;
  assert.equal(layer.drawn, 4);
  assert.equal(g.instanceCount, 4);
  assert.deepEqual([0, 1, 2, 3].map((i) => (a0.array as Float32Array)[i * 4 + 2]), [-9, -6, -3, -1]);
  assert.deepEqual(a0.updateRanges, [{ start: 0, count: 16 }]);
  // Turn around: the order reverses. A particle flying towards the camera is sorted where it is now.
  cam.rotation.y = Math.PI;
  cam.updateMatrixWorld();
  layer.sort(cam, 0.5, new THREE.Vector3());
  assert.deepEqual([0, 1, 2, 3].map((i) => (a0.array as Float32Array)[i * 4 + 2]), [-1, -3, -6, -9]);
  p.t0 = 0; p.z = -12; p.vz = 20; // at t = 0.5 it is at z ≈ −2
  layer.emit(p);
  cam.rotation.y = 0;
  cam.updateMatrixWorld();
  layer.sort(cam, 0.5, new THREE.Vector3());
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => (a0.array as Float32Array)[i * 4 + 2]), [-9, -6, -3, -12, -1]);
  // Everything dead: nothing drawn, layer hidden. clear() empties the draw list too.
  layer.flush(10);
  layer.sort(cam, 10, new THREE.Vector3());
  assert.equal(layer.drawn, 0);
  assert.equal(layer.mesh.visible, false);
  assert.equal(layer.countAlive(0.5), 5);
  layer.clear();
  assert.equal(layer.countAlive(0.5), 0);
  assert.equal(g.instanceCount, 0);
  layer.dispose();
});

function fakeSim(): { sim: Simulation; ctx: SimContext; active: Projectile[] } {
  const active: Projectile[] = [];
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 2000);
  camera.position.set(0, 1.7, 20);
  scene.add(camera);
  const nop = () => {};
  const ctx = {
    scene, camera,
    renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280, 720) } as unknown as THREE.WebGLRenderer,
    physics: null as never, registry: null as never, events: new EventBus<SimEvents>(), rng: new Rng(11),
    time: { now: 0, scale: 1, fixedDt: 1 / 60 }, world: new THREE.Group(),
    projectiles: { spawn: () => { throw new Error('none'); }, active }, blasts: { detonate: nop },
    fx: null as never, audio: { unlock: nop, setMuted: nop, muted: true },
    structure: { link: () => 'a', touch: nop, remove: nop, update: nop }, addDestructible: nop, ammo: getAmmo,
  } as unknown as SimContext;
  return { sim: { ctx } as unknown as Simulation, ctx, active };
}

function impact(ctx: SimContext, ammo: string, material: MaterialId): ImpactEvent {
  const a = getAmmo(ammo);
  const m = MATERIALS[material];
  return {
    time: ctx.time.now, ammo: a, agent: 'projectile', point: new THREE.Vector3(0, 1, 0), direction: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 0, 1), obliquity: 0, speed: a.muzzleVelocity, mass: a.mass, kineticEnergy: 0.5 * a.mass * a.muzzleVelocity ** 2,
    outcome: 'embed', depth: 0.03, residualSpeed: 0, craterRadius: 0.03, craterDepth: 0.02, tunnelRadius: a.diameter / 2, spallRadius: 0,
    spallDepth: 0, damageRadius: 0.1, energyAbsorbed: 1000, momentum: new THREE.Vector3(), material: m, targetKind: 'voxel', summary: '',
  };
}

function allFinite(fx: FxSystem): boolean {
  for (const layer of [fx.smokeLayer, fx.fireLayer, fx.sparkLayer]) {
    for (const name of ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']) {
      const arr = (layer.mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute).array as Float32Array;
      for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) return false;
    }
  }
  return true;
}

test('fx system: every event kind at any frame step stays finite and within the particle budget', () => {
  const { sim, ctx, active } = fakeSim();
  const fx = new FxSystem(sim);
  ctx.fx = fx;
  assert.equal(getAtmosphere(ctx.scene).fxRoot, fx.root);
  const ev = ctx.events;
  for (const dt of [1 / 60, 1 / 240, 0.001]) {
    ctx.time.now += dt;
    for (const m of ['concrete', 'granite', 'steel_s355', 'glass_tempered', 'soil', 'brick'] as MaterialId[]) ev.emit('impact', impact(ctx, 'm2ap', m));
    ev.emit('impact', { ...impact(ctx, 'pgu14', 'rha'), agent: 'jet' });
    ev.emit('blast', { center: new THREE.Vector3(0, 0.05, 0), tntKg: 1, kind: 'he', time: ctx.time.now, fireballRadius: 1.75 });
    ev.emit('blast', { center: new THREE.Vector3(5, 2, 0), tntKg: 20, kind: 'thermobaric', casingMass: 3, time: ctx.time.now, fireballRadius: 1.75 * Math.cbrt(20) * 1.6 });
    ev.emit('fracture', { time: ctx.time.now, position: new THREE.Vector3(0, 2, 0), volume: 0.3, pieces: 5, material: MATERIALS.concrete });
    ev.emit('debrisContact', { time: ctx.time.now, position: new THREE.Vector3(1, 0, 1), impulse: 80, size: 0.3, material: MATERIALS.concrete });
    ev.emit('shatter', { time: ctx.time.now, position: new THREE.Vector3(0, 2, 0), area: 2, material: MATERIALS.glass_tempered });
    ev.emit('shot', { time: ctx.time.now, weapon: { id: 'rpg7', name: '', role: '', category: 'launcher', ammo: ['pg7vl'], rpm: 4, fireMode: 'single', dispersionMOA: 1, tracerEvery: 0, delivery: 'direct', recoil: 0.3, sound: '', zoom: 1, muzzleOffset: [0, 0, 0] }, ammo: getAmmo('pg7vl'), origin: new THREE.Vector3(0, 1.5, 10), direction: new THREE.Vector3(0, 0, -1) });
    fx.smoke({ position: new THREE.Vector3(0, 0, 0), radius: 1, duration: 3 });
    fx.shake(0.5);
    // A burning rocket and a tracer in flight.
    active.length = 0;
    active.push({ id: 7, ammo: getAmmo('pg7vl'), position: new THREE.Vector3(0, 1.5, 5 - ctx.time.now * 100), previous: new THREE.Vector3(), velocity: new THREE.Vector3(0, 0, -150), mass: 2, length: 1, age: ctx.time.now, alive: true, tracer: false, perforations: 0, burning: true });
    active.push({ id: 8, ammo: getAmmo('m80'), position: new THREE.Vector3(1, 1.5, 0), previous: new THREE.Vector3(), velocity: new THREE.Vector3(0, 0, -830), mass: 0.0095, length: 0.03, age: 0.05, alive: true, tracer: true, perforations: 0, burning: false });
    for (let f = 0; f < 5; f++) {
      ctx.time.now += dt;
      fx.frameUpdate(dt, 1 / 60);
    }
    assert.ok(allFinite(fx), `finite at dt=${dt}`);
  }
  const s = fx.stats();
  assert.ok(s.smoke! <= BUDGET.smoke && s.fire! <= BUDGET.fire && s.sparks! <= BUDGET.sparks);
  assert.ok(s.smoke! > 100 && s.sparks! > 50, `particles alive ${JSON.stringify(s)}`);
  assert.ok(getAtmosphere(ctx.scene).shake.active, 'shaking after fx.shake');
  fx.reset();
  assert.equal(fx.stats().smoke, 0);
  fx.dispose();
  assert.equal(getAtmosphere(ctx.scene).fxRoot, null);
});

test('fx system: sustained 30 mm fire (GAU-8, 65 rounds/s) is thinned before it overwrites live particles', () => {
  const { sim, ctx } = fakeSim();
  const fx = new FxSystem(sim);
  ctx.fx = fx;
  // One isolated hit: nothing is thinned (full reaction).
  ctx.time.now = 0.01;
  const before = fx.chipLayer.emitted;
  ctx.events.emit('impact', impact(ctx, 'pgu14', 'concrete'));
  const single = fx.chipLayer.emitted - before;
  assert.ok(single >= 80, `single 30 mm hit throws its full chip count (${single})`);
  // Ten seconds of continuous fire into concrete, one fixed step per round.
  const dt = 1 / 65;
  const chipsLife: number[] = [];
  for (let i = 0; i < 650; i++) {
    ctx.time.now += dt;
    const e = impact(ctx, 'pgu14', 'concrete');
    e.point.set((i % 13) * 0.3 - 2, 1 + Math.floor(i / 13) % 5 * 0.3, 0);
    ctx.events.emit('impact', e);
    fx.frameUpdate(dt, dt);
    if (i % 65 === 64) chipsLife.push(fx.chipLayer.emitted);
  }
  const load = fx.poolLoad();
  assert.ok(load.chips < BUDGET.chips * 0.75, `chip load ${load.chips.toFixed(0)} stays under the pool`);
  assert.ok(load.smoke < BUDGET.smoke * 0.75, `smoke load ${load.smoke.toFixed(0)}`);
  assert.ok(load.sparks < BUDGET.sparks * 0.9, `spark load ${load.sparks.toFixed(0)}`);
  // Over the last 5 s fewer chips were emitted than the pool holds: none of them got recycled early.
  const last5 = chipsLife[9]! - chipsLife[4]!;
  assert.ok(last5 < BUDGET.chips, `chips emitted in 5 s of fire: ${last5}`);
  assert.ok(last5 > 500, `the burst still throws debris (${last5})`);
  assert.ok(allFinite(fx));
  fx.dispose();
});

/** Live smoke particles as {pos, size0, size1, t0, life} (what the depth-sorted layer would draw at `now`). */
function smokeParticles(fx: FxSystem, now: number): { x: number; y: number; z: number; s0: number; s1: number; life: number }[] {
  const cam = new THREE.PerspectiveCamera();
  cam.updateMatrixWorld();
  fx.smokeLayer.sort(cam, now + 0.05, new THREE.Vector3()); // puffs are born within ≈ 40 ms
  const g = fx.smokeLayer.mesh.geometry;
  const a0 = (g.getAttribute('a0') as THREE.InstancedBufferAttribute).array as Float32Array;
  const a1 = (g.getAttribute('a1') as THREE.InstancedBufferAttribute).array as Float32Array;
  const a3 = (g.getAttribute('a3') as THREE.InstancedBufferAttribute).array as Float32Array;
  const out = [];
  for (let i = 0; i < fx.smokeLayer.drawn; i++) {
    const t0 = a0[i * 4 + 3]!, life = a1[i * 4 + 3]!;
    if (t0 > now + 1 || now - t0 > life) continue;
    out.push({ x: a0[i * 4]!, y: a0[i * 4 + 1]!, z: a0[i * 4 + 2]!, s0: a3[i * 4]!, s1: a3[i * 4 + 1]!, life });
  }
  return out;
}

test('fx: collapse dust follows fracture surface, not the mass that lost its support', () => {
  // Fines scale with the new fracture area: more pieces, more dust; bounded either way.
  assert.ok(fractureDustRadius(1, 8) > fractureDustRadius(1, 2));
  assert.ok(fractureDustRadius(10, 8) > fractureDustRadius(1, 8));
  for (const [v, n] of [[1e-6, 1], [0.01, 3], [1, 8], [14, 30], [500, 1000]] as const) {
    const r = fractureDustRadius(v, n);
    assert.ok(r >= 0.15 && r <= 1.6, `radius ${r} for ${v} m³ in ${n}`);
  }
  const { sim, ctx } = fakeSim();
  const fx = new FxSystem(sim);
  ctx.fx = fx;
  ctx.time.now = 1;
  // A 35 t slab and a steel column losing support / buckling: no dust from the failure itself.
  ctx.events.emit('structuralFailure', { time: 1, position: new THREE.Vector3(0, 10, 0), label: 'slab', mass: 35000, cause: 'support-lost' });
  ctx.events.emit('structuralFailure', { time: 1, position: new THREE.Vector3(0, 2, 0), label: 'col', mass: 220, cause: 'buckling', material: MATERIALS.steel_s355 });
  assert.equal(fx.smokeLayer.emitted, 0);
  // A crushing concrete column puffs, modestly.
  ctx.events.emit('structuralFailure', { time: 1, position: new THREE.Vector3(3, 1, 0), label: 'pier', mass: 80000, cause: 'crushing', material: MATERIALS.concrete });
  const puffs = smokeParticles(fx, 1);
  assert.ok(puffs.length > 0 && puffs.length <= 12);
  assert.ok(puffs.every((p) => p.s1 < 4.5), 'crushing dust stays a few metres wide');
  fx.dispose();
});

test('fx: a tank gun fired by the viewer makes a brief cloud ahead of the muzzle, not around the eye', () => {
  const { sim, ctx } = fakeSim();
  const fx = new FxSystem(sim);
  ctx.fx = fx;
  ctx.time.now = 1;
  const eye = new THREE.Vector3(0, 1.6, 0);
  const d = new THREE.Vector3(0, 0, -1);
  const muzzle = eye.clone().add(new THREE.Vector3(0, -1.2, -3));
  ctx.events.emit('shot', { time: 1, weapon: { id: 'tankgun', name: '', role: '', category: 'cannon', ammo: ['m829a4'], rpm: 8, fireMode: 'single', dispersionMOA: 1, tracerEvery: 0, delivery: 'direct', recoil: 1, sound: '', zoom: 1, muzzleOffset: [0, -1.2, 3] }, ammo: getAmmo('m829a4'), origin: muzzle, direction: d });
  const puffs = smokeParticles(fx, 1);
  assert.ok(puffs.length > 0);
  for (const p of puffs) {
    assert.ok(p.s1 <= 3.5, `puff half-size ${p.s1.toFixed(2)} m`);
    assert.ok(p.life <= 4, `puff life ${p.life.toFixed(2)} s`);
    // Born at or ahead of the muzzle, never between the muzzle and the eye.
    assert.ok((p.z - muzzle.z) * d.z >= -0.05, 'ahead of the muzzle');
    assert.ok(Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z) > 2.5, 'clear of the eye');
  }
  // The flash light is out within ≈ 0.15 s.
  fx.lights.update(1.15);
  for (const l of fx.lights.group.children as THREE.PointLight[]) assert.ok(l.intensity < 1, `light ${l.intensity}`);
  fx.dispose();
});

test('fx: a 1 kg detonation flash is brief and local', () => {
  const { sim, ctx } = fakeSim();
  const fx = new FxSystem(sim);
  ctx.fx = fx;
  ctx.time.now = 1;
  ctx.events.emit('blast', { center: new THREE.Vector3(0, 1, 0), tntKg: 1, kind: 'shaped', normal: new THREE.Vector3(0, 0, 1), time: 1, fireballRadius: 1.75 });
  const lights = fx.lights.group.children as THREE.PointLight[];
  fx.lights.update(1.004);
  const peak = Math.max(...lights.map((l) => l.intensity));
  assert.ok(peak > 100, `peak ${peak}`);
  const lit = lights.find((l) => l.intensity === peak)!;
  assert.ok(lit.distance > 0 && lit.distance <= 6 * 1.75 + 4 + 1e-9, `reach ${lit.distance}`);
  fx.lights.update(1.06);
  assert.ok(Math.max(...lights.map((l) => l.intensity)) < 0.01 * peak, 'down to 1 % within 60 ms');
  fx.lights.update(1.02);
  assert.ok(Math.max(...lights.map((l) => l.intensity)) < 0.05 * peak, 'down to 5 % within 20 ms');
  // No dotted shock-front puffs: every ground-dust puff of the blast starts within the fireball's reach.
  for (const p of smokeParticles(fx, 1)) assert.ok(Math.hypot(p.x, p.z) < 3 * 1.75, `puff at r = ${Math.hypot(p.x, p.z).toFixed(2)}`);
  fx.dispose();
});

test('fx: chips and sparks stop at a wall in their way (ricochet / die there) with a bounded number of rays', () => {
  const { sim, ctx } = fakeSim();
  // A wall: the plane z = −2 facing +Z (a registry answering rays like one thick slab).
  let rays = 0;
  const wall = { kind: 'voxel', name: 'wall' };
  (ctx as unknown as { registry: unknown }).registry = {
    raycast(o: THREE.Vector3, d: THREE.Vector3, max: number) {
      rays++;
      if (d.z >= -1e-6 || o.z <= -2) return null;
      const t = (-2 - o.z) / d.z;
      return t <= max ? { target: wall, point: o.clone().addScaledVector(d, t), normal: new THREE.Vector3(0, 0, 1), distance: t } : null;
    },
  };
  const fx = new FxSystem(sim);
  ctx.fx = fx;
  ctx.time.now = 1;
  const p = new THREE.Vector3(0, 1.5, 0);
  fx.emitChips(p, new THREE.Vector3(0, 0, -1), 0.3, 30, 100, 0.01, 0x999999, 'stone');
  assert.ok(rays <= 12, `rays for 100 chips: ${rays}`);
  const g = fx.chipLayer.mesh.geometry;
  const c0 = (g.getAttribute('c0') as THREE.InstancedBufferAttribute).array as Float32Array;
  const c1 = (g.getAttribute('c1') as THREE.InstancedBufferAttribute).array as Float32Array;
  const c2 = (g.getAttribute('c2') as THREE.InstancedBufferAttribute).array as Float32Array;
  let ended = 0, ricochets = 0;
  for (let i = 0; i < fx.chipLayer.emitted; i++) {
    const o = i * 4;
    if (c2[o + 1] === 0) {
      // A segment that ends at the wall: where it is at the end of its life is (about) the wall.
      ended++;
      const m = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      motionAt(c0[o]!, c0[o + 1]!, c0[o + 2]!, c1[o]!, c1[o + 1]!, c1[o + 2]!, c2[o]!, 1, 0.48, 0, 0.21, c1[o + 3]!, m);
      assert.ok(Math.abs(m.z + 2) < 0.08, `segment ends at z = ${m.z.toFixed(3)}`);
    } else if (c0[o + 3]! > 1.001) {
      // Its ricochet starts in front of the wall and moves away from it.
      ricochets++;
      assert.ok(c0[o + 2]! > -2 && c0[o + 2]! < -1.9, `ricochet starts at z = ${c0[o + 2]!.toFixed(3)}`);
      assert.ok(c1[o + 2]! > 0, 'bounces off the wall');
    }
  }
  assert.ok(ended > 60 && ended === ricochets, `ended ${ended}, ricochets ${ricochets}`);
  // Sparks die at the wall: nothing lives past it.
  rays = 0;
  fx.emitSparks(p, new THREE.Vector3(0, 0, -1), 200, 60, 1900, 0.3, 0.001, 0);
  assert.ok(rays <= 12, `rays for 200 sparks: ${rays}`);
  const sg = fx.sparkLayer.mesh.geometry;
  const a0 = (sg.getAttribute('a0') as THREE.InstancedBufferAttribute).array as Float32Array;
  const a1 = (sg.getAttribute('a1') as THREE.InstancedBufferAttribute).array as Float32Array;
  const a2 = (sg.getAttribute('a2') as THREE.InstancedBufferAttribute).array as Float32Array;
  for (let i = 0; i < fx.sparkLayer.emitted; i++) {
    const o = i * 4;
    const m = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    motionAt(a0[o]!, a0[o + 1]!, a0[o + 2]!, a1[o]!, a1[o + 1]!, a1[o + 2]!, a2[o]!, 1, 0.48, 0, 0.21, a1[o + 3]!, m);
    assert.ok(m.z > -2.1, `spark ends at z = ${m.z.toFixed(3)}`);
  }
  fx.dispose();
});

