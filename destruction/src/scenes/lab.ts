import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneDef, SimContext } from '../app/contracts.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import { createDummy, createGelBlock } from '../destructibles/gel/index.ts';
import { MATERIALS } from '../physics/materials.ts';
import type { SceneLook } from './look.ts';
import { Site, type V3 } from './kit.ts';

/**
 * Balistik Laboratuvarı — the ballistic dummy range. Five gel dummies (10 % ordnance gelatin
 * around a synthetic skeleton, 1.80 m, 76 kg) on steel stands 20 m down an open-air lane: one
 * bare, one behind laminated glass, one behind a 6 mm S355 plate, one behind half-brick masonry
 * and one wearing an 8 mm armour-steel chest plate — the same round, five different wound
 * profiles, each decided by the barrier's model and then by the gel model. On a table to the
 * right, three FBI-protocol gel blocks (one with a synthetic femur cast in); an earth berm behind
 * catches what goes through.
 *
 * Everything the targets show follows from gel.ts: the neck before the bullet yaws, the break-up
 * of lead-core ball, the temporary cavity (which pulsates for a few ms — watch it in slow motion),
 * the tears it leaves, bones that break and destabilise the bullet, and pieces that burst when the
 * cavity outgrows them. A blast or a 30 mm hit tears a dummy off its stand as a ragdoll.
 */

/** Target line (z) and firing distance, m */
const LINE = 0;
const FIRING = 20;
const HALF_X = 16;
/** Barriers stand this far in front of their dummy, m */
const SHIELD = 1.2;

export const labLook: SceneLook = { sky: { turbidity: 2.8, rayleigh: 1.6 }, exposure: 1.0, fov: 55, visibility: 9000, glassProbes: true };

export const lab: SceneDef = {
  id: 'lab',
  name: 'Ballistics Lab',
  nameTr: 'Balistik Laboratuvarı',
  blurb: 'Ballistic gel dummies (10 % gelatin, synthetic skeleton, 1.80 m / 76 kg) on steel stands 20 m down an open-air lane: bare, behind laminated glass, behind 6 mm S355, behind half-brick masonry, and with an 8 mm armour-steel chest plate; three FBI gel blocks on a table (one with a synthetic femur). Wound channel, yaw, fragmentation, temporary cavity, broken bones, ragdoll.',
  blurbTr: 'Açık hava atış hattında 20 m ileride çelik standlar üzerinde balistik jel mankenler (%10 jelatin, sentetik iskelet, 1,80 m / 76 kg): çıplak, lamine cam arkasında, 6 mm S355 levha arkasında, yarım tuğla duvar arkasında ve 8 mm zırh çeliği göğüs plakalı; masada üç FBI jel bloğu (biri sentetik uyluk kemikli). Yara kanalı, sapma, parçalanma, geçici boşluk, kemik kırığı, ragdoll.',
  spawn: { position: [0, 1.65, FIRING - 6], lookAt: [0, 1.15, LINE] },
  sun: { elevation: 14, azimuth: 235 },
  build(ctx, make) {
    const site = new Site(ctx, make);
    site.look(labLook);
    site.time('terrain', () => createTerrain(ctx, { plaza: { halfX: HALF_X, halfZ: 14, finish: 'concrete' } }));
    const signs: { x: number; lines: string[] }[] = [];
    const frames: THREE.BufferGeometry[] = [];
    const xs = [-8, -4, 0, 4, 8];

    // 1. Bare dummy.
    site.time('gel', () => createDummy(ctx, { name: 'Manken A', position: [xs[0]!, 0, LINE] }));
    signs.push({ x: xs[0]!, lines: ['MANKEN A · ÇIPLAK', '%10 jelatin, sentetik iskelet', 'Bare gel dummy'] });

    // 2. Behind laminated glass (a windscreen-type 6 + 6 mm PVB laminate).
    site.time('gel', () => createDummy(ctx, { name: 'Manken B', position: [xs[1]!, 0, LINE] }));
    site.glass({ name: 'Lamine cam 6+6', type: 'laminated', width: 1.2, height: 1.6, thickness: 0.0128, position: [xs[1]!, 1.2, LINE + SHIELD], framed: true });
    frames.push(...frame(xs[1]!, 1.2, 1.2, 1.6, LINE + SHIELD));
    signs.push({ x: xs[1]!, lines: ['MANKEN B · CAM ARKASI', 'Lamine cam 6+6 mm PVB', 'Behind laminated glass'] });

    // 3. Behind a 6 mm structural-steel plate.
    site.time('gel', () => createDummy(ctx, { name: 'Manken C', position: [xs[2]!, 0, LINE] }));
    site.plate({
      name: 'S355 levha 6 mm', material: 'steel_s355', width: 1.0, height: 1.2, thickness: 0.006, position: [xs[2]!, 1.25, LINE + SHIELD],
      edges: { top: true, bottom: true, left: true, right: true }, finish: 'mill-scale',
    });
    frames.push(...frame(xs[2]!, 1.25, 1.0, 1.2, LINE + SHIELD));
    signs.push({ x: xs[2]!, lines: ['MANKEN C · ÇELİK ARKASI', 'S355 yapı çeliği 6 mm', 'Behind 6 mm mild steel'] });

    // 4. Behind half-brick masonry (11.5 cm).
    site.time('gel', () => createDummy(ctx, { name: 'Manken D', position: [xs[3]!, 0, LINE] }));
    const wall = site.box('Yarım tuğla duvar 11,5 cm', { material: 'brick', finish: 'brick', size: [1.4, 1.9, 0.115], at: [xs[3]!, 0.95, LINE + SHIELD], voxel: 0.025 });
    site.ground(wall);
    signs.push({ x: xs[3]!, lines: ['MANKEN D · DUVAR ARKASI', 'Yarım tuğla 11,5 cm, harçlı', 'Behind half-brick masonry'] });

    // 5. Armour-steel chest plate (the size of a body-armour plate, 25 × 30 cm, 8 mm RHA) in a light
    //    frame just in front of the chest: what it stops, the gel behind it never sees. Lambert–Jonas
    //    puts ball ammunition (M855, M80) under its limit and the tungsten-carbide AP rounds over it.
    site.time('gel', () => createDummy(ctx, { name: 'Manken E', position: [xs[4]!, 0, LINE] }));
    site.plate({
      name: 'Zırh çeliği göğüs plakası 8 mm', material: 'rha', width: 0.25, height: 0.3, thickness: 0.008, position: [xs[4]!, 1.3, LINE + 0.19],
      edges: { top: true, bottom: true, left: true, right: true }, finish: 'armor', resolution: 0.03,
    });
    frames.push(...plateCarrier(xs[4]!, 1.3, 0.25, 0.3, LINE + 0.19));
    signs.push({ x: xs[4]!, lines: ['MANKEN E · GÖĞÜS PLAKASI', 'Zırh çeliği (RHA) 8 mm, 25 × 30 cm', 'Armour-steel chest plate'] });

    // Gel blocks on a steel table.
    const tx = 12.5, top = 0.9;
    table(ctx, site, tx, top, LINE);
    const blocks: [number, boolean][] = [[-0.45, false], [0, false], [0.45, true]];
    for (const [dx, bone] of blocks) {
      site.time('gel', () => createGelBlock(ctx, { name: bone ? 'Kemikli blok' : `Jel blok ${dx < 0 ? 1 : 2}`, position: [tx + dx, top + 0.077, LINE], bone }));
    }
    signs.push({ x: tx, lines: ['FBI JEL BLOKLARI', '15 × 15 × 41 cm, %10 · 4 °C', 'Sağdaki: sentetik uyluk kemiği', 'FBI protocol gel blocks'] });

    berm(ctx, site, LINE - 6);
    const merged = frames.length ? mergeGeometries(frames, false) : null;
    for (const f of frames) f.dispose();
    if (merged) site.decor.mesh(merged, new THREE.MeshStandardMaterial({ color: 0x33373b, roughness: 0.5, metalness: 0.7 }), new THREE.Vector3()).name = 'lab-frames';
    buildLane(site);
    site.time('signs', () => site.decor.signs([
      ...signs.map((s) => ({ at: [s.x, 0, LINE + 2.4] as V3, lines: s.lines, width: 0.9, height: 0.45 })),
      {
        at: [-3, 0, FIRING - 3] as V3, width: 1.6, height: 0.55, accent: '#c2703a',
        lines: ['BALİSTİK JEL · YARA PROFİLİ', 'Boyun, sapma, parçalanma, geçici boşluk', 'Ağır çekim (F) ile geçici boşluğu izleyin', 'Ballistic gel: watch the cavity in slow motion'],
      },
    ]));
    site.time('decor', () => {
      site.decor.trees({ inner: 90, outer: 300, count: 220, seed: 11, mix: [0.45, 0.35, 0.2], groves: 12, groveRadius: 14 });
      site.decor.ridge({ radius: 1100, height: [30, 100], seed: 11 });
    });
  },
};

/** Welded test frame around a barrier panel at depth z (two posts to the ground, two rails). */
function frame(x: number, y: number, w: number, h: number, z: number): THREE.BufferGeometry[] {
  const s = 0.08, bite = 0.02, depth = 0.1;
  const out: THREE.BufferGeometry[] = [];
  const add = (sx: number, sy: number, sz: number, cx: number, cy: number, cz: number) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).translate(cx, cy, cz);
    g.deleteAttribute('uv');
    out.push(g);
  };
  const topY = y + h / 2 - bite + s;
  for (const k of [-1, 1]) {
    add(s, topY, depth, x + k * (w / 2 + s / 2 - bite), topY / 2, z);
    add(0.3, 0.02, 0.5, x + k * (w / 2 + s / 2 - bite), 0.01, z);
  }
  add(w + 2 * (s - bite), s, depth, x, y + h / 2 + s / 2 - bite, z);
  add(w + 2 * (s - bite), s, depth, x, y - h / 2 - s / 2 + bite, z);
  return out;
}

/** A light carrier frame for the chest plate: a rim and two thin rods to the ground beside the dummy. */
function plateCarrier(x: number, y: number, w: number, h: number, z: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const add = (sx: number, sy: number, sz: number, cx: number, cy: number, cz: number) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).translate(cx, cy, cz);
    g.deleteAttribute('uv');
    out.push(g);
  };
  const t = 0.015;
  add(w + 2 * t, t, 0.02, x, y + h / 2 + t / 2, z);
  add(w + 2 * t, t, 0.02, x, y - h / 2 - t / 2, z);
  for (const k of [-1, 1]) {
    add(t, h, 0.02, x + k * (w / 2 + t / 2), y, z);
    // Rods run from the rim out past the arms and down to the ground.
    add(0.34, 0.012, 0.012, x + k * (w / 2 + 0.17), y + h / 2, z);
    add(0.012, y + h / 2, 0.012, x + k * (w / 2 + 0.34), (y + h / 2) / 2, z);
    add(0.2, 0.01, 0.2, x + k * (w / 2 + 0.34), 0.005, z);
  }
  return out;
}

/** Steel test table (visual + static collider) whose top is at `top`. */
function table(ctx: SimContext, site: Site, x: number, top: number, z: number): void {
  const L = 1.6, D = 0.6, t = 0.03;
  const geos: THREE.BufferGeometry[] = [new THREE.BoxGeometry(L, t, D).translate(x, top - t / 2, z)];
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) geos.push(new THREE.BoxGeometry(0.05, top - t, 0.05).translate(x + dx * (L / 2 - 0.05), (top - t) / 2, z + dz * (D / 2 - 0.05)));
  geos.push(new THREE.BoxGeometry(L - 0.1, 0.04, 0.04).translate(x, 0.25, z));
  for (const g of geos) g.deleteAttribute('uv');
  const merged = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  site.decor.mesh(merged, new THREE.MeshStandardMaterial({ color: 0x4a4f54, roughness: 0.55, metalness: 0.6 }), new THREE.Vector3()).name = 'gel-table';
  const R = ctx.physics.R;
  ctx.physics.createFixed(new THREE.Vector3(x, top - t / 2, z), undefined, [R.ColliderDesc.cuboid(L / 2, t / 2, D / 2).setFriction(0.7)], { kind: 'table', material: MATERIALS.steel_s355 });
}

/** Earth backstop berm across the lane (catches what goes through; bullets bury in it). */
function berm(ctx: SimContext, site: Site, z: number): void {
  const L = 2 * HALF_X + 4, H = 3, top = 1.2, base = 7;
  const shape = new THREE.Shape([new THREE.Vector2(-base / 2, 0), new THREE.Vector2(base / 2, 0), new THREE.Vector2(top / 2, H), new THREE.Vector2(-top / 2, H)]);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false, steps: 1 });
  geo.deleteAttribute('uv');
  geo.rotateY(Math.PI / 2).translate(-L / 2, 0, z);
  const mesh = site.decor.mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9a8666, roughness: 1 }), new THREE.Vector3());
  mesh.name = 'berm';
  const R = ctx.physics.R;
  // Collider: the berm's core as a slab tilted to the face (a box is enough for rounds and debris).
  ctx.physics.createFixed(new THREE.Vector3(0, H / 2, z), undefined, [R.ColliderDesc.cuboid(L / 2, H / 2, (top + base) / 4)], { kind: 'berm', material: MATERIALS.soil });
}

/** Firing line, lane edges and a concrete firing pad. */
function buildLane(site: Site): void {
  const paint = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.7 });
  site.decor.mesh(new THREE.BoxGeometry(2 * HALF_X - 4, 0.004, 0.12), paint, new THREE.Vector3(0, 0.002, FIRING), 0, false).receiveShadow = true;
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xd7a531, roughness: 0.75 });
  for (const x of [-HALF_X + 1, HALF_X - 1]) site.decor.mesh(new THREE.BoxGeometry(0.1, 0.004, FIRING + 4), edgeMat, new THREE.Vector3(x, 0.002, FIRING / 2), 0, false).receiveShadow = true;
  site.decor.mesh(new THREE.BoxGeometry(2 * HALF_X - 4, 0.12, 3), new THREE.MeshStandardMaterial({ color: 0xa9a59c, roughness: 0.9 }), new THREE.Vector3(0, 0.03, FIRING + 1.4), 0, false).receiveShadow = true;
}
