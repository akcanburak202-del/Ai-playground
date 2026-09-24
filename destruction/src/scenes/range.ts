import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneDef, SimContext } from '../app/contracts.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import { PROFILES, REBAR, Site, type V3 } from './kit.ts';

/**
 * Test Sahası — the proving ground. Calibration targets stand in a row 25 m down a concrete
 * lane, each labelled with its material and thickness: reinforced C40 walls of 10, 20 and 40 cm,
 * S355 plates of 6, 12 and 25 mm, 50 and 100 mm armour (RHA), an HEB 300 column carrying 1.2 MN
 * through a test rig, an IPE 400 beam on two concrete piers, the three kinds of architectural
 * glass, a brick wall and a granite block. This is where the models are compared against the
 * published numbers (DESIGN.md §3).
 */

/** Target line (z) and firing line distance, m */
const LANE = 25;
/** Gap between neighbouring targets, m */
const GAP = 1.1;

export const range: SceneDef = {
  id: 'range',
  name: 'Proving Ground',
  nameTr: 'Test Sahası',
  blurb: 'Calibration targets 25 m down a concrete lane: reinforced C40 walls 10/20/40 cm, S355 plates 6/12/25 mm, 50 and 100 mm RHA, a loaded HEB 300 column, an IPE 400 beam, tempered, laminated and annealed glass, brick and granite.',
  blurbTr: 'Beton şeritte 25 m ileride kalibrasyon hedefleri: 10/20/40 cm betonarme C40 duvarlar, 6/12/25 mm S355 levhalar, 50 ve 100 mm RHA zırh, 1,2 MN altında HEB 300 kolon, beton ayaklar üstünde IPE 400 kiriş, temperli, lamine ve tavlanmış cam, tuğla ve granit.',
  spawn: { position: [-12, 1.7, 9.5], lookAt: [2, 1.3, -1] },
  sun: { elevation: 9, azimuth: 300 },
  build(ctx, make) {
    const site = new Site(ctx, make);
    site.time('terrain', () => createTerrain(ctx, { plaza: { halfX: 25, halfZ: 5, finish: 'concrete' } }));
    buildTargets(ctx, site);
    buildLane(site);
    site.time('decor', () => site.decor.trees({ inner: 140, outer: 320, count: 420, seed: 3, mix: [0.4, 0.3, 0.3] }));
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
  const slots = layout([1.0, 2.0, 2.0, 2.0, 2.0, 1.2, 1.2, 1.2, 1.0, 1.0, 1.6, 5.6, 1.2, 1.2, 1.2]);
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
  // Armour.
  for (const t of [0.05, 0.1]) {
    const s = next();
    site.plate({
      name: `RHA ${Math.round(t * 1000)} mm`, material: 'rha', width: 1, height: 1, thickness: t, position: [s.x, 1.2, 0],
      edges: { top: true, bottom: true, left: true, right: true }, finish: 'armor',
    });
    frames.push(...frame(s.x, 1.2, 1, 1, 0.7, Math.max(0.12, t + 0.04)));
    signs.push({ x: s.x, lines: [`RHA · ${Math.round(t * 1000)} mm`, 'Homojen zırh, ~280 BHN', 'Rolled homogeneous armour'] });
  }
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
  site.decor.signs(signs.map((s) => ({ at: [s.x, 0, 2.2] as V3, lines: s.lines, width: 0.9, height: 0.45 })));
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
  const lineGeo = new THREE.BoxGeometry(44, 0.004, 0.12);
  const line = site.decor.mesh(lineGeo, paint, new THREE.Vector3(0, 0.002, LANE), 0, false);
  line.receiveShadow = true;
  const edgeGeo = new THREE.BoxGeometry(0.1, 0.004, LANE + 6);
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xd7a531, roughness: 0.75 });
  for (const x of [-23.5, 23.5]) site.decor.mesh(edgeGeo.clone(), edgeMat.clone(), new THREE.Vector3(x, 0.002, LANE / 2 - 1), 0, false).receiveShadow = true;
  edgeGeo.dispose();
  edgeMat.dispose();
  const boards: [number, string][] = [[LANE, '25 m'], [LANE + 25, '50 m'], [LANE + 75, '100 m']];
  site.decor.signs(boards.map(([z, label]) => ({
    at: [-24.5, 0, z] as V3, rotY: Math.PI / 2, lines: [label, 'Hedef hattına mesafe', 'Distance to targets'], width: 0.9, height: 0.45, accent: '#d7a531',
  })));
  // Concrete firing pad.
  const pad = new THREE.BoxGeometry(46, 0.12, 4);
  site.decor.mesh(pad, new THREE.MeshStandardMaterial({ color: 0xa9a59c, roughness: 0.9 }), new THREE.Vector3(0, 0.03, LANE + 1.6), 0, false).receiveShadow = true;
}
