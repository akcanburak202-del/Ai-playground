/**
 * Cutting and severing rules of steel members: FM 5-250 steel-cutting charges, the eccentric
 * crushing of a column that lost a flange, what a torn flange leaves, and bearings (a span resting
 * on piers is pinned; a piece left on one bearing tips off).
 *
 *   node --test test/steel-cut.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../src/destructibles/Registry.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import type { SimContext, SimEvents } from '../src/app/contracts.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { createBlastLoad } from '../src/physics/ballistics/blast.ts';
import { createSteelBeam, SteelBeam } from '../src/destructibles/steel/index.ts';
import { contactCut, eccentricAxialArea, fm5250CutArea, sectionProps } from '../src/destructibles/steel/section.ts';

async function makeCtx() {
  const physics = await PhysicsWorld.create();
  const registry = new DestructibleRegistry();
  const world = new THREE.Group();
  const events = new EventBus<SimEvents>();
  const failures: SimEvents['structuralFailure'][] = [];
  events.on('structuralFailure', (e) => failures.push(e));
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null as unknown as THREE.WebGLRenderer, physics, registry,
    events, world, time: { now: 0, scale: 1, fixedDt: 1 / 60 }, rng: new Rng(3),
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
  const step = (dt: number) => {
    ctx.time.now += dt;
    ctx.time.fixedDt = dt;
    physics.step(dt);
    for (const d of registry.all()) if (!d.disposed) d.fixedUpdate?.(dt);
    registry.sweep();
    for (const d of registry.all()) if (!d.disposed) d.frameUpdate?.(dt);
  };
  return { ctx, step, failures };
}

const HEB200 = { type: 'I', h: 0.2, b: 0.2, tw: 0.009, tf: 0.015 } as const;
const HEB300 = { type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 } as const;

/** A 3.6 m HEB 200 ground-storey column (fixed base, loaded head) as in the tower scene. */
function column(ctx: SimContext, load: number): SteelBeam {
  const b = createSteelBeam(ctx, {
    name: 'Kolon', material: 'steel_s355', profile: HEB200, start: [0, 0, 0], end: [0, 3.6, 0], up: [0, 0, 1],
    ends: { start: 'fixed', end: 'fixed' }, finish: 'painted',
  }) as SteelBeam;
  ctx.addDestructible(b);
  b.structural!.setImposedLoad(load);
  return b;
}

function minArea(b: SteelBeam): number {
  let m = 1;
  for (let i = 0; i < b.sim.n; i++) m = Math.min(m, b.sim.areaFraction(i));
  return m;
}

test('FM 5-250: P = 3/8 A cuts an HEB 200 with ≈ 2.1 kg TNT', () => {
  const s = sectionProps(HEB200);
  // A = 78.1 cm² = 12.1 in² → P = 4.54 lb = 2.06 kg.
  const kg = s.A / fm5250CutArea(1);
  assert.ok(kg > 1.95 && kg < 2.2, `${kg.toFixed(2)} kg`);
  // Stronger steel needs more (× √(σ_u / 510 MPa), as the ballistics breach threshold).
  assert.ok(fm5250CutArea(1, 700e6) < fm5250CutArea(1));
  // The cut is centred on the charge: a small charge on a flange face takes that flange first.
  const small = contactCut(s, 0.12, 0, fm5250CutArea(0.76), 0.2);
  assert.ok(small.lost[0]! / s.plates[0]!.A > 0.6, 'near flange mostly cut');
  assert.equal(small.lost[1], 0, 'far flange untouched');
  const full = contactCut(s, 0.12, 0, fm5250CutArea(2.3), 0.4);
  const total = Array.from(full.lost).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - s.A) / s.A < 0.01, 'the whole section');
});

test('a column that lost a flange carries its load eccentrically (N–M interaction)', () => {
  const s = sectionProps(HEB200);
  // One flange gone: A = 48 cm², centroid shifted 58 mm, T-section M_p ≈ 62 kN·m →
  // N_max = 1/(1/N_p + e/M_p) ≈ 0.66 MN at f_y = 355 MPa (hand calculation).
  const Aeff = eccentricAxialArea(s, new Float32Array([0, 1, 1]));
  const N = Aeff * 355e6;
  assert.ok(N > 0.6e6 && N < 0.72e6, `${(N / 1e3).toFixed(0)} kN`);
  assert.ok(Math.abs(eccentricAxialArea(s, new Float32Array([1, 1, 1])) - s.A) < 1e-12, 'intact: the full area');
  // Symmetric loss (both flanges thinned alike) is not eccentric.
  assert.ok(Math.abs(eccentricAxialArea(s, new Float32Array([0.5, 0.5, 1])) - (s.A - s.plates[0]!.A)) < 1e-9);
});

test('a 2.3 kg contact charge on an HEB 200 column cuts it (either face), a 0.76 kg block does not', async () => {
  for (const [at, n] of [[[0, 1, 0.12], [0, 0, 1]], [[0.085, 1, 0.085], [0.7071, 0, 0.7071]]] as const) {
    const { ctx, step, failures } = await makeCtx();
    const b = column(ctx, 0.8e6);
    for (let k = 0; k < 30; k++) step(1 / 60);
    b.applyBlast(createBlastLoad({ center: new THREE.Vector3(...at), tntKg: 2.3, kind: 'contact', contactTargetId: b.id, normal: new THREE.Vector3(...n) }, ctx.time.now));
    assert.ok(b.hasFailed() && b.disposed, `severed from ${at.join(', ')}`);
    assert.equal(failures[0]?.cause, 'severed');
    const pieces = ctx.registry.all().filter((d) => !d.disposed) as SteelBeam[];
    assert.equal(pieces.length, 2);
    // The upper piece hangs from nothing: it drops as a rigid body; the stub stands on its base.
    for (let k = 0; k < 10; k++) step(1 / 60);
    const upper = pieces.find((p) => p.name.endsWith('-b'))!, lower = pieces.find((p) => p.name.endsWith('-a'))!;
    assert.equal(upper.mode, 'rigid');
    assert.equal(lower.mode, 'fixed');
  }
  const { ctx, step, failures } = await makeCtx();
  const b = column(ctx, 0.45e6);
  for (let k = 0; k < 30; k++) step(1 / 60);
  b.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 1, 0.12), tntKg: 0.76, kind: 'contact', contactTargetId: b.id, normal: new THREE.Vector3(0, 0, 1) }, ctx.time.now));
  const a = minArea(b);
  assert.ok(a > 0.5 && a < 0.8, `one M112 block holes the flange: A = ${a.toFixed(2)} A0`);
  for (let k = 0; k < 120; k++) step(1 / 60);
  assert.ok(!b.hasFailed(), `a lightly loaded column stands (${failures.map((f) => f.cause).join()})`);
});

test('a column that lost most of a flange crushes under a heavy load', async () => {
  const { ctx, step, failures } = await makeCtx();
  const b = column(ctx, 0.9e6);
  for (let k = 0; k < 30; k++) step(1 / 60);
  b.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 1, 0.12), tntKg: 1.0, kind: 'contact', contactTargetId: b.id, normal: new THREE.Vector3(0, 0, 1) }, ctx.time.now));
  assert.ok(!b.disposed, 'not cut through');
  let t = 0;
  while (!b.hasFailed() && t < 2) {
    step(1 / 60);
    t += 1 / 60;
  }
  assert.ok(b.hasFailed(), 'fails');
  assert.equal(failures[0]?.cause, 'crushing');
  assert.ok(t < 1, `within ${t.toFixed(2)} s`);
});

/** HEB 300 on its side on two pier bearings (the range's heavy-steel stand). */
function span(ctx: SimContext): SteelBeam {
  const Y = 1.15;
  const b = createSteelBeam(ctx, {
    name: 'HEB 300 kiriş (yan)', material: 'steel_s355', profile: HEB300, start: [-2, Y, 0], end: [2, Y, 0], up: [0, 0, 1],
    ends: { start: 'free', end: 'free' }, finish: 'painted',
  }) as SteelBeam;
  ctx.addDestructible(b);
  for (const x of [-1.8, 1.8]) b.structural!.addAnchor(`pier${x}`, new THREE.Box3(new THREE.Vector3(x - 0.25, 0.95, -0.4), new THREE.Vector3(x + 0.25, 1.05, 0.4)));
  return b;
}

test('a beam resting on bearings is pinned there (one node each), not built in', async () => {
  const { ctx } = await makeCtx();
  const b = span(ctx);
  const locked = Array.from(b.sim.locked).flatMap((l, i) => (l ? [i] : []));
  assert.equal(locked.length, 2, `locked ${locked.join(', ')}`);
  // A column base (region enclosing the member's end) stays clamped over several nodes.
  const c = column(ctx, 0);
  const base = Array.from(c.sim.locked).filter((l) => l).length;
  assert.ok(base >= 1);
});

test('HESH on a beam flange: dent and bow, then a torn flange — the web and rear flange stay', async () => {
  const { ctx, step } = await makeCtx();
  const b = span(ctx);
  for (let k = 0; k < 30; k++) step(1 / 60);
  const hesh = (x: number) => b.applyBlast(createBlastLoad({ center: new THREE.Vector3(x, 1.15, 0.21), tntKg: 4.8, kind: 'hesh', contactTargetId: b.id, normal: new THREE.Vector3(0, 0, 1) }, ctx.time.now));
  const bow = () => {
    let m = 0;
    for (let i = 0; i < b.sim.n; i++) m = Math.max(m, Math.abs(b.sim.x[3 * i + 2]!));
    return m;
  };
  hesh(0);
  for (let k = 0; k < 60; k++) step(1 / 60);
  assert.ok(!b.disposed && minArea(b) > 0.7, 'first round: a dent');
  const bow1 = bow();
  assert.ok(bow1 > 0.02, `and a visible bow: ${(bow1 * 1000).toFixed(0)} mm`);
  hesh(0.04);
  for (let k = 0; k < 60; k++) step(1 / 60);
  assert.ok(!b.disposed, 'the second round does not sever it');
  const a = minArea(b);
  assert.ok(a >= 0.5, `torn flange leaves the web and rear flange: A = ${a.toFixed(2)} A0`);
  assert.ok(bow() > bow1, 'the bow grows');
});

test('a span severed between two bearings: both halves tip off their bearing and fall', async () => {
  const { ctx, step } = await makeCtx();
  const b = span(ctx);
  for (let k = 0; k < 30; k++) step(1 / 60);
  b.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 1.15, 0.2), tntKg: 8, kind: 'contact', contactTargetId: b.id, normal: new THREE.Vector3(0, 0, 1) }, ctx.time.now));
  assert.ok(b.disposed, 'cut through');
  const pieces = ctx.registry.all().filter((d) => !d.disposed) as SteelBeam[];
  assert.equal(pieces.length, 2);
  for (let k = 0; k < 30; k++) step(1 / 60);
  for (const p of pieces) assert.equal(p.mode, 'rigid', `${p.name} falls (centre of mass off its bearing)`);
});

test('an upper-storey column carries its floor on its head: it stands at rest, a close-in blast fails it', async () => {
  const run = async (kg: number) => {
    const { ctx, step, failures } = await makeCtx();
    const b = createSteelBeam(ctx, {
      name: 'Kolon 1', material: 'steel_s355', profile: HEB200, start: [0, 3.6, 0], end: [0, 7.2, 0], up: [0, 0, 1],
      ends: { start: 'free', end: 'free' }, finish: 'painted',
    }) as SteelBeam;
    ctx.addDestructible(b);
    // Standing on the column below (a splice) under 0.8 MN: above the free-headed sway load
    // π²EI/(2L)² ≈ 0.8 MN, so the floor must hold its head sideways (BeamSim.holdHead).
    b.structural!.addAnchor('splice', new THREE.Box3(new THREE.Vector3(-0.15, 3.3, -0.15), new THREE.Vector3(0.15, 3.7, 0.15)));
    b.structural!.setImposedLoad(0.8e6);
    assert.ok(b.sim.roller >= 0 && b.sim.autoRoller, 'the head is held by the floor');
    for (let k = 0; k < 90; k++) step(1 / 60);
    assert.ok(!b.hasFailed(), 'stands at rest');
    if (kg > 0) b.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 5, 1.5), tntKg: kg, kind: 'he' }, ctx.time.now));
    for (let k = 0; k < 60 && !b.hasFailed(); k++) step(1 / 60);
    // The base goes (the column below failed): the floor and the column come down together.
    const failed = b.hasFailed();
    if (!failed) {
      b.structural!.releaseAnchor('splice');
      step(1 / 60);
      step(1 / 60);
      assert.equal(b.mode, 'rigid', 'falls once its base is gone');
    }
    return { failed, causes: failures.map((f) => f.cause) };
  };
  assert.deepEqual(await run(0), { failed: false, causes: ['support-lost'] });
  const r = await run(120);
  assert.ok(r.failed && r.causes[0] === 'buckling', `120 kg at 1.5 m: ${r.causes.join()}`);
});
