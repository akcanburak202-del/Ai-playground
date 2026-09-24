import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Heightfield } from '../src/destructibles/terrain/heightfield.ts';
import { blastCrater, craterProfile, heightOfBurstFactors, rimWobble } from '../src/destructibles/terrain/crater.ts';
import { Terrain } from '../src/destructibles/terrain/Terrain.ts';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../src/destructibles/Registry.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import { createBlastLoad } from '../src/physics/ballistics/blast.ts';
import { groundOf } from '../src/fx/ground.ts';
import type { SimContext, SimEvents } from '../src/app/contracts.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';
import type { AmmoSpec, ImpactEvent } from '../src/physics/ballistics/types.ts';

test('height field sampling is exact on planes and on the shared triangulation', () => {
  const hf = new Heightfield(10, 0.5, (x, z) => 0.3 * x - 0.2 * z + 1);
  for (const [x, z] of [[0.13, -2.7], [4.9, 4.9], [-5, -5], [1.25, 3.75]] as const) {
    assert.ok(Math.abs(hf.heightAt(x, z) - (0.3 * x - 0.2 * z + 1)) < 1e-5);
    const n = hf.normalAt(x, z);
    const l = Math.hypot(0.3, 1, 0.2);
    assert.ok(Math.abs(n[0]! + 0.3 / l) < 1e-5 && Math.abs(n[1]! - 1 / l) < 1e-5 && Math.abs(n[2]! - 0.2 / l) < 1e-5);
  }
});

test('ray cast finds the surface at the right distance and misses above it', () => {
  const hf = new Heightfield(20, 0.25, () => 0);
  const d = new THREE.Vector3(0.6, -0.5, -0.3).normalize();
  const t = hf.raycast(-2, 3, 1, d.x, d.y, d.z, 100);
  assert.ok(Math.abs(t - 3 / -d.y) < 1e-6, `t = ${t}`);
  assert.equal(hf.raycast(0, 1, 0, 1, 0, 0, 50), -1, 'horizontal ray above ground');
  assert.equal(hf.raycast(0, 1, 0, 0, 1, 0, 50), -1, 'upward ray');
  // Grazing ray over many cells still lands exactly.
  const g = new THREE.Vector3(1, -0.02, 0.37).normalize();
  const tg = hf.raycast(-9, 0.1, -3, g.x, g.y, g.z, 100);
  assert.ok(Math.abs(-9 + g.x * tg + 0) > -10 && Math.abs(0.1 + g.y * tg) < 1e-6, 'grazing hit on the plane');
});

test('crater stamping digs the bowl, raises the lip and updates the bounds', () => {
  const hf = new Heightfield(20, 0.25, () => 0);
  const c = blastCrater(1.0, 0.5, 0, 8);
  const range = hf.stamp(0, 0, c.ejectaRadius, (r, a) => craterProfile(c, r, 0 * a), 0);
  assert.ok(range);
  assert.ok(Math.abs(hf.heightAt(0, 0) + 0.5) < 0.02, `floor ${hf.heightAt(0, 0)}`);
  assert.ok(hf.heightAt(1.0, 0) > 0.05, 'raised lip at the rim');
  assert.ok(hf.minH < -0.45 && hf.maxH > 0.05);
  // A ray straight down into the crater lands on its floor.
  const t = hf.raycast(0, 5, 0, 0, -1, 0, 10);
  assert.ok(Math.abs(t - 5.5) < 0.02);
});

test('height of burst shrinks the crater and removes it for a raised charge', () => {
  assert.deepEqual(heightOfBurstFactors(-0.5, 1), { radius: 1, depth: 1 });
  const mid = heightOfBurstFactors(0.25, 1);
  assert.ok(mid.radius < 1 && mid.radius > 0 && mid.depth < mid.radius);
  assert.deepEqual(heightOfBurstFactors(0.61, 1), { radius: 0, depth: 0 });
  // Cube-root scaling: the same scaled height gives the same factors.
  const a = heightOfBurstFactors(0.2, 1), b = heightOfBurstFactors(0.2 * Math.cbrt(27), 27);
  assert.ok(Math.abs(a.radius - b.radius) < 1e-12);
});

test('rim wobble is bounded and irregular', () => {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 720; i++) {
    const w = rimWobble((i / 720) * Math.PI * 2, 3.3);
    lo = Math.min(lo, w);
    hi = Math.max(hi, w);
  }
  assert.ok(lo > -1.6 && hi < 1.6 && hi - lo > 0.4, `${lo}..${hi}`);
});

async function makeCtx(): Promise<SimContext> {
  const physics = await PhysicsWorld.create();
  physics.defaultGround = physics.createFixed(new THREE.Vector3(0, -1, 0), undefined, [physics.R.ColliderDesc.cuboid(500, 1, 500)]);
  const registry = new DestructibleRegistry();
  const world = new THREE.Group();
  const scene = new THREE.Scene();
  const nop = () => {};
  return {
    scene, camera: new THREE.PerspectiveCamera(60, 1, 0.05, 2000), renderer: null as unknown as THREE.WebGLRenderer,
    physics, registry, events: new EventBus<SimEvents>(), rng: new Rng(3), time: { now: 0, scale: 1, fixedDt: 1 / 60 }, world,
    projectiles: { spawn: () => { throw new Error('none'); }, active: [] }, blasts: { detonate: nop },
    fx: { chips: nop, dust: nop, sparks: nop, smoke: nop, flash: nop, shake: nop }, audio: { unlock: nop, setMuted: nop, muted: true },
    structure: { link: () => 'a', touch: nop, remove: nop, update: nop },
    addDestructible(d: Destructible) { registry.add(d); world.add(d.root); },
    ammo: () => { throw new Error('none'); },
  };
}

test('terrain: plaza probe, blast crater in soil with Rapier colliders following, dispose', async () => {
  const ctx = await makeCtx();
  const basic = new THREE.Mesh();
  basic.name = 'basic-ground';
  ctx.scene.add(basic);
  const t = new Terrain(ctx, { size: 200, detail: 64, plaza: { halfX: 10, halfZ: 8, finish: 'pavers' } });
  ctx.addDestructible(t);
  assert.equal(ctx.physics.defaultGround, null, 'default ground slab removed');
  assert.equal(basic.visible, false, 'basic ground hidden');

  // Plaza: granite setts over soil.
  const down = new THREE.Vector3(0.2, -1, 0.1).normalize();
  const hit = t.raycast(new THREE.Vector3(2, 3, 1), down, 10)!;
  assert.ok(hit && Math.abs(hit.point.y) < 1e-4 && hit.material === MATERIALS.granite);
  const probe = t.probe(hit, down, 2);
  assert.equal(probe.segments[0]!.material, MATERIALS.granite);
  assert.ok(Math.abs(probe.segments[0]!.end - 0.08 / Math.abs(down.dot(hit.normal))) < 1e-9);
  assert.equal(probe.segments[1]!.material, MATERIALS.soil);
  assert.equal(probe.exits, false);
  assert.equal(groundOf(ctx.scene).materialAt(2, 1), MATERIALS.granite);

  // 8 kg TNT on the (flat) plaza: crater ≈ 0.4 W^⅓ = 0.8 m radius, 0.2 W^⅓ = 0.4 m deep.
  const center = new THREE.Vector3(4, 0.02, 3);
  const load = createBlastLoad({ center, tntKg: 8, kind: 'he', normal: new THREE.Vector3(0, 1, 0), contactTargetId: t.id }, 0);
  const cd = load.contactDamage(MATERIALS.soil, 10);
  t.applyBlast(load);
  const floor = t.heightAt(4, 3);
  assert.ok(Math.abs(cd.craterRadius - 0.8) < 0.1 && Math.abs(cd.craterDepth - 0.4) < 0.05, `contact crater ${cd.craterRadius} × ${cd.craterDepth}`);
  assert.ok(floor < -0.6 * cd.craterDepth && floor > -1.2 * cd.craterDepth, `crater floor ${floor} vs depth ${cd.craterDepth}`);
  // Irregular rim: look for the lip crest around the crater (0.8–1.3 R).
  let lip = -Infinity;
  for (let a = 0; a < 64; a++) {
    for (const f of [0.8, 0.95, 1.1, 1.3]) lip = Math.max(lip, t.heightAt(4 + Math.cos((a / 64) * 6.2832) * f * cd.craterRadius, 3 + Math.sin((a / 64) * 6.2832) * f * cd.craterRadius));
  }
  assert.ok(lip > 0.05 && lip < 0.2, `lip crest ${lip}`);
  assert.equal(t.heightAt(4 + 4 * cd.craterRadius, 3), 0, 'undisturbed beyond the ejecta');
  // The paving is shattered over the crater: the surface there is soil now.
  assert.equal(t.surfaceMaterial(4, 3), MATERIALS.soil);
  t.fixedUpdate();
  ctx.physics.step(1 / 60);
  const ray = ctx.physics.castRay(new THREE.Vector3(4, 5, 3), new THREE.Vector3(0, -1, 0), 20);
  assert.ok(ray && Math.abs(ray.point.y - floor) < 0.05, `collider floor ${ray?.point.y} vs ${floor}`);
  // Projectiles see the new surface too.
  const hit2 = t.raycast(new THREE.Vector3(4, 5, 3), new THREE.Vector3(0, -1, 0), 10)!;
  assert.ok(Math.abs(hit2.point.y - floor) < 1e-4 && hit2.material === MATERIALS.soil);

  // A raised charge (3 m, 1 kg) leaves no crater.
  const before = t.heightAt(-20, 20);
  t.applyBlast(createBlastLoad({ center: new THREE.Vector3(-20, 3, 20), tntKg: 1, kind: 'he' }, 0));
  assert.equal(t.heightAt(-20, 20), before);

  // Heavy round pock: 30 mm-class crater digs the field; a rifle round only leaves a decal.
  const ammo = { id: 'x', diameter: 0.03 } as AmmoSpec;
  const ev = { point: new THREE.Vector3(-5, 0, -20), normal: new THREE.Vector3(0, 1, 0), craterRadius: 0.2, craterDepth: 0.15, outcome: 'embed', material: MATERIALS.soil, ammo } as unknown as ImpactEvent;
  t.applyImpact(ev);
  assert.ok(t.heightAt(-5, -20) < -0.05);
  const h0 = t.heightAt(5, -20);
  const ev2 = { ...ev, point: new THREE.Vector3(5, h0, -20), craterRadius: 0.02, craterDepth: 0.01 } as ImpactEvent;
  t.applyImpact(ev2);
  assert.equal(t.heightAt(5, -20), h0);

  t.dispose();
  assert.equal(t.disposed, true);
  assert.equal(basic.visible, true, 'basic ground restored');
});
