/**
 * M1 systems under Node with a real Rapier world: ProjectileSystem (flight, perforation chains,
 * ricochet, fuzes, HEAT jet + blast, fragments), BlastSystem (shock-arrival scheduling in sim time,
 * occlusion, rigid-body impulses, camera shake) and the WeaponController. Targets are the analytic
 * SlabTarget (src/systems/debug), so these tests do not depend on the element modules.
 *
 *   node --test test/ballistics-systems.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createTestSim, type TestSim } from './ballistics-harness.ts';
import { ProjectileSystem } from '../src/systems/ProjectileSystem.ts';
import { BlastSystem, type ExtendedBlastRequest } from '../src/systems/BlastSystem.ts';
import { installBallistics } from '../src/systems/index.ts';
import { SlabTarget, type SlabOptions } from '../src/systems/debug/SlabTarget.ts';
import { createWeaponController } from '../src/weapons/index.ts';
import type { WeaponController } from '../src/weapons/WeaponController.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import { blastAt } from '../src/physics/ballistics/blast.ts';
import { stepFlight } from '../src/physics/ballistics/flight.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';
import type { BlastLoad, ImpactEvent } from '../src/physics/ballistics/types.ts';
import type { BlastEvent } from '../src/app/contracts.ts';

interface Rig extends TestSim {
  projectiles: ProjectileSystem;
  blasts: BlastSystem;
  impacts: ImpactEvent[];
  blastEvents: BlastEvent[];
  slab(o: Partial<SlabOptions> & { name: string; position: THREE.Vector3 }): SlabTarget;
  fire(ammo: string, from: THREE.Vector3, at: THREE.Vector3, target?: THREE.Vector3): void;
}

async function rig(seed = 3): Promise<Rig> {
  const t = await createTestSim(seed);
  const { projectiles, blasts } = installBallistics(t.sim) as { projectiles: ProjectileSystem; blasts: BlastSystem };
  const impacts: ImpactEvent[] = [];
  const blastEvents: BlastEvent[] = [];
  t.ctx.events.on('impact', (e) => impacts.push(e));
  t.ctx.events.on('blast', (e) => blastEvents.push(e));
  return {
    ...t, projectiles, blasts, impacts, blastEvents,
    slab(o) {
      const s = new SlabTarget({ material: MATERIALS.concrete, width: 2, height: 2, thickness: 0.25, ...o });
      t.ctx.addDestructible(s);
      return s;
    },
    fire(ammo, from, at, target) {
      const spec = t.ctx.ammo(ammo);
      projectiles.spawn({ ammo: spec, origin: from.clone(), velocity: at.clone().sub(from).normalize().multiplyScalar(spec.muzzleVelocity), target: target ?? at.clone() });
    },
  };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const byAgent = (list: ImpactEvent[], agent: ImpactEvent['agent']) => list.filter((e) => e.agent === agent);
const within = (v: number, lo: number, hi: number, what: string) => assert.ok(v >= lo && v <= hi, `${what}: ${v} not in [${lo}, ${hi}]`);

test('installBallistics wires ctx.projectiles / ctx.blasts and registers both systems in order', async () => {
  const r = await rig();
  assert.equal(r.ctx.projectiles, r.projectiles);
  assert.equal(r.ctx.blasts, r.blasts);
  assert.deepEqual(r.systems.map((s) => s.name), ['projectiles', 'blasts']);
});

test('perforation chains through several targets, speed falling at each', async () => {
  const r = await rig();
  for (let i = 0; i < 3; i++) r.slab({ name: `plate ${i}`, material: MATERIALS.steel_s355, thickness: 0.006, position: V(0, 1.5, -i * 0.5) });
  r.fire('m2ap', V(0, 1.5, 20), V(0, 1.5, -3));
  r.step(0.2);
  const hits = byAgent(r.impacts, 'projectile');
  assert.deepEqual(hits.map((e) => e.targetName), ['plate 0', 'plate 1', 'plate 2']);
  assert.ok(hits.every((e) => e.outcome === 'perforate'));
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i]!.speed < hits[i - 1]!.speed && hits[i]!.speed <= hits[i - 1]!.residualSpeed + 1);
  // Momentum and energy bookkeeping per plate.
  for (const e of hits) assert.ok(e.energyAbsorbed > 0 && e.momentum.z < 0);
});

test('multi-material run: a reinforced slab is one probe of concrete + rebar + concrete', async () => {
  const r = await rig();
  // Bars at x = k·0.15 m and y = k·0.15 m in the slab plane; aim straight at a crossing.
  const s = r.slab({ name: 'rc slab', thickness: 0.15, position: V(0, 1.5, 0), rebar: { diameter: 0.016, spacing: 0.15, cover: 0.03 } });
  r.fire('m2ap', V(0, 1.5, 20), V(0, 1.5, -1));
  r.step(0.2);
  const e = byAgent(r.impacts, 'projectile')[0]!;
  assert.equal(e.targetName, 'rc slab');
  assert.match(e.summary, /İnşaat demiri/);
  assert.ok(s.log.length === 1);
});

test('grazing hit ricochets off armour and flies on', async () => {
  const r = await rig();
  // A long armour wall whose face points along +x (yaw 90°); the round comes in 4° to the face.
  r.slab({ name: 'grazed wall', material: MATERIALS.rha, width: 40, height: 3, thickness: 0.05, position: V(-5, 1.5, -20), yaw: Math.PI / 2 });
  const g = THREE.MathUtils.degToRad(4);
  const dir = V(-Math.sin(g), 0, -Math.cos(g));
  r.fire('m855', V(-4.3, 1.5, 0), V(-4.3, 1.5, 0).addScaledVector(dir, 30));
  r.step(0.3);
  const e = r.impacts.find((x) => x.targetName === 'grazed wall');
  assert.ok(e, 'the wall was struck');
  assert.equal(e!.outcome, 'ricochet');
  within(THREE.MathUtils.radToDeg(e!.obliquity), 85, 87, 'obliquity');
  assert.ok(e!.residualSpeed > 0 && e!.residualSpeed < e!.speed && e!.residualDirection!.x > 0, 'leaves the face, slower');
});

test('HEAT: jet impact event first, then a small shaped-charge blast on the struck face', async () => {
  const r = await rig();
  const plate = r.slab({ name: 'plate 20', material: MATERIALS.steel_s355, thickness: 0.02, position: V(0, 1.5, 0) });
  const behind = r.slab({ name: 'witness', material: MATERIALS.concrete, thickness: 0.3, position: V(0, 1.5, -1) });
  const order: string[] = [];
  r.ctx.events.on('impact', (e) => order.push(`impact:${e.agent}:${e.targetName}`));
  r.ctx.events.on('blast', (e) => order.push(`blast:${e.kind}`));
  r.fire('m830a1', V(0, 1.5, 30), V(0, 1.5, 0));
  r.step(0.3);
  assert.equal(order[0], 'impact:jet:plate 20');
  assert.ok(order.indexOf('blast:shaped') > 0, `blast after the jet: ${order.join(', ')}`);
  const jet = byAgent(r.impacts, 'jet');
  assert.equal(jet[0]!.outcome, 'perforate');
  // The jet carries on into the witness block (residual capacity) and throws behind-armour debris.
  assert.ok(jet.some((e) => e.targetName === 'witness'));
  assert.ok(r.impacts.some((e) => e.agent === 'fragment'), 'BAD / casing fragments fly as projectiles');
  // The blast is centred just off the plate face, carries the round's filler, and loads the plate as contact.
  const b = r.blastEvents[0]!;
  assert.ok(Math.abs(b.center.z - 0.01) < 0.1 && b.tntKg === r.ctx.ammo('m830a1').explosiveTNT);
  assert.equal(b.contactTargetId, plate.id);
  assert.ok(plate.log.some((l) => l.kind === 'blast'));
  void behind;
});

test('HE impact fuze detonates on the surface; delay fuze detonates inside (tamped)', async () => {
  const r = await rig();
  r.slab({ name: 'wall', thickness: 0.25, position: V(0, 1.5, 0) });
  r.fire('m795', V(0, 1.5, 40), V(0, 1.5, 0));
  r.step(0.2);
  assert.equal(r.blastEvents.length, 1);
  const surf = r.blastEvents[0]!;
  assert.ok(surf.center.z > 0.125 && surf.center.z < 0.3, `impact fuze in front of the face (${surf.center.z.toFixed(3)})`);
  assert.equal(byAgent(r.impacts, 'projectile').filter((e) => e.ammo.id === 'm795').length, 0, 'a PD fuze makes no kinetic impact event');

  const r2 = await rig();
  r2.slab({ name: 'bunker', thickness: 3, width: 4, height: 4, position: V(0, 2, 0) });
  r2.fire('m908', V(0, 2, 40), V(0, 2, 0));
  r2.step(0.3);
  assert.equal(r2.blastEvents.length, 1);
  const buried = r2.blastEvents[0]!;
  assert.ok(buried.center.z < 1.5 - 0.01 && buried.center.z > -1.5, `delay fuze fired inside the block (${buried.center.z.toFixed(3)})`);
  const pen = byAgent(r2.impacts, 'projectile')[0]!;
  assert.equal(pen.ammo.id, 'm908');
  assert.ok(pen.depth > 0.05);
});

test('delay-fuzed penetrator that stops in a thick wall waits for its fuze (BLU-109)', async () => {
  const r = await rig();
  r.slab({ name: 'thick', thickness: 5, width: 6, height: 6, position: V(0, 3, 0) });
  const spec = r.ctx.ammo('gbu31');
  r.projectiles.spawn({ ammo: spec, origin: V(0, 3, 10), velocity: V(0, 0, -290) });
  let tImpact = -1;
  for (let i = 0; i < 600 && r.blastEvents.length === 0; i++) {
    r.step(0.001, 0.001);
    if (tImpact < 0 && r.impacts.length) tImpact = r.ctx.time.now;
  }
  assert.ok(tImpact > 0, 'the bomb struck the wall');
  assert.equal(r.blastEvents.length, 1, 'fuze fired');
  const b = r.blastEvents[0]!;
  const delay = b.time - tImpact;
  assert.ok(Math.abs(delay - spec.fuzeDelay!) < 0.003, `detonated ${(delay * 1000).toFixed(1)} ms after impact (fuze ${spec.fuzeDelay! * 1000} ms)`);
  assert.ok(b.center.z < 2.5 && b.center.z > -2.5, 'inside the wall');
  assert.ok(b.normal && b.normal.z > 0.9, 'buried charge remembers the face it entered through');
});

test('Mk 211: the small charge functions once behind the struck plate; the penetrator flies on', async () => {
  const r = await rig();
  r.slab({ name: 'skin', material: MATERIALS.steel_s355, thickness: 0.004, position: V(0, 1.5, 0) });
  r.slab({ name: 'second', material: MATERIALS.steel_s355, thickness: 0.004, position: V(0, 1.5, -2) });
  r.fire('mk211', V(0, 1.5, 30), V(0, 1.5, -5));
  r.step(0.3);
  assert.equal(r.blastEvents.length, 1, 'exactly one detonation');
  const b = r.blastEvents[0]!;
  assert.ok(b.center.z < 0 && b.center.z > -0.6, `≈0.3 m behind the first plate (${b.center.z.toFixed(2)})`);
  assert.ok(byAgent(r.impacts, 'projectile').some((e) => e.targetName === 'second'), 'core reaches the second plate');
});

test('blast loads arrive when the shock front does (Kingery–Bulmash arrival time, sim time)', async () => {
  const r = await rig();
  const near = r.slab({ name: 'near', thickness: 0.2, position: V(5, 1, 0), yaw: -Math.PI / 2 });
  const far = r.slab({ name: 'far', thickness: 0.2, position: V(40, 1, 0), yaw: -Math.PI / 2 });
  const arrivals: Record<string, number> = {};
  for (const s of [near, far]) {
    const orig = s.applyBlast.bind(s);
    s.applyBlast = (l: BlastLoad) => {
      arrivals[s.name] = r.ctx.time.now;
      orig(l);
    };
  }
  r.blasts.detonate({ center: V(0, 1, 0), tntKg: 1, kind: 'he' });
  // Slow motion: 1 ms steps.
  r.step(0.2, 0.001);
  const W = 1 / 1.8; // 1 m above ground: free air
  const tNear = blastAt(W, near.bounds.distanceToPoint(V(0, 1, 0))).ta;
  const tFar = blastAt(W, far.bounds.distanceToPoint(V(0, 1, 0))).ta;
  assert.ok(Math.abs(arrivals.near! - tNear) < 0.0021, `near: ${arrivals.near} vs ${tNear}`);
  assert.ok(Math.abs(arrivals.far! - tFar) < 0.0021, `far: ${arrivals.far} vs ${tFar}`);
  assert.ok(arrivals.far! > arrivals.near! + 0.05);
  assert.ok(r.blasts.count === 1 && r.blastEvents[0]!.fireballRadius > 0.5);
});

test('occluded targets get a diffracted (weaker) load', async () => {
  const r = await rig();
  r.slab({ name: 'shield', thickness: 0.3, width: 4, height: 4, position: V(3, 2, 0), yaw: -Math.PI / 2 });
  const hidden = r.slab({ name: 'hidden', material: MATERIALS.glass_annealed, thickness: 0.006, width: 1.5, height: 1, position: V(6, 1.5, 0), yaw: -Math.PI / 2 });
  const open = r.slab({ name: 'open', material: MATERIALS.glass_annealed, thickness: 0.006, width: 1.5, height: 1, position: V(0, 1.5, 6), yaw: Math.PI });
  r.blasts.detonate({ center: V(0, 1.5, 0), tntKg: 0.5, kind: 'he' });
  r.step(0.1);
  const pr = (s: SlabTarget) => Number(/Pr ([\d.]+) kPa/.exec(s.log.find((l) => l.kind === 'blast')!.summary)![1]);
  assert.ok(pr(hidden) < 0.5 * pr(open), `hidden ${pr(hidden)} kPa vs open ${pr(open)} kPa`);
});

test('blasts push loose rigid bodies outward and shake the camera when the front reaches it', async () => {
  const r = await rig();
  const p = r.ctx.physics;
  const body = p.createDynamic({ position: V(3, 0.3, 0), colliders: [p.R.ColliderDesc.cuboid(0.2, 0.2, 0.2).setDensity(2400)] });
  r.step(1 / 60); // let Rapier's query pipeline see the body
  r.ctx.camera.position.set(0, 1.7, 12);
  r.ctx.camera.updateMatrixWorld();
  r.blasts.detonate({ center: V(0, 0.3, 0), tntKg: 2, kind: 'he', normal: V(0, 1, 0) });
  r.step(0.002, 0.001);
  assert.ok(body.linvel().x < 0.5, 'not yet: the front needs ≈ 3.4 ms to get there');
  r.step(0.05, 0.001);
  // J = i_r · π r_eq² ≈ 420 Pa·s × 0.19 m² on a 154 kg block → ≈ 0.5 m/s, directed away from the charge.
  const v = body.linvel();
  assert.ok(v.x > 0.2 && v.x < 2 && Math.abs(v.z) < 0.05, `pushed outward (${v.x.toFixed(2)} m/s)`);
  assert.ok(r.shakes.length === 1 && r.shakes[0]! > 0.05 && r.shakes[0]! <= 1, `shake ${r.shakes[0]}`);
});

test('shell fragments are real projectiles that strike nearby targets', async () => {
  const r = await rig();
  const witness = r.slab({ name: 'witness', material: MATERIALS.steel_s355, thickness: 0.003, width: 6, height: 6, position: V(0, 1, -4) });
  r.blasts.detonate({ center: V(0, 1, 0), tntKg: 10.8, kind: 'he', casingMass: 34, gurney: 2440, source: r.ctx.ammo('m795') });
  const frags = r.projectiles.active.filter((p) => p.ammo.kind === 'fragment');
  assert.ok(frags.length >= 24, `${frags.length} fragments`);
  assert.ok(frags.every((f) => f.velocity.length() > 900 && f.velocity.length() < 1600));
  r.step(0.1);
  const hits = r.impacts.filter((e) => e.agent === 'fragment' && e.targetName === 'witness');
  assert.ok(hits.length >= 1, 'the witness plate is hit');
  assert.ok(hits.some((e) => e.outcome === 'perforate'), 'a 3 mm sheet is holed by fragments');
  void witness;
});

test('top-attack launcher flies its scripted loft and hits the aimed point from above', async () => {
  const r = await rig();
  const wall = r.slab({ name: 'target wall', material: MATERIALS.rha, thickness: 0.05, width: 3, height: 3, position: V(0, 1.5, -80) });
  const spec = r.ctx.ammo('javelin');
  const p = r.projectiles.spawn({ ammo: spec, origin: V(0, 1.5, 0), velocity: V(0, 0, -spec.muzzleVelocity), target: V(0, 1.5, -79.975) });
  let top = 0, t = 0;
  while (p.alive && t < 6) {
    r.step(1 / 60);
    t += 1 / 60;
    top = Math.max(top, p.position.y);
  }
  assert.ok(top > 15, `lofted to ${top.toFixed(1)} m`);
  const jet = byAgent(r.impacts, 'jet')[0];
  assert.ok(jet && jet.targetName === 'target wall', 'struck the aimed target');
  assert.ok(jet!.direction.y < -0.5, `from above (dir.y ${jet!.direction.y.toFixed(2)})`);
  void wall;
});

test('RPG-7 rocket visibly flies: boost 115 m/s, motor lights, ≈ 0.5 s to 80 m', async () => {
  const r = await rig();
  r.slab({ name: 'wall', position: V(0, 1.5, 0), width: 4, height: 3 });
  const spec = r.ctx.ammo('pg7vl');
  // Aimed ≈ 1° high, as the PGO-7 range scale would for 80 m.
  const p = r.projectiles.spawn({ ammo: spec, origin: V(0, 1.5, 80), velocity: V(0, 0.0175, -1).normalize().multiplyScalar(spec.muzzleVelocity) });
  let burning = false, t = 0;
  while (p.alive && t < 2) {
    r.step(1 / 60);
    t += 1 / 60;
    burning ||= p.burning;
  }
  assert.ok(burning, 'the sustainer burned');
  assert.ok(t > 0.4 && t < 0.8, `time of flight ${t.toFixed(2)} s`);
  assert.equal(byAgent(r.impacts, 'jet')[0]?.targetName, 'wall');
});

test('WeaponController: auto fire at the cyclic rate, tracers, indirect fire lands on the aim point', async () => {
  const r = await rig();
  const wc = createWeaponController(r.sim) as WeaponController;
  r.slab({ name: 'backstop', width: 20, height: 10, thickness: 1, position: V(0, 5, -40) });
  const cam = r.ctx.camera;
  cam.position.set(0, 1.7, 0);
  cam.lookAt(0, 1.7, -40);
  cam.updateMatrixWorld();
  wc.select('m4a1');
  const shots: number[] = [];
  r.ctx.events.on('shot', (e) => shots.push(e.time));
  wc.setTrigger(true);
  r.step(1.0);
  wc.setTrigger(false);
  // 800 rpm → 13.3 rounds per second.
  assert.ok(wc.roundsFired >= 12 && wc.roundsFired <= 14, `${wc.roundsFired} rounds in 1 s`);
  assert.ok(Math.abs(shots[5]! - shots[4]! - 0.075) < 1e-6, 'rounds spaced 60/rpm inside steps');
  r.step(0.3);
  assert.ok(byAgent(r.impacts, 'projectile').filter((e) => e.targetName === 'backstop').length >= 12);
  // Indirect fire: the shell comes down onto the aim point (on the ground in front of the backstop).
  cam.lookAt(0, 0, -20);
  cam.updateMatrixWorld();
  wc.select('m777');
  r.step(0.4);
  const aim = wc.aimPoint!.clone();
  wc.setTrigger(true);
  r.step(1 / 60);
  wc.setTrigger(false);
  r.step(3.5);
  const b = r.blastEvents.find((e) => e.label === 'M795 HE');
  assert.ok(b, 'the shell detonated');
  assert.ok(Math.hypot(b!.center.x - aim.x, b!.center.z - aim.z) < 15, `landed ${Math.hypot(b!.center.x - aim.x, b!.center.z - aim.z).toFixed(1)} m from the aim point`);
  // Placed charges: stick, then fire on the detonator.
  cam.lookAt(0, 1.7, -40);
  cam.updateMatrixWorld();
  wc.select('demo');
  r.step(2.5); // the howitzer's reload still runs after switching
  wc.setTrigger(true);
  r.step(1 / 60);
  wc.setTrigger(false);
  assert.equal(wc.charges.length, 1);
  const n = r.blastEvents.length;
  wc.detonate();
  r.step(1 / 60);
  assert.equal(wc.charges.length, 0);
  assert.equal(r.blastEvents.length, n + 1);
  assert.equal(r.blastEvents[n]!.kind, 'contact');
});

// ─── Timing inside the fixed step (review fixes) ─────────────────────────────────────────────

/** Time of flight over `dist` metres, integrated finely with the real flight model. */
function timeOfFlight(ammo: string, dist: number, rig: Rig): number {
  const spec = rig.ctx.ammo(ammo);
  const b = { position: V(0, 0, 0), velocity: V(0, 0, -spec.muzzleVelocity), mass: spec.mass, age: 0, burning: false };
  let t = 0;
  while (-b.position.z < dist && t < 5) {
    const prev = b.position.z;
    stepFlight(b, spec, 1e-5);
    t += 1e-5;
    if (-b.position.z >= dist) return t - 1e-5 * ((-b.position.z - dist) / Math.max(prev - b.position.z, 1e-12));
  }
  return t;
}

test('impact events and detonations carry the time inside the step at which they happened', async () => {
  const r = await rig();
  const wall = r.slab({ name: 'wall', thickness: 0.25, position: V(0, 1.5, 0) });
  r.fire('m855', V(0, 1.5, 20.125), V(0, 1.5, 0));
  r.step(0.05);
  const e = byAgent(r.impacts, 'projectile')[0]!;
  const tof = timeOfFlight('m855', 20, r);
  // Steps end at 16.7 and 33.3 ms; the round arrives at ≈ 22.8 ms and the event says so.
  assert.ok(Math.abs(e.time - tof) < 2e-4, `impact at ${(e.time * 1000).toFixed(2)} ms, flight time ${(tof * 1000).toFixed(2)} ms`);

  // A PD-fuzed shell: the detonation is stamped inside the step and its contact target is loaded
  // in that same step (not one step later).
  const r2 = await rig();
  const w2 = r2.slab({ name: 'wall', thickness: 0.25, position: V(0, 1.5, 0) });
  r2.fire('m795', V(0, 1.5, 40), V(0, 1.5, 0));
  let stepOfBlast = -1, stepOfLoad = -1;
  for (let i = 0; i < 20; i++) {
    r2.step(1 / 60);
    if (stepOfBlast < 0 && r2.blastEvents.length) stepOfBlast = i;
    if (stepOfLoad < 0 && w2.log.some((l) => l.kind === 'blast')) stepOfLoad = i;
  }
  assert.ok(stepOfBlast >= 0 && stepOfLoad === stepOfBlast, `blast in step ${stepOfBlast}, contact load in step ${stepOfLoad}`);
  const b = r2.blastEvents[0]!;
  const tofShell = timeOfFlight('m795', 40 - 0.125 - 0.0775, r2);
  assert.ok(Math.abs(b.time - tofShell) < 5e-4, `detonation at ${(b.time * 1000).toFixed(2)} ms vs ${(tofShell * 1000).toFixed(2)} ms`);
  void wall;
});

test('fragments thrown part-way through a step catch up with the clock', async () => {
  const r = await rig();
  r.step(0.1);
  const now = r.ctx.time.now;
  const req: ExtendedBlastRequest = { center: V(0, 5, 0), tntKg: 10.8, kind: 'he', casingMass: 34, gurney: 2440, source: r.ctx.ammo('m795'), time: now - 0.01 };
  r.blasts.detonate(req);
  assert.ok(Math.abs(r.blastEvents[0]!.time - (now - 0.01)) < 1e-12, 'blast stamped with its own time');
  const frags = r.projectiles.active.filter((p) => p.ammo.kind === 'fragment');
  assert.ok(frags.length > 10);
  // Where each fragment should be at the end of the next step: flown from the detonation time.
  const dt = 0.01 + 1 / 60;
  const expected = frags.map((f) => {
    const b = { position: f.position.clone(), velocity: f.velocity.clone(), mass: f.mass, age: 0, burning: false };
    stepFlight(b, f.ammo, dt);
    return b.position;
  });
  r.step(1 / 60);
  let checked = 0;
  for (let i = 0; i < frags.length; i++) {
    const f = frags[i]!;
    if (!f.alive || f.perforations > 0) continue;
    assert.ok(f.position.distanceTo(expected[i]!) < 1e-6, `fragment ${i} is ${f.position.distanceTo(expected[i]!).toFixed(3)} m off`);
    checked++;
  }
  assert.ok(checked > 10);
});

test('the weapon controller times rounds the same whichever system runs first', async () => {
  const times: number[] = [];
  for (const weaponsFirst of [true, false]) {
    const t = await createTestSim(9);
    const wc = weaponsFirst ? (createWeaponController(t.sim) as WeaponController) : null;
    installBallistics(t.sim);
    const w = wc ?? (createWeaponController(t.sim) as WeaponController);
    assert.deepEqual(t.systems.map((s) => s.name), weaponsFirst ? ['weapons', 'projectiles', 'blasts'] : ['projectiles', 'blasts', 'weapons']);
    const slab = new SlabTarget({ name: 'target', material: MATERIALS.concrete, width: 4, height: 4, thickness: 0.3, position: V(0, 1.7, -30) });
    t.ctx.addDestructible(slab);
    const shots: number[] = [];
    const hits: number[] = [];
    t.ctx.events.on('shot', (e) => shots.push(e.time));
    t.ctx.events.on('impact', (e) => hits.push(e.time));
    t.ctx.camera.position.set(0, 1.7, 0);
    t.ctx.camera.lookAt(0, 1.7, -30);
    t.ctx.camera.updateMatrixWorld();
    w.select('m107');
    t.step(0.5);
    w.setTrigger(true);
    t.step(1 / 60);
    w.setTrigger(false);
    t.step(0.2);
    assert.equal(shots.length, 1);
    assert.ok(hits.length >= 1);
    const tof = hits[0]! - shots[0]!;
    assert.ok(tof > 0.025 && tof < 0.045, `time of flight over 29.85 m: ${(tof * 1000).toFixed(1)} ms`);
    times.push(hits[0]!);
  }
  // Same moment to within the integrator's step splitting (was one whole 16.7 ms step apart).
  assert.ok(Math.abs(times[0]! - times[1]!) < 1e-4, `impact at ${times.map((x) => (x * 1000).toFixed(3)).join(' vs ')} ms`);
});

test('a target whose probe finds no material on the shot line is passed without an event', async () => {
  const r = await rig();
  // A ghost surface: its ray test reports a face at z = 1, its probe finds nothing there.
  const ghost: Destructible = {
    id: 99999, kind: 'voxel', name: 'ghost', root: new THREE.Object3D(), bounds: new THREE.Box3(V(-1, 0, 0.9), V(1, 3, 1.1)), disposed: false,
    raycast(o, d, maxDist) {
      if (d.z >= 0) return null;
      const tHit = (1 - o.z) / d.z;
      if (tHit < 0 || tHit > maxDist) return null;
      return { target: ghost, point: o.clone().addScaledVector(d, tHit), normal: V(0, 0, 1), distance: tHit, material: MATERIALS.concrete };
    },
    probe: () => ({ segments: [], exits: true }),
    applyImpact() { throw new Error('ghost must not be struck'); },
    applyBlast() {},
    dispose() {},
  };
  r.ctx.addDestructible(ghost);
  r.slab({ name: 'behind', thickness: 0.25, position: V(0, 1.5, -1) });
  r.fire('m2ap', V(0, 1.5, 20), V(0, 1.5, -2));
  r.step(0.1);
  const hits = byAgent(r.impacts, 'projectile');
  assert.deepEqual(hits.map((e) => e.targetName), ['behind']);
  // A shaped-charge jet started in front of the ghost passes it too, once.
  const n = r.impacts.length;
  r.projectiles.jet(r.ctx.ammo('pg7vl'), 0.5, 0.085, V(0.3, 1.5, 1.2), V(0, 0, -1), 'jet', 3);
  const jets = r.impacts.slice(n).filter((e) => e.agent === 'jet');
  assert.deepEqual(jets.map((e) => e.targetName), ['behind']);
});

test('delay fuze timing is exact at normal step length (BLU-109: 15 ms after first contact)', async () => {
  const r = await rig();
  r.slab({ name: 'thick', thickness: 5, width: 6, height: 6, position: V(0, 3, 0) });
  const spec = r.ctx.ammo('gbu31');
  r.projectiles.spawn({ ammo: spec, origin: V(0, 3, 10), velocity: V(0, 0, -290) });
  r.step(0.2);
  const e = byAgent(r.impacts, 'projectile')[0]!;
  const b = r.blastEvents[0]!;
  assert.ok(Math.abs(b.time - e.time - spec.fuzeDelay!) < 1e-6, `${((b.time - e.time) * 1000).toFixed(3)} ms after contact`);
});
