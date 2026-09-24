import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVoxelElement } from '../src/destructibles/voxel/index.ts';
import { VoxelElement } from '../src/destructibles/voxel/VoxelElement.ts';
import { Carver } from '../src/destructibles/voxel/carve.ts';
import { makeCtx } from '../src/destructibles/voxel/headless.ts';
import { createBlastLoad, gasLoad } from '../src/physics/ballistics/blast.ts';

const WALL_REBAR = { diameter: 0.012, spacing: 0.2, cover: 0.035, layout: 'two-faces' } as const;
const SLICE = (15 * Math.PI) / 180;

type Body = { linvel(): { x: number; y: number; z: number } };
const bodyOf = (d: VoxelElement) => (d as unknown as { body: Body | null }).body;
const piecesOf = (ctx: Awaited<ReturnType<typeof makeCtx>>) =>
  ctx.registry.all().filter((d): d is VoxelElement => d instanceof VoxelElement && d.dynamic && !d.disposed);

/** A 5 m × 3 m × 0.3 m RC wall standing on the ground, optionally turned about the vertical. */
async function wall(rotY: number, at: [number, number, number] = [0, 1.5, 0]) {
  const ctx = await makeCtx();
  const w = createVoxelElement(ctx, {
    name: 'wall', material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [5, 3, 0.3] }, position: at,
    rotation: rotY ? [0, rotY, 0] : undefined, voxelSize: 0.05, rebar: WALL_REBAR,
  }) as VoxelElement;
  ctx.structure.link('ground', w, new THREE.Box3(new THREE.Vector3(-20, -1, -20), new THREE.Vector3(20, 0.05, 20)));
  return { ctx, w };
}

/** A point `d` m in front of the (rotated) wall's +z face centre, at height y. */
function inFront(rotY: number, d: number, y: number, at: [number, number, number] = [0, 1.5, 0]): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 0.15 + d).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY).add(new THREE.Vector3(at[0], y, at[2]));
}

test('a wall turned 15° takes a stand-off blast like an axis-aligned one (oriented gate, reach on the loaded face)', async () => {
  const lost: number[] = [];
  for (const rot of [0, -SLICE]) {
    const { w } = await wall(rot);
    const before = w.grid.totalSolid;
    // 10 kg at 1.2 m (P–I damage ≈ 1.6 at the centre): cracking and scabbing, no panel failure. The charge
    // lies inside the rotated wall's world AABB (the old gate measured 0 m there).
    const c = inFront(rot, 1.2, 1.5);
    w.applyBlast(createBlastLoad({ center: c, tntKg: 10, kind: 'he' }, 0));
    lost.push((before - w.grid.totalSolid) / before);
    let dmg = 0;
    for (let k = 0; k < w.grid.nz; k++) dmg = Math.max(dmg, w.grid.damage(w.grid.nx >> 1, w.grid.ny >> 1, k));
    assert.ok(dmg > 20, `rot ${rot.toFixed(2)}: no cracking at the wall centre (D·255 = ${dmg})`);
  }
  assert.ok(lost[1]! > 0.4 * lost[0]! && lost[1]! < 2.5 * lost[0]! + 1e-4, `material lost: aligned ${(lost[0]! * 100).toFixed(2)} %, rotated ${(lost[1]! * 100).toFixed(2)} %`);
});

test('confined gas pressure over a whole wall fails it as a panel: large slabs thrown outward at ≈ i_r/(ρt)', async () => {
  const rot = -SLICE;
  const { ctx, w } = await wall(rot);
  const center = inFront(rot, 3, 1.2);
  // The chapel's 12 kg thermobaric: ≈ 200 kPa quasi-static gas pressure, ≈ 9.4 kPa·s impulse.
  const gas = gasLoad(12, true, { volume: 616, ventArea: 6, closed: 0.9, radius: 10 });
  assert.ok(gas);
  const load = createBlastLoad({ center, tntKg: 12, kind: 'thermobaric' }, 0, { gas });
  const before = w.grid.totalSolid;
  w.applyBlast(load);
  const pieces = piecesOf(ctx);
  assert.ok(w.grid.totalSolid < 0.05 * before, `wall kept ${((100 * w.grid.totalSolid) / before).toFixed(1)} %`);
  assert.ok(pieces.length >= 8 && pieces.length <= 32, `${pieces.length} pieces`);
  // Large slabs through the whole thickness, not 10 cm plugs.
  const big = pieces.filter((p) => p.grid.solidVolume() > 0.1).length;
  assert.ok(big >= 0.75 * pieces.length, `${big} of ${pieces.length} pieces over 0.1 m³`);
  // Thrown away from the charge; no faster than the rigid-plastic plate v = i_r / (ρ t).
  const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
  const vMax = load.reflectedImpulseAt(inFront(rot, 0, 1.5), n) / (2400 * 0.3);
  let out = 0;
  for (const p of pieces) {
    const v = bodyOf(p)!.linvel();
    const along = -(v.x * n.x + v.y * n.y + v.z * n.z);
    const sp = Math.hypot(v.x, v.y, v.z);
    assert.ok(sp < 1.3 * vMax + 1.5, `piece at ${sp.toFixed(1)} m/s (i_r/ρt = ${vMax.toFixed(1)})`);
    if (along > 0.5 * sp) out++;
  }
  assert.ok(out >= 0.9 * pieces.length, `${out} of ${pieces.length} pieces thrown away from the charge`);
  // The empty parent leaves the structure after its support check.
  for (let i = 0; i < 12; i++) ctx.step();
  assert.ok(w.disposed, 'emptied wall not disposed');
});

test('a round cannot slip through a hole narrower than itself', async () => {
  const ctx = await makeCtx();
  const w = createVoxelElement(ctx, {
    name: 'wall', material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [2, 2, 0.3] }, position: [0, 1, 0], voxelSize: 0.025,
  }) as VoxelElement;
  // An 80 mm hole straight through the wall at its centre.
  new Carver(w.grid).carve(-0.1, -0.1, -0.3, 0.1, 0.1, 0.3, (x, y) => Math.hypot(x, y) - 0.04, { lobe: 0, lobeScale: 1, grain: 0, seed: 0 });
  const o = new THREE.Vector3(0, 1, 2), d = new THREE.Vector3(0, 0, -1);
  assert.ok(w.raycast(o, d, 5) === null, 'a thin ray should pass the open hole');
  assert.ok(w.raycast(o, d, 5, 0.01) === null, 'a 20 mm round fits through an 80 mm hole');
  const hit = w.raycast(o, d, 5, 0.06);
  assert.ok(hit !== null, 'a 120 mm round must strike the rim of an 80 mm hole');
  assert.ok(Math.abs(hit.distance - 1.85) < 0.03, `struck at ${hit.distance.toFixed(3)} m (face at 1.85 m)`);
  // Off-centre: a 20 mm round whose edge overlaps the rim strikes it too.
  assert.ok(w.raycast(new THREE.Vector3(0.035, 1, 2), d, 5, 0.01) !== null, 'rim clipped off-centre');
});

test('the contact-gain limit keeps real momentum transfer: a slab landing on a block pushes it at about its own speed', async () => {
  const ctx = await makeCtx();
  const mk = (name: string, size: [number, number, number], y: number, voxel: number) => {
    const el = createVoxelElement(ctx, {
      name, material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size }, position: [0, y, 0], voxelSize: voxel, dynamic: true,
    }) as VoxelElement;
    const b = (el as unknown as { body: { wakeUp(): void } & Body }).body;
    b.wakeUp();
    return b;
  };
  // A 10 cm, 2.4 kg block on the ground; a 2 × 0.3 × 2 m, 2.9 t slab lands on it from 1.5 m.
  const small = mk('block', [0.1, 0.1, 0.1], 0.05, 0.02);
  mk('slab', [2, 0.3, 2], 1.8, 0.05);
  let vMax = 0;
  for (let i = 0; i < 90; i++) {
    ctx.step();
    const v = small.linvel();
    vMax = Math.max(vMax, Math.hypot(v.x, v.y, v.z));
  }
  // The slab arrives at √(2 g · 1.5 m) ≈ 5.4 m/s: the block may be pushed at up to about that
  // (Newton's restitution bound, which the limit allows), but not shot out.
  assert.ok(vMax > 2 && vMax < 9, `block pushed at ${vMax.toFixed(1)} m/s`);
});
