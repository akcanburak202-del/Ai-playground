/**
 * Ballistic gelatin and the gel dummy: the wound-profile model (gel.ts) against the FBI calibration
 * shot and published rifle wound profiles, the dummy's anatomy and ray tests, and its behaviour
 * under real projectiles and blasts (ProjectileSystem, BlastSystem, Rapier) under Node.
 *
 *   node --test test/gel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createTestSim } from './ballistics-harness.ts';
import { installBallistics } from '../src/systems/index.ts';
import { AMMO } from '../src/physics/ballistics/ammo.ts';
import { cavityRadius, fissureRadius, marchTissue, ponceletDepth, resolveTissue, SPHERE_CD, GEL_RESISTANCE } from '../src/physics/ballistics/gel.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import { Rng } from '../src/core/rng.ts';
import type { ImpactEvent, ThicknessProbe } from '../src/physics/ballistics/types.ts';
import { createDummy, createGelBlock, gelBlock, mannequin, type GelRig } from '../src/destructibles/gel/index.ts';
import { GelShell, pairCrossings } from '../src/destructibles/gel/geometry.ts';
import type { RayHit } from '../src/destructibles/Destructible.ts';

const GEL = MATERIALS.gelatin;
const BONE = MATERIALS.bone_sim;
const gelRun = (L: number): ThicknessProbe => ({ segments: [{ material: GEL, start: 0, end: L, strength: 1 }], exits: true });

// ─── The gel model ──────────────────────────────────────────────────────────────────────────

test('FBI calibration: a 4.5 mm steel BB at 180 m/s penetrates 8.5 ± 1 cm of 10 % gel', () => {
  const m = 7850 * (4 / 3) * Math.PI * 0.00225 ** 3;
  const x = ponceletDepth(180, m, Math.PI * 0.00225 ** 2, SPHERE_CD, GEL.density, GEL_RESISTANCE);
  assert.ok(x > 0.075 && x < 0.095, `BB depth ${x}`);
});

test('M855 at 900 m/s: 12 cm neck, breaks up when it turns, 28–45 cm, cavity ≈ 10–14 cm across', () => {
  const a = AMMO.m855!;
  const r = marchTissue(a, 900, a.mass, a.length, gelRun(1), new Rng(1));
  const w = r.wound;
  assert.ok(w.stopped, 'stays in a long block');
  assert.ok(w.neck > 0.1 && w.neck < 0.14, `neck ${w.neck}`);
  assert.ok(w.fragmentedAt > 0.12 && w.fragmentedAt < 0.18, `fragmented at ${w.fragmentedAt}`);
  assert.ok(w.massLost > 0.3 * a.mass && w.massLost < 0.5 * a.mass);
  assert.ok(w.length > 0.28 && w.length < 0.45, `depth ${w.length}`);
  assert.ok(2 * w.maxCavity > 0.09 && 2 * w.maxCavity < 0.14, `cavity Ø ${2 * w.maxCavity}`);
  assert.ok(w.maxCavityAt > 0.12 && w.maxCavityAt < 0.18, `cavity at ${w.maxCavityAt}`);
  assert.ok(w.fragments.length >= 5, 'fragment side channels');
});

test('M855 below the break-up speed stays whole; M80 at 840 m/s goes 45–70 cm with a 16 cm neck', () => {
  const a = AMMO.m855!;
  const slow = marchTissue(a, 700, a.mass, a.length, gelRun(1), new Rng(1)).wound;
  assert.equal(slow.fragmentedAt, -1);
  const b = AMMO.m80!;
  const w = marchTissue(b, 840, b.mass, b.length, gelRun(1.5), new Rng(1)).wound;
  assert.ok(w.neck > 0.14 && w.neck < 0.18, `neck ${w.neck}`);
  assert.ok(w.length > 0.45 && w.length < 0.7, `depth ${w.length}`);
  assert.ok(2 * w.maxCavity > 0.11 && 2 * w.maxCavity < 0.18, `cavity Ø ${2 * w.maxCavity}`);
});

test('a round that went through a barrier yaws at once; a struck bone breaks and destabilises it', () => {
  const a = AMMO.m855!;
  const fresh = marchTissue(a, 700, a.mass, a.length, gelRun(0.4), new Rng(2)).wound;
  const through = marchTissue(a, 700, a.mass, a.length, gelRun(0.4), new Rng(2), 0, true).wound;
  assert.ok(through.neck >= 0 && through.neck < 0.03, `destabilised neck ${through.neck}`);
  assert.ok(through.length < fresh.length, 'a yawing round stops sooner');
  const probe: ThicknessProbe = {
    segments: [
      { material: GEL, start: 0, end: 0.03, strength: 1 },
      { material: BONE, start: 0.03, end: 0.036, strength: 1 },
      { material: GEL, start: 0.036, end: 0.046, strength: 1 },
      { material: BONE, start: 0.046, end: 0.052, strength: 1 },
      { material: GEL, start: 0.052, end: 0.4, strength: 1 },
    ],
    exits: true,
  };
  const boned = marchTissue(a, 700, a.mass, a.length, probe, new Rng(2)).wound;
  assert.ok(boned.bones.length === 2 && boned.bones.every((b) => b.broken));
  assert.ok(boned.neck >= 0 && boned.neck < fresh.neck, `neck ${boned.neck} vs ${fresh.neck}`);
  assert.ok(boned.fragments.length >= 2, 'bone splinters');
});

test('cavity and tears: π R² σ_c = dE/dx, tears reach where the hoop strain passes the failure strain', () => {
  const R = cavityRadius(20000);
  assert.ok(Math.abs(Math.PI * R * R * 1.8e6 - 20000) < 1e-6);
  const r = fissureRadius(R);
  assert.ok(Math.abs(Math.sqrt(1 + (R * R) / (r * r)) - 1 - 1.0) < 1e-9);
});

test('resolveTissue conserves energy and momentum and carries the yaw on', () => {
  const a = AMMO.m80!;
  const hit = { target: { kind: 'gel', name: 'x' }, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), distance: 0, material: GEL } as unknown as RayHit;
  const p = { ammo: a, position: new THREE.Vector3(), velocity: new THREE.Vector3(0, 0, -840), mass: a.mass, length: a.length, perforations: 0 };
  const ev = resolveTissue(p, hit, gelRun(0.25), new Rng(4));
  assert.equal(ev.outcome, 'perforate');
  assert.ok(ev.residualSpeed > 100 && ev.residualSpeed < 840);
  const keOut = 0.5 * ev.residualMass * ev.residualSpeed ** 2;
  assert.ok(Math.abs(ev.kineticEnergy - keOut - ev.energyAbsorbed) < 1e-6 * ev.kineticEnergy);
  assert.ok(ev.momentum.z < 0 && ev.momentum.length() < a.mass * 840);
  assert.ok((ev.residualTissuePath ?? 0) > 0.24, 'tissue path carried on');
  assert.ok(ev.wound && ev.wound.s.length > 10 && ev.wound.cavity.every((c, i) => c >= ev.wound!.crush[i]!));
});

// ─── Anatomy and geometry ───────────────────────────────────────────────────────────────────

test('the mannequin weighs 70–85 kg of gel in 11 watertight pieces; the FBI block is 9–10 kg', () => {
  const segs = mannequin();
  assert.equal(segs.length, 11);
  let v = 0;
  for (const s of segs) {
    for (const sh of s.shells) {
      const g = new GelShell(sh, [0, 0, 0]);
      v += g.volume();
      // Any line through the shell crosses it an even number of times.
      const c = g.box.getCenter(new THREE.Vector3());
      for (const d of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0.3, 0.2, 0.9).normalize()]) {
        const ts: number[] = [];
        g.crossings(c.clone().addScaledVector(d, -3), d, ts);
        const iv: number[] = [];
        pairCrossings(ts, iv);
        assert.equal(iv.length % 2, 0);
        assert.ok(iv.length >= 2, `${s.id} line misses its own centre`);
        assert.ok(g.depthOf(c) > 0, `${s.id} centre inside`);
      }
    }
  }
  assert.ok(v * GEL.density > 70 && v * GEL.density < 85, `mass ${v * GEL.density}`);
  const b = new GelShell(gelBlock()[0]!.shells[0]!, [0, 0, 0]);
  assert.ok(b.volume() * GEL.density > 9 && b.volume() * GEL.density < 10);
});

// ─── The dummy under fire ───────────────────────────────────────────────────────────────────

async function range() {
  const t = await createTestSim(7);
  installBallistics(t.sim);
  const impacts: ImpactEvent[] = [];
  t.ctx.events.on('impact', (e) => impacts.push(e));
  const step = (sec: number) => {
    for (let x = 0; x < sec - 1e-9; x += 1 / 60) {
      t.ctx.time.now += 1 / 60;
      t.ctx.time.fixedDt = 1 / 60;
      for (const s of t.systems) s.fixedUpdate?.(1 / 60);
      t.ctx.physics.step(1 / 60);
      for (const d of t.ctx.registry.all()) if (!d.disposed) d.fixedUpdate?.(1 / 60);
      t.ctx.registry.sweep();
    }
    for (const d of t.ctx.registry.all()) if (!d.disposed) d.frameUpdate?.(1 / 30);
  };
  const fire = (ammo: string, from: THREE.Vector3, at: THREE.Vector3) => {
    const a = t.ctx.ammo(ammo);
    t.ctx.projectiles.spawn({ ammo: a, origin: from.clone(), velocity: at.clone().sub(from).normalize().multiplyScalar(a.muzzleVelocity) });
  };
  return { ...t, impacts, step, fire };
}

const seg = (rig: GelRig, id: string) => rig.segments.find((s) => s.spec.id === id)!;

test('the dummy stands on its stand; a ray through the chest meets gel, ribs and spine', async () => {
  const r = await range();
  const rig = createDummy(r.ctx, { name: 'D', position: [0, 0, 0] });
  r.step(1);
  const torso = seg(rig, 'torso');
  assert.ok(Math.abs(torso.root.position.y - 1.255) < 0.01, 'torso held at chest height');
  // On the midline at the height of a rib (ribs every 28 mm from 1.17 m, 13 mm high): rib, spine, rib.
  const o = new THREE.Vector3(0, 1.17 + 5 * 0.028 + 0.006, 2), d = new THREE.Vector3(0, 0, -1);
  const hit = r.ctx.registry.raycast(o, d, 5)!;
  assert.equal(hit.target, torso);
  assert.ok(hit.normal.z > 0.9, 'front-facing normal');
  const probe = torso.probe(hit, d, 1);
  const len = probe.segments[probe.segments.length - 1]!.end;
  assert.ok(len > 0.2 && len < 0.26, `chest depth ${len}`);
  assert.ok(probe.exits);
  const bone = probe.segments.filter((s) => s.material.id === 'bone_sim');
  assert.ok(bone.length >= 3, `bone crossings ${bone.length}`);
});

test('rifle fire leaves wound channels but does not knock the dummy off its stand', async () => {
  const r = await range();
  const rig = createDummy(r.ctx, { name: 'D', position: [0, 0, 0] });
  r.step(0.5);
  for (let i = 0; i < 3; i++) {
    r.fire('m855', new THREE.Vector3(0, 1.3, 20), new THREE.Vector3(0.02 * i, 1.3, 0));
    r.step(0.15);
  }
  const gelHits = r.impacts.filter((e) => e.material.class === 'tissue');
  assert.ok(gelHits.length >= 3 && gelHits.every((e) => e.wound && e.wound.length > 0.05));
  assert.ok(seg(rig, 'torso').wounds.length >= 3);
  assert.equal(rig.released, false);
  assert.ok(rig.segments.every((s) => !s.disposed), 'nothing bursts');
});

test('a 30 mm round bursts a thigh (the shin comes loose); a nearby kilogram of TNT tears the dummy off its stand', async () => {
  const r = await range();
  const rig = createDummy(r.ctx, { name: 'D', position: [0, 0, 0] });
  r.step(0.5);
  r.fire('pgu14', new THREE.Vector3(0.1, 0.7, 25), new THREE.Vector3(0.1, 0.7, 0));
  r.step(0.3);
  assert.ok(seg(rig, 'thigh-l').disposed, 'thigh burst');
  assert.equal(seg(rig, 'shin-l').disposed, false, 'the shin is loose, not gone');
  r.ctx.blasts.detonate({ center: new THREE.Vector3(0, 0.6, 1.5), tntKg: 1, kind: 'he' });
  r.step(1.5);
  assert.equal(rig.released, true);
  assert.ok(seg(rig, 'torso').root.position.y < 0.8, 'the torso came down');
});

test('a .50 BMG bursts an FBI block; a 5.56 mm round stays in one and nudges it', async () => {
  const r = await range();
  const a = createGelBlock(r.ctx, { name: 'A', position: [0, 0.077, 0] });
  const b = createGelBlock(r.ctx, { name: 'B', position: [2, 0.077, 0] });
  r.step(0.5);
  const p0 = b.segments[0]!.root.position.clone();
  r.fire('m33', new THREE.Vector3(0, 0.08, 10), new THREE.Vector3(0, 0.077, 0));
  r.fire('m855', new THREE.Vector3(2, 0.08, 10), new THREE.Vector3(2, 0.077, 0));
  r.step(0.5);
  assert.ok(a.segments[0]!.disposed, '.50 burst the block');
  const bb = b.segments[0]!;
  assert.equal(bb.disposed, false);
  const w = bb.wounds[0]!;
  assert.ok(w.profile.stopped && w.bullet, 'the 5.56 stays in the 41 cm block');
  assert.ok(bb.root.position.distanceTo(p0) > 0.001, 'the block was pushed');
});
