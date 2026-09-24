import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BeamProfile, SceneDef, SimContext } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import type { SceneLook } from './look.ts';
import { PROFILES, REBAR, Site, type V3 } from './kit.ts';

/**
 * Test Sahası — the proving ground. Calibration targets stand in a row 25 m down a concrete
 * lane, each labelled with its material and thickness: reinforced C40 walls of 10, 20 and 40 cm,
 * S355 plates of 6, 12 and 25 mm, an HEB 300 column carrying 1.2 MN through a test rig, an IPE 400
 * beam on two concrete piers, the three kinds of architectural glass, a brick wall and a granite
 * block. This is where the models are compared against the published numbers (DESIGN.md §3).
 *
 * In the middle of the row, under its own header, the tank-gun steel stand: 50 and 100 mm armour
 * plate (RHA), an HEB 300 lying on its side with a flange to the gun, and a welded box girder
 * 500 × 400 × 40 mm, both on concrete piers. They are heavy on purpose. A 120 mm round perforates
 * a 20 mm plate at the first hit (the hardened nose of HE-OR and the jet of HEAT-MP go through
 * anything this size), so only a thick member can show the progression the steel models produce:
 * a squash-head (HESH) or HE burst on its face dishes the plate and bends the member at once, and
 * repeated hits at the same spot thin, scab and finally tear it (contact-charge breach and scab
 * limits, FM 5-250 / blast.ts contactDamage; dish by Nurick & Martin 1989).
 */

/** Target line (z) and firing line distance, m */
const LANE = 25;
/** Gap between neighbouring targets, m */
const GAP = 1.1;
/** Half width of the concrete plaza (the target row is ≈ 52 m long), m */
const HALF_X = 28;
/** Tank-gun stand: clear span of its two members on their piers, pier top, m */
const SPAN = 3.6, PIER_TOP = 1.1;

/** Golden-hour photography settings (see look.ts). */
export const rangeLook: SceneLook = { sky: { turbidity: 3.2, rayleigh: 1.8 }, exposure: 1.0, fov: 60, visibility: 7000, glassProbes: true };

export const range: SceneDef = {
  id: 'range',
  name: 'Proving Ground',
  nameTr: 'Test Sahası',
  blurb: 'Calibration targets 25 m down a concrete lane: reinforced C40 walls 10/20/40 cm, S355 plates 6/12/25 mm, a tank-gun steel stand (50 and 100 mm RHA, an HEB 300 and a 40 mm welded box girder on piers), a loaded HEB 300 column, an IPE 400 beam, tempered, laminated and annealed glass, brick and granite.',
  blurbTr: 'Beton şeritte 25 m ileride kalibrasyon hedefleri: 10/20/40 cm betonarme C40 duvarlar, 6/12/25 mm S355 levhalar, tank topu çelik standı (50 ve 100 mm RHA, ayaklar üstünde HEB 300 ve 40 mm kaynaklı kutu kiriş), 1,2 MN altında HEB 300 kolon, IPE 400 kiriş, temperli, lamine ve tavlanmış cam, tuğla ve granit.',
  spawn: { position: [-5, 2.0, 12.5], lookAt: [2.5, 1.0, 0] },
  sun: { elevation: 9, azimuth: 300 },
  build(ctx, make) {
    const site = new Site(ctx, make);
    site.look(rangeLook);
    site.time('terrain', () => createTerrain(ctx, { plaza: { halfX: HALF_X, halfZ: 5, finish: 'concrete' } }));
    buildTargets(ctx, site);
    buildLane(site);
    site.time('decor', () => {
      site.decor.trees({ inner: 140, outer: 320, count: 260, seed: 3, mix: [0.4, 0.35, 0.25], groves: 14, groveRadius: 16 });
      site.decor.ridge({ radius: 1150, height: [30, 110], seed: 3 });
    });
  },
};

interface Slot {
  x: number;
  w: number;
}

/** Lay targets out left to right; returns each one's centre x. */
function layout(widths: number[]): Slot[] {
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
  let x = -total / 2;
  return widths.map((w) => {
    const s = { x: x + w / 2, w };
    x += w + GAP;
    return s;
  });
}

function buildTargets(ctx: SimContext, site: Site): void {
  const frames: THREE.BufferGeometry[] = [];
  const signs: { x: number; lines: string[] }[] = [];
  const member = SPAN + 0.5 + 0.2;
  const slots = layout([1.0, 2.0, 2.0, 2.0, 2.0, 1.2, 1.2, 1.2, 1.0, 1.0, member, member, 1.6, 5.6, 1.2, 1.2, 1.2]);
  let i = 0;
  const next = () => slots[i++]!;

  // Granite block.
  {
    const s = next();
    const g = site.box('Granit blok 1 m', { material: 'granite', finish: 'granite', size: [1, 1, 1], at: [s.x, 0.5, 0], voxel: 0.025 });
    site.ground(g);
    signs.push({ x: s.x, lines: ['GRANİT', '1,0 m blok · f_c 180 MPa', 'Granite block'] });
  }
  // Brick wall (one-and-a-half brick, 23 cm).
  {
    const s = next();
    const b = site.box('Tuğla duvar 23 cm', { material: 'brick', finish: 'brick', size: [2, 2, 0.23], at: [s.x, 1, 0], voxel: 0.025 });
    site.ground(b);
    signs.push({ x: s.x, lines: ['TUĞLA DUVAR', '23 cm · harçlı kil tuğla', 'Clay brick masonry'] });
  }
  // Reinforced C40 walls.
  for (const [t, rebar, label] of [
    [0.1, REBAR.thin, 'Ø10/150 tek sıra'],
    [0.2, REBAR.wall, 'Ø12/200 çift yüz'],
    [0.4, REBAR.heavyWall, 'Ø16/200 çift yüz'],
  ] as const) {
    const s = next();
    const w = site.box(`C40 duvar ${Math.round(t * 100)} cm`, {
      material: 'concrete', finish: 'board-formed-concrete', size: [2, 2.4, t], at: [s.x, 1.2, 0], voxel: 0.025, rebar, tint: 0.85,
    });
    site.ground(w);
    signs.push({ x: s.x, lines: [`BETONARME C40 · ${Math.round(t * 100)} cm`, `Donatı ${label}`, 'Reinforced concrete'] });
  }
  // S355 plates in test frames.
  for (const t of [0.006, 0.012, 0.025]) {
    const s = next();
    site.plate({
      name: `S355 levha ${Math.round(t * 1000)} mm`, material: 'steel_s355', width: 1.2, height: 1.2, thickness: t, position: [s.x, 1.3, 0],
      edges: { top: true, bottom: true, left: true, right: true }, finish: 'mill-scale',
    });
    frames.push(...frame(s.x, 1.3, 1.2, 1.2, 0.7));
    signs.push({ x: s.x, lines: [`S355 · ${Math.round(t * 1000)} mm`, 'Yapı çeliği, f_y 355 MPa', 'Structural steel'] });
  }
  // Tank-gun steel stand: armour plates, then two heavy members on piers.
  const standFrom = slots[i]!;
  for (const t of [0.05, 0.1]) {
    const s = next();
    site.plate({
      name: `RHA ${Math.round(t * 1000)} mm`, material: 'rha', width: 1, height: 1, thickness: t, position: [s.x, 1.2, 0],
      edges: { top: true, bottom: true, left: true, right: true }, finish: 'armor',
    });
    frames.push(...frame(s.x, 1.2, 1, 1, 0.7, Math.max(0.12, t + 0.04)));
    signs.push({ x: s.x, lines: [`RHA · ${Math.round(t * 1000)} mm`, 'Homojen zırh, ~280 BHN', 'Rolled homogeneous armour'] });
  }
  {
    // HEB 300 on its side: the 19 mm flange faces the gun and the member bends about its strong
    // axis. A HESH burst (4.8 kg TNT-eq.) on the flange is below its breach limit (≈ 17 mm for
    // S355), so the first hit dishes and scabs it and bows the span; the next ones tear it.
    const s = next();
    heavyMember(site, s.x, 'HEB 300 kiriş (yan)', PROFILES.HEB300, [0, 0, 1], 0x6b2d24);
    signs.push({ x: s.x, lines: ['HEB 300 · L = 3,6 m', 'Başlık tabana dönük, 19 mm', 'Beam on its side: dents, bends'] });
  }
  {
    // Welded box girder, 40 mm walls: dishes 5 cm at the first HESH hit and tears at the next.
    const s = next();
    heavyMember(site, s.x, 'Kutu kiriş 500×400×40', { type: 'box', h: 0.5, b: 0.4, t: 0.04 }, [0, 1, 0], 0x3f4c55);
    signs.push({ x: s.x, lines: ['KUTU KİRİŞ · 40 mm', 'Kaynaklı S355, 500×400 mm', 'Welded box girder'] });
  }
  const standTo = slots[i - 1]!;
  const standX = (standFrom.x - standFrom.w / 2 + standTo.x + standTo.w / 2) / 2;
  // HEB 300 column under 1.2 MN (the rest of the load comes from the rig's jacks).
  {
    const s = next();
    const col = site.beam({
      name: 'HEB 300 kolon', material: 'steel_s355', profile: PROFILES.HEB300, start: [s.x, 0, 0], end: [s.x, 4, 0], up: [0, 0, 1],
      ends: { start: 'fixed', end: 'fixed' }, finish: 'painted', paintColor: 0x5e2a22,
    });
    site.ground(col);
    const block = site.box('Yük bloğu', { material: 'concrete', finish: 'smooth-concrete', size: [1.6, 0.8, 1.6], at: [s.x, 4.4, 0], voxel: 0.05 });
    site.on(col, block);
    const blockWeight = 1.6 * 0.8 * 1.6 * 2400 * 9.80665;
    site.load(block, 1.2e6 - blockWeight);
    testRig(site, s.x, 4.8, block);
    signs.push({ x: s.x, lines: ['HEB 300 · N = 1,2 MN', 'S355 kolon, L = 4 m, deney yükü', 'Loaded column'] });
  }
  // IPE 400 beam on two reinforced piers, 5 m span.
  {
    const s = next();
    const span = 5, top = 1.2;
    const piers = [-1, 1].map((k) => {
      const p = site.box(`Kiriş ayağı ${k < 0 ? 'A' : 'B'}`, {
        material: 'concrete', finish: 'smooth-concrete', size: [0.5, top, 0.8], at: [s.x + (k * span) / 2, top / 2, 0], voxel: 0.025, rebar: REBAR.wall,
      });
      site.ground(p);
      return p;
    });
    const h = PROFILES.IPE400.h;
    const beam = site.beam({
      name: 'IPE 400 kiriş', material: 'steel_s355', profile: PROFILES.IPE400,
      start: [s.x - span / 2 - 0.2, top + h / 2, 0], end: [s.x + span / 2 + 0.2, top + h / 2, 0],
      ends: { start: 'free', end: 'free' }, finish: 'painted', paintColor: 0x3d4a52,
    });
    for (const p of piers) site.on(p, beam);
    signs.push({ x: s.x, lines: ['IPE 400 · L = 5 m', 'Basit mesnetli S355 kiriş', 'Simply supported beam'] });
  }
  // Architectural glass in steel frames.
  for (const [type, t, label, en] of [
    ['tempered', 0.01, 'TEMPERLİ CAM · 10 mm', 'Tempered: dices on fracture'],
    ['laminated', 0.0128, 'LAMİNE CAM · 6+6 PVB', 'Laminated: cracks, sags, holds'],
    ['annealed', 0.006, 'TAVLANMIŞ CAM · 6 mm', 'Annealed: large sharp shards'],
  ] as const) {
    const s = next();
    site.glass({ name: label, type, width: 1.2, height: 1.8, thickness: t, position: [s.x, 1.25, 0], framed: true });
    frames.push(...frame(s.x, 1.25, 1.2, 1.8, 0.35));
    signs.push({ x: s.x, lines: [label, en] });
  }

  // One draw call for every test frame on the range.
  const merged = mergeGeometries(frames, false);
  for (const f of frames) f.dispose();
  if (merged) {
    const m = site.decor.mesh(merged, new THREE.MeshStandardMaterial({ color: 0x33373b, roughness: 0.5, metalness: 0.7 }), new THREE.Vector3());
    m.name = 'test-frames';
  }
  site.time('signs', () => site.decor.signs([
    ...signs.map((s) => ({ at: [s.x, 0, 2.2] as V3, lines: s.lines, width: 0.9, height: 0.45 })),
    // The stand's header, a step closer to the gun.
    {
      at: [standX, 0, 3.4] as V3, width: 1.8, height: 0.45, accent: '#b8412c',
      lines: ['120 mm TANK TOPU · ÇELİK', 'HESH / HE-OR: önce ezik ve eğilme, tekrarında yırtılma', 'Tank gun vs heavy steel: dent and bend, then tear'],
    },
  ]));
}

/**
 * A heavy member of the tank-gun stand: simply supported on two reinforced piers (bearing, not
 * clamped), axis along the row, `up` the profile's web direction.
 */
function heavyMember(site: Site, x: number, name: string, profile: Extract<BeamProfile, { type: 'I' | 'box' }>, up: V3, paintColor: number): void {
  const piers = [-1, 1].map((k) => {
    const p = site.box(`${name} ayağı ${k < 0 ? 'A' : 'B'}`, {
      material: 'concrete', finish: 'smooth-concrete', size: [0.5, PIER_TOP, 0.8], at: [x + (k * SPAN) / 2, PIER_TOP / 2, 0], voxel: 0.025, rebar: REBAR.wall,
    });
    site.ground(p);
    return p;
  });
  // Height of the section's axis over its bearing: half its extent along world y (h along `up`).
  const half = (up[1] !== 0 ? profile.h : profile.b) / 2;
  const beam = site.beam({
    name, material: 'steel_s355', profile, start: [x - SPAN / 2 - 0.2, PIER_TOP + half, 0], end: [x + SPAN / 2 + 0.2, PIER_TOP + half, 0], up,
    ends: { start: 'free', end: 'free' }, finish: 'painted', paintColor,
  });
  for (const p of piers) site.on(p, beam);
}

/**
 * The column's self-reacting load rig: a steel crosshead on the load block, pulled down by two
 * anchored high-strength bars, so the column carries the full 1.2 MN. Each Ø 75 mm bar takes
 * 0.6 MN, σ = N/A = 0.6 MN / 4 418 mm² = 136 MPa, far under the 835 MPa yield of prestressing
 * bar (EN 10138-4 Y1030H). The crosshead rides on the block and falls with it; the bars stay in
 * their anchors.
 */
function testRig(site: Site, x: number, top: number, block: Destructible): void {
  const steel = new THREE.MeshStandardMaterial({ color: 0x2f3336, roughness: 0.5, metalness: 0.65 });
  const r = 0.0375, dx = 1.0, head = top + 0.36;
  const fixed: THREE.BufferGeometry[] = [];
  for (const k of [-1, 1]) {
    fixed.push(new THREE.CylinderGeometry(r, r, head + 0.16, 14).translate(x + k * dx, (head + 0.16) / 2, 0));
    fixed.push(new THREE.BoxGeometry(0.5, 0.06, 0.5).translate(x + k * dx, 0.03, 0));
    fixed.push(new THREE.CylinderGeometry(0.075, 0.075, 0.1, 6).translate(x + k * dx, 0.11, 0));
  }
  const bars = mergeGeometries(fixed.map((g) => g.deleteAttribute('uv')), false)!;
  for (const g of fixed) g.dispose();
  site.decor.mesh(bars, steel, new THREE.Vector3()).name = 'test-rig-bars';
  const moving: THREE.BufferGeometry[] = [new THREE.BoxGeometry(2 * dx + 0.3, 0.36, 0.5).translate(x, top + 0.18, 0)];
  for (const k of [-1, 1]) moving.push(new THREE.CylinderGeometry(0.075, 0.075, 0.1, 6).translate(x + k * dx, head + 0.05, 0));
  const crosshead = mergeGeometries(moving.map((g) => g.deleteAttribute('uv')), false)!;
  for (const g of moving) g.dispose();
  site.attach(block, crosshead, steel.clone(), 'test-rig-crosshead');
}

/**
 * Welded test frame around a panel: two posts to the ground and two rails, 100 mm box sections,
 * the panel held in a 20 mm bite. `depth` is the frame's thickness front to back.
 */
function frame(x: number, y: number, w: number, h: number, _clear: number, depth = 0.12): THREE.BufferGeometry[] {
  const s = 0.1, bite = 0.02;
  const out: THREE.BufferGeometry[] = [];
  const add = (sx: number, sy: number, cx: number, cy: number) => {
    const g = new THREE.BoxGeometry(sx, sy, depth);
    g.translate(cx, cy, 0);
    out.push(g);
  };
  const top = y + h / 2 - bite + s;
  // Posts from the ground to above the top rail.
  for (const k of [-1, 1]) add(s, top, x + k * (w / 2 + s / 2 - bite), top / 2);
  add(w + 2 * (s - bite), s, x, y + h / 2 + s / 2 - bite);
  add(w + 2 * (s - bite), s, x, y - h / 2 - s / 2 + bite);
  // Foot plates.
  for (const k of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.3, 0.02, 0.5);
    g.translate(x + k * (w / 2 + s / 2 - bite), 0.01, 0);
    out.push(g);
  }
  return out;
}

/** The firing line, lane edges and distance boards. */
function buildLane(site: Site): void {
  const paint = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.7 });
  const lineGeo = new THREE.BoxGeometry(2 * HALF_X - 6, 0.004, 0.12);
  const line = site.decor.mesh(lineGeo, paint, new THREE.Vector3(0, 0.002, LANE), 0, false);
  line.receiveShadow = true;
  const edgeGeo = new THREE.BoxGeometry(0.1, 0.004, LANE + 6);
  const edge = HALF_X - 1.5;
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xd7a531, roughness: 0.75 });
  for (const x of [-edge, edge]) site.decor.mesh(edgeGeo.clone(), edgeMat.clone(), new THREE.Vector3(x, 0.002, LANE / 2 - 1), 0, false).receiveShadow = true;
  edgeGeo.dispose();
  edgeMat.dispose();
  const boards: [number, string][] = [[LANE, '25 m'], [LANE + 25, '50 m'], [LANE + 75, '100 m']];
  site.time('signs', () => site.decor.signs(boards.map(([z, label]) => ({
    at: [-HALF_X + 0.5, 0, z] as V3, rotY: Math.PI / 2, lines: [label, 'Hedef hattına mesafe', 'Distance to targets'], width: 0.9, height: 0.45, accent: '#d7a531',
  }))));
  // Concrete firing pad.
  const pad = new THREE.BoxGeometry(2 * HALF_X - 4, 0.12, 4);
  site.decor.mesh(pad, new THREE.MeshStandardMaterial({ color: 0xa9a59c, roughness: 0.9 }), new THREE.Vector3(0, 0.03, LANE + 1.6), 0, false).receiveShadow = true;
}
