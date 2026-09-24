import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FxSystem, BUDGET } from '../src/fx/FxSystem.ts';
import { ParticleLayer, newRecord } from '../src/fx/ParticleLayer.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import { MATERIALS, type MaterialId } from '../src/physics/materials.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { getAtmosphere } from '../src/render/atmosphere.ts';
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
