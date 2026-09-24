import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../src/destructibles/Registry.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import type { GlassPaneSpec, SimContext, SimEvents, StructureApi } from '../src/app/contracts.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';
import { createGlassPane, DICE_CAP, DiceSystem, GlassPane } from '../src/destructibles/glass/index.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { resolveImpact } from '../src/physics/ballistics/penetration.ts';
import { createBlastLoad } from '../src/physics/ballistics/blast.ts';
import { MATERIALS } from '../src/physics/materials.ts';

type Ctx = SimContext & { step(dt?: number): void; shatters: number; shatterArea: number };
const _p = new THREE.Vector3();

/** Headless context: real Rapier world with a ground slab (top at y = 0), no renderer. */
async function makeCtx(): Promise<Ctx> {
  const physics = await PhysicsWorld.create();
  physics.createFixed(new THREE.Vector3(0, -1, 0), undefined, [physics.R.ColliderDesc.cuboid(500, 1, 500)]);
  const registry = new DestructibleRegistry();
  const events = new EventBus<SimEvents>();
  let n = 0;
  const structure: StructureApi = {
    link(_s, supported, region) {
      const id = `a${++n}`;
      supported.structural?.addAnchor(id, region);
      return id;
    },
    touch() {},
    remove() {},
    update() {},
  };
  const nop = () => {};
  const world = new THREE.Group();
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 1, 0.05, 500), renderer: null as unknown as THREE.WebGLRenderer,
    physics, registry, events, rng: new Rng(7), time: { now: 0, scale: 1, fixedDt: 1 / 60 }, world,
    projectiles: { spawn: () => { throw new Error('no projectiles'); }, active: [] },
    blasts: { detonate: nop }, fx: { chips: nop, dust: nop, sparks: nop, smoke: nop, flash: nop, shake: nop },
    audio: { unlock: nop, setMuted: nop, muted: true }, structure,
    addDestructible(d: Destructible) {
      registry.add(d);
      if (!d.root.parent) world.add(d.root);
    },
    ammo: (id: string) => getAmmo(id),
    shatters: 0,
    shatterArea: 0,
    step(dt = 1 / 60) {
      ctx.time.now += dt;
      physics.step(dt);
      for (const d of registry.all()) if (!d.disposed) d.fixedUpdate?.(dt);
      for (const d of registry.all()) if (!d.disposed) d.frameUpdate?.(dt);
      registry.sweep();
    },
  };
  events.on('shatter', (e) => {
    ctx.shatters++;
    ctx.shatterArea += e.area;
  });
  return ctx as unknown as Ctx;
}

function pane(ctx: Ctx, type: GlassPaneSpec['type'], o: Partial<GlassPaneSpec> = {}): GlassPane {
  return createGlassPane(ctx, {
    name: `${type} pane`, type, width: 1.5, height: 1.0, thickness: type === 'laminated' ? 0.0176 : 0.006,
    position: [0, 1.5, 0], framed: true, ...o,
  }) as GlassPane;
}

/** Fire one round from `from` at `at` through the real ray test, probe and terminal-ballistics resolver. */
function shoot(ctx: Ctx, target: Destructible, ammo: string, from: THREE.Vector3, at: THREE.Vector3): boolean {
  const a = getAmmo(ammo);
  const dir = at.clone().sub(from).normalize();
  const hit = target.raycast(from, dir, 100);
  if (!hit) return false;
  const probe = target.probe(hit, dir, 1);
  const ev = resolveImpact({ ammo: a, position: hit.point, velocity: dir.clone().multiplyScalar(a.muzzleVelocity), mass: a.mass, length: a.length, perforations: 0 }, hit, probe, ctx.rng);
  ev.time = ctx.time.now;
  target.applyImpact(ev);
  return true;
}

test('tempered pane: one rifle round dices the whole pane, front first, then the collapse', async () => {
  const ctx = await makeCtx();
  const p = pane(ctx, 'tempered', { width: 3, height: 3, thickness: 0.01, position: [0, 1.6, 0] });
  const from = new THREE.Vector3(0.4, 1.8, 20);
  assert.ok(shoot(ctx, p, 'm855', from, new THREE.Vector3(0.4, 1.8, 0)));
  assert.ok(p.hasFailed(), 'pane failed');
  assert.equal(ctx.shatters, 1);
  // The dice are spawned over a few fixed steps (≤ ~5 ms each).
  for (let k = 0; k < 20; k++) ctx.step(1 / 240);
  assert.ok(Math.abs(ctx.shatterArea - 9) < 1e-9);
  // ~8 mm dice, capped to 20 000 clusters for a 9 m² pane.
  assert.ok(p.stats.dice > 10000 && p.stats.dice <= 20000, `dice ${p.stats.dice}`);
  // The mosaic comes apart within a fraction of a second after the 2 ms crack front.
  assert.ok(p.collapseTime > 0.003 && p.collapseTime < 0.8, `collapse ${p.collapseTime.toFixed(3)} s`);
  // Rounds pass through where the pane was.
  assert.equal(p.raycast(from, new THREE.Vector3(0, 0, -1), 100), null);
  p.dispose();
});

test('tempered heap shows at once when the scene dice ring recycles its dice', async () => {
  const ctx = await makeCtx();
  const p = pane(ctx, 'tempered', { width: 1.5, height: 1.6, thickness: 0.01, position: [0, 1.2, 0] });
  assert.ok(shoot(ctx, p, 'm855', new THREE.Vector3(0.2, 1.3, 10), new THREE.Vector3(0.2, 1.3, 0)));
  for (let k = 0; k < 30; k++) ctx.step(1 / 60);
  const inner = p as unknown as { decals: { appearBy(t: number): void; fade?: unknown }[]; dice: DiceSystem };
  assert.ok(inner.decals.length > 0, 'heap decal built');
  const fadeAt = () => (inner.decals[0] as unknown as { fade: { value: THREE.Vector2 } }).fade.value.x;
  assert.ok(fadeAt() > ctx.time.now + 5, 'heap is due only after the dice have lain for a while');
  // Another pane's blast fills the ring: this pane's dice are overwritten.
  const d = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, release: 0, flight: 0, drag: 0, seed: 0, sx: 0.01, sy: 0.01, sz: 0.01, floor: 0, qx: 0, qy: 0, qz: 0, qw: 1, r: 0, g: 0, b: 0, fadeAt: 1e9, cell: 0.01 };
  for (let k = 0; k < DICE_CAP; k++) inner.dice.write(d);
  ctx.step(1 / 60);
  assert.ok(fadeAt() <= ctx.time.now, `heap appears now (${fadeAt().toFixed(2)} ≤ ${ctx.time.now.toFixed(2)})`);
  p.dispose();
});

test('imposed frame load: the pane breaks at the plate-buckling load (Timoshenko k for its aspect ratio)', async () => {
  const ctx = await makeCtx();
  // 10 mm glass: D = E t³ / 12(1 − ν²) ≈ 6.13 kN·m. Square 1 × 1 m: k = 4 → N_cr·W ≈ 242 kN.
  // Wide 3 × 1 m loaded down its 1 m height: k = (3 + 1/3)² ≈ 11.1 → N_cr·W = k π² D / W ≈ 224 kN.
  for (const [w, h, ncr] of [[1, 1, 242e3], [3, 1, 224e3]] as const) {
    const a = pane(ctx, 'tempered', { width: w, height: h, thickness: 0.01, position: [0, 5, 0] });
    a.setImposedLoad(0.93 * ncr);
    assert.equal(a.hasFailed(), false, `${w}×${h} holds 93 % of N_cr`);
    a.setImposedLoad(1.07 * ncr);
    assert.equal(a.hasFailed(), true, `${w}×${h} breaks at 107 % of N_cr`);
    a.dispose();
  }
});

test('tempered pane shrugs off a shallow chip', async () => {
  const ctx = await makeCtx();
  const p = pane(ctx, 'tempered', { thickness: 0.012 });
  const from = new THREE.Vector3(0, 1.5, 5);
  const dir = new THREE.Vector3(0, 0, -1);
  const hit = p.raycast(from, dir, 100)!;
  const a = getAmmo('m855');
  const ev = resolveImpact({ ammo: a, position: hit.point, velocity: dir.clone().multiplyScalar(a.muzzleVelocity), mass: a.mass, length: a.length, perforations: 0 }, hit, p.probe(hit, dir, 1), ctx.rng);
  ev.outcome = 'embed';
  ev.depth = 0.001;
  ev.craterDepth = 0.0008;
  p.applyImpact(ev);
  assert.equal(p.hasFailed(), false);
});

test('annealed pane: a burst cracks it into shards that fall, land and burst again; holes let rounds through', async () => {
  const ctx = await makeCtx();
  const p = pane(ctx, 'annealed', { thickness: 0.006 });
  const from = new THREE.Vector3(0, 1.5, 15);
  const rng = new Rng(3);
  let hits = 0;
  for (let k = 0; k < 25; k++) {
    const at = new THREE.Vector3(rng.gaussian(0, 0.12), 1.5 + rng.gaussian(0, 0.12), 0);
    if (shoot(ctx, p, 'm855', from, at)) hits++;
    ctx.step(1 / 60);
    ctx.step(1 / 60);
  }
  // Later rounds find holes where pieces have already fallen out and pass straight through.
  assert.ok(hits >= 8 && hits < 25, `hits ${hits}`);
  for (let k = 0; k < 120; k++) ctx.step(1 / 60);
  console.log('annealed burst', { hits, remaining: p.remaining().toFixed(3), ...p.stats, shatters: ctx.shatters });
  assert.ok(p.stats.cracks > 200, `crack segments ${p.stats.cracks}`);
  assert.ok(p.remaining() < 0.99 && p.remaining() > 0.2, `remaining ${p.remaining().toFixed(3)}`);
  assert.ok(p.stats.shards > 0 || p.stats.dice > 0, 'pieces fell out');
  assert.ok(ctx.shatters > 0);
  // Per-hit cost is a logged metric (≈ 5–20 ms here; wall-clock, so a loaded machine can double
  // it): the bound only catches a pathological regression, not scheduling noise.
  console.log('annealed per-hit cost', { impactMs: p.stats.impactMs.toFixed(1), facesMs: p.stats.facesMs.toFixed(1) });
  for (const x of [p.stats.impactMs, p.stats.facesMs]) assert.ok(x < 250, `per-hit cost ${x.toFixed(1)} ms`);
  p.dispose();
});

test('annealed pane under sustained fire at one spot: the hole grows progressively', async () => {
  const ctx = await makeCtx();
  const p = pane(ctx, 'annealed', { width: 1.5, height: 1.6, thickness: 0.008, position: [0, 1.13, 0] });
  const from = new THREE.Vector3(0, 1.2, 11);
  const rng = new Rng(3);
  const A = p.width * p.height;
  const holeArea = () => (1 - p.remaining()) * A;
  const areas: number[] = [];
  let hits = 0;
  for (let k = 1; k <= 40; k++) {
    if (shoot(ctx, p, 'm855', from, new THREE.Vector3(rng.gaussian(0, 0.03), 1.1 + rng.gaussian(0, 0.03), 0))) hits++;
    for (let s = 0; s < 5; s++) ctx.step(1 / 60);
    if (k === 1 || k === 10 || k === 40) {
      for (let s = 0; s < 30; s++) ctx.step(1 / 60);
      areas.push(holeArea());
    }
  }
  const [a1, a10, a40] = areas as [number, number, number];
  // One round: a hole of a few centimetres (bullet hole + exit cone + the loose bits it shakes out),
  // while the rest of its crack star stays in the frame (every piece bears on the ones below it).
  assert.ok(a1 > 5e-4 && a1 < 8e-3, `first round opens ${(a1 * 1e4).toFixed(0)} cm²`);
  assert.ok(a10 > 2 * a1 && a40 >= a10, `hole grows: ${areas.map((a) => (a * 1e4).toFixed(0)).join(' → ')} cm²`);
  assert.ok(a40 < 0.3 * A, 'a tight group does not bring the whole pane down');
  // Later rounds of the group find the hole and pass straight through.
  assert.ok(hits < 40, `hits ${hits}`);
  p.dispose();
});

test('laminated pane: holds together, sags with damage, tears out when heavily blasted', async () => {
  const ctx = await makeCtx();
  const p = pane(ctx, 'laminated', { width: 1.2, height: 1.6, position: [0, 1.2, 0] });
  const from = new THREE.Vector3(0, 1.2, 15);
  const rng = new Rng(9);
  for (let k = 0; k < 30; k++) {
    shoot(ctx, p, 'm855', from, new THREE.Vector3(rng.gaussian(0, 0.25), 1.2 + rng.gaussian(0, 0.3), 0));
    ctx.step(1 / 30);
  }
  for (let k = 0; k < 90; k++) ctx.step(1 / 60);
  assert.equal(p.hasFailed(), false, 'laminated glass stays in the frame under rifle fire');
  assert.ok(p.sag > 0.01, `sag ${(p.sag * 100).toFixed(1)} cm`);
  assert.ok(p.laminatedDamage > 0.2);
  // 10 kg TNT at 3 m is still below the laminated severe curve (D ≈ 1.9): it bulges but stays.
  p.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 1.2, 3), tntKg: 10, kind: 'he' }, ctx.time.now));
  assert.equal(p.hasFailed(), false, 'D < 2: held by the interlayer');
  for (let k = 0; k < 30; k++) ctx.step(1 / 60);
  assert.ok(p.sag > 0.05, `blast bulge ${(p.sag * 100).toFixed(1)} cm`);
  // The registry culls rays by `bounds`: they must follow the bulge.
  {
    const mem = (p as unknown as { membrane: { x: Float64Array; n: number } }).membrane;
    for (let k = 0; k < mem.n; k++) {
      _p.set(mem.x[3 * k]!, mem.x[3 * k + 1]!, mem.x[3 * k + 2]!).applyMatrix4(p.root.matrixWorld);
      assert.ok(p.bounds.containsPoint(_p), `bounds contain the bulged sheet (particle ${k} at z ${_p.z.toFixed(3)})`);
    }
  }
  // 10 kg at 1.2 m: beyond it — the sheet tears out of the frame.
  p.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 1.2, 1.2), tntKg: 10, kind: 'he' }, ctx.time.now));
  assert.ok(p.hasFailed(), 'torn out of the frame');
  // The torn-out sheet falls and comes to rest on the floor (y ≥ 0), in one piece.
  for (let k = 0; k < 180; k++) ctx.step(1 / 60);
  const m = (p as unknown as { membrane: { x: Float64Array; n: number } }).membrane;
  let minY = Infinity;
  for (let k = 0; k < m.n; k++) minY = Math.min(minY, _p.set(m.x[3 * k]!, m.x[3 * k + 1]!, m.x[3 * k + 2]!).applyMatrix4(p.root.matrixWorld).y);
  assert.ok(minY > -0.02 && minY < 0.1, `sheet rests on the floor: lowest point ${minY.toFixed(3)} m`);
  p.dispose();
});

test('P–I hookup: panes fail at the distance the pressure–impulse curve says, tempered ≈ 4× stronger', async () => {
  const ctx = await makeCtx();
  const mat = MATERIALS.glass_annealed;
  // Distance at which a 1 kg TNT free-air burst reaches damage 1 on a 6 mm annealed pane.
  const dmgAt = (R: number, m = mat) => {
    const load = createBlastLoad({ center: new THREE.Vector3(0, 10, R), tntKg: 1, kind: 'he' }, 0);
    return load.damageAt(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, 0, 1), m, 0.006);
  };
  let lo = 1, hi = 200;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (dmgAt(mid) >= 1) lo = mid;
    else hi = mid;
  }
  const Ra = lo;
  lo = 1;
  hi = 200;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (dmgAt(mid, MATERIALS.glass_tempered) >= 1) lo = mid;
    else hi = mid;
  }
  const Rt = lo;
  assert.ok(Rt < Ra, `tempered fails closer (${Rt.toFixed(1)} m) than annealed (${Ra.toFixed(1)} m)`);
  for (const [type, R] of [['annealed', Ra], ['tempered', Rt]] as const) {
    // Each blast in its own step: panes share a per-step budget for blast fracture work (blasts past
    // it are deferred to the next steps), and these assertions are about the P–I hookup only.
    ctx.time.now += 1 / 60;
    const near = pane(ctx, type, { position: [0, 10, 0] });
    near.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 10, 0.75 * R), tntKg: 1, kind: 'he' }, ctx.time.now));
    assert.ok(near.remaining() < 0.9, `${type} at 0.75 R_fail breaks (remaining ${near.remaining().toFixed(2)})`);
    ctx.time.now += 1 / 60;
    const far = pane(ctx, type, { position: [0, 10, 0] });
    far.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 10, 1.5 * R), tntKg: 1, kind: 'he' }, ctx.time.now));
    assert.equal(far.remaining(), 1, `${type} at 1.5 R_fail survives`);
    near.dispose();
    far.dispose();
  }
});

test('blast throws annealed shards away from the charge at the impulse–momentum speed', async () => {
  const ctx = await makeCtx();
  const p = pane(ctx, 'annealed', { position: [0, 1.5, 0] });
  p.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 1.5, 4), tntKg: 2, kind: 'he' }, 0));
  assert.ok(p.remaining() < 0.1, `remaining ${p.remaining()}`);
  // Pieces are spawned over the next steps (bounded cost per step); after 0.12 s they have moved
  // towards −z, away from the charge at z = +4.
  let moved = 0;
  for (let k = 0; k < 7; k++) ctx.step(1 / 60);
  assert.ok(p.stats.shards > 10, `shards ${p.stats.shards}`);
  ctx.physics.world.forEachRigidBody((b) => {
    if (b.isDynamic() && b.translation().z < -0.3) moved++;
  });
  assert.ok(moved > 5, `shards thrown away from the charge: ${moved}`);
  // Stable at slow-motion steps as well.
  for (let k = 0; k < 200; k++) ctx.step(0.001);
  ctx.physics.world.forEachRigidBody((b) => {
    const t = b.translation();
    assert.ok(Number.isFinite(t.x + t.y + t.z));
  });
  p.dispose();
});

test('a blast along a curtain wall: every pane it reaches breaks, the work spread over a few steps', async () => {
  const ctx = await makeCtx();
  const panes = [0, 1, 2, 3, 4, 5].map((k) =>
    pane(ctx, k % 2 ? 'annealed' : 'laminated', { name: `bay ${k}`, position: [(k - 2.5) * 1.6, 1.5, 0] }),
  );
  const load = createBlastLoad({ center: new THREE.Vector3(0, 1.5, 2.5), tntKg: 8, kind: 'he' }, ctx.time.now);
  for (const p of panes) p.applyBlast(load);
  for (let k = 0; k < 6; k++) ctx.step(1 / 240);
  for (const p of panes) {
    if (p.type === 'annealed') assert.ok(p.remaining() < 0.5, `annealed ${p.name} broke: remaining ${p.remaining().toFixed(2)}`);
    else assert.ok(p.laminatedDamage > 0.3, `laminated ${p.name} crazed: damage ${p.laminatedDamage.toFixed(2)}`);
  }
  for (const p of panes) p.dispose();
});

test('a curtain wall of tempered units failing together: bounded work per step, every pane breaks and dices', async () => {
  const ctx = await makeCtx();
  // Tower-like units, 2.06 × 3.51 m, three storeys of nine.
  const wall = Array.from({ length: 27 }, (_, k) =>
    pane(ctx, 'tempered', { name: `unit ${k}`, width: 2.06, height: 3.51, thickness: 0.012, position: [-8.5 + (k % 9) * 2.12, 5.4 + 3.6 * Math.floor(k / 9), 0] }),
  );
  const load = createBlastLoad({ center: new THREE.Vector3(0, 9, 8), tntKg: 80, kind: 'he' }, ctx.time.now);
  const t0 = performance.now();
  for (const p of wall) p.applyBlast(load);
  const times = [performance.now() - t0];
  const brokenAt: number[] = [];
  for (let k = 0; k < 90; k++) {
    const t = performance.now();
    ctx.step(1 / 60);
    times.push(performance.now() - t);
    brokenAt.push(wall.filter((p) => p.hasFailed()).length);
  }
  const broken = wall.filter((p) => p.hasFailed()).length;
  // Wall-clock per step is only logged (noisy on a loaded machine): the budget is 10 ms of deferrable
  // glass work per step; before it was enforced, 45 such panes cost 130–150 ms in one step.
  console.log('curtain wall blast', { worst: times.map((t, i) => [i, +t.toFixed(1)]).sort((a, b) => b[1] - a[1]).slice(0, 5), broken, stepsToBreakAll: brokenAt.indexOf(broken) + 1, maxStepMs: Math.max(...times).toFixed(1), dice: wall.reduce((a, p) => a + p.stats.dice, 0) });
  assert.ok(broken > 15, `panes broken ${broken}`);
  // Deferred blasts drain in shock-front order within a few steps (never starved, never all at once).
  assert.ok(brokenAt.indexOf(broken) < 12, `all broken within ${brokenAt.indexOf(broken) + 1} steps`);
  // Every broken pane spawned its dice within 1.5 s.
  for (const p of wall) if (p.hasFailed()) assert.ok(p.stats.dice > 1000, `${p.name}: ${p.stats.dice} dice`);
  for (const p of wall) p.dispose();
});

test('dispose frees bodies and leaves the registry clean', async () => {
  const ctx = await makeCtx();
  const p = pane(ctx, 'annealed');
  p.applyBlast(createBlastLoad({ center: new THREE.Vector3(0, 1.5, 3), tntKg: 2, kind: 'he' }, 0));
  for (let k = 0; k < 10; k++) ctx.step(1 / 60);
  const before = ctx.physics.dynamicCount;
  assert.ok(before > 0);
  p.dispose();
  assert.equal(ctx.physics.dynamicCount, 0);
  ctx.registry.sweep();
  assert.equal(ctx.registry.size, 0);
});
