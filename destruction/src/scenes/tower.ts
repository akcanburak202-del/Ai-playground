import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneDef } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import type { SceneLook } from './look.ts';
import { COLLAPSE_BUDGET, PROFILES, REBAR, Site, region } from './kit.ts';

/**
 * Çelik Kule — a six-storey steel moment frame: HEB 200 columns on a 6 m grid (two bays by one),
 * IPE 360 edge beams continuous over the columns, IPE 300 cross beams, CHS
 * X-bracing in the east end frame, 200 mm RC floor slabs, and a stick-system curtain wall of
 * tempered glass on all four faces from the first floor up: dark anodised mullions on every
 * joint, a transom at each floor line and a back-painted spandrel hiding the slab edge.
 *
 * Loads are realistic for an office floor: slab self-weight 4.7 kPa plus 1.5 kPa of finishes,
 * services and the quasi-permanent share of the imposed load, so a middle ground-floor column
 * carries ≈ 0.8 MN, well within its buckling resistance (EN 1993-1-1 curve c). Blow the
 * ground-floor columns and the storeys above lose their supports one level after another. Cutting
 * a steel section with contact charges takes P = 3/8·A lb of TNT for A in in² (US Army FM 5-250,
 * steel-cutting formula): A = 78 cm² = 12.1 in² for an HEB 200 → 4.5 lb ≈ 2.1 kg TNT, three M112
 * blocks per column. (Checked in the browser: 2.3 kg per ground column brings the tower down; the
 * same charges leave an HEB 300 standing, as the formula predicts — it needs ≈ 3.9 kg.)
 */

/** Column grid (m), storey height, storeys */
const XS = [-6, 0, 6], ZS = [-3, 3], STOREY = 3.6, N = 6;
/** Slab: thickness and edge overhang past the column lines, m */
const SLAB_T = 0.2, EDGE = 0.3;
/** Superimposed dead + quasi-permanent imposed load on the floors, Pa (EN 1991-1-1, ψ₂ = 0.3) */
const SUPERIMPOSED = 1500;
/** Glass plane outside the slab edge, m */
const GLASS_OUT = 0.12;
/** Curtain-wall frame: mullion face width and depth, transom height, m */
const MULL_W = 0.06, MULL_D = 0.16, TRANSOM_H = 0.09;

/**
 * Golden-hour photography settings (see look.ts). The panes share reflection probes (one per
 * ≈ 7 m, recaptured a face per frame once a collapse has settled; glass/probes.ts).
 */
export const towerLook: SceneLook = { sky: { turbidity: 3, rayleigh: 1.7, mieCoefficient: 0.003 }, exposure: 0.9, fov: 55, visibility: 7000, glassProbes: true };

export const tower: SceneDef = {
  id: 'tower',
  name: 'Steel Tower',
  nameTr: 'Çelik Kule',
  blurb: 'A six-storey steel moment frame: HEB columns, IPE beams, X-bracing in one bay, RC floor slabs, a tempered-glass curtain wall with slim mullions on all four faces over an open ground storey. Demolition-ready.',
  blurbTr: 'Altı katlı çelik moment çerçeve: HEB kolonlar, IPE kirişler, tek açıklıkta X çaprazlar, betonarme döşemeler; açık zemin katın üstünde dört cephede ince kayıtlı temperli cam giydirme. Yıkıma hazır.',
  spawn: { position: [19, 1.6, -21], lookAt: [0, 8.5, 0] },
  sun: { elevation: 10, azimuth: 250 },
  build(ctx, make) {
    const site = new Site(ctx, make);
    site.look(towerLook);
    site.budget(COLLAPSE_BUDGET);
    site.time('terrain', () => createTerrain(ctx, { plaza: { halfX: 24, halfZ: 20, finish: 'concrete' } }));
    const level = (k: number) => k * STOREY;
    const slabs = new Map<number, Destructible>();

    // Columns: one member per storey. Ground storey: fixed base, loaded head (roller). Above:
    // anchored on the column below.
    const colAt = new Map<string, Destructible>();
    for (let k = 0; k < N; k++)
      XS.forEach((x, i) =>
        ZS.forEach((z) => {
          const c = site.beam({
            name: `Kolon ${k}-${i}${z < 0 ? 'G' : 'K'}`, material: 'steel_s355', profile: PROFILES.HEB200,
            start: [x, level(k), z], end: [x, level(k + 1), z], up: [0, 0, 1],
            ends: k === 0 ? { start: 'fixed', end: 'fixed' } : { start: 'free', end: 'free' }, finish: 'painted', paintColor: 0x2e3338,
          });
          if (k === 0) site.ground(c);
          else site.at(colAt.get(`${k - 1}/${x}/${z}`)!, c, region(x, z, 0.15, level(k) - 0.3, level(k) + 0.1));
          colAt.set(`${k}/${x}/${z}`, c);
        }),
      );

    for (let k = 1; k <= N; k++) {
      const F = level(k);
      const below = (x: number, z: number) => colAt.get(`${k - 1}/${x}/${z}`)!;
      const joint = (x: number, z: number) => region(x, z, 0.22, F - 0.75, F + 0.02);
      // Edge beams (x), continuous over three columns; cross beams (z) at every column line.
      const hx = PROFILES.IPE360.h, hz = PROFILES.IPE300.h;
      const beams: Destructible[] = [];
      for (const z of ZS) {
        const b = site.beam({
          name: `Kiriş ${k}-${z < 0 ? 'G' : 'K'}`, material: 'steel_s355', profile: PROFILES.IPE360,
          start: [XS[0]! - 0.12, F - SLAB_T - hx / 2, z], end: [XS[2]! + 0.12, F - SLAB_T - hx / 2, z],
          ends: { start: 'free', end: 'free' }, finish: 'painted', paintColor: 0x2e3338,
        });
        for (const x of XS) site.at(below(x, z), b, joint(x, z));
        beams.push(b);
      }
      for (const x of XS) {
        const b = site.beam({
          name: `Tali kiriş ${k}-${x}`, material: 'steel_s355', profile: PROFILES.IPE300,
          start: [x, F - SLAB_T - hz / 2, ZS[0]! + 0.1], end: [x, F - SLAB_T - hz / 2, ZS[1]! - 0.1],
          up: [0, 1, 0], ends: { start: 'free', end: 'free' }, finish: 'painted', paintColor: 0x2e3338,
        });
        for (const z of ZS) site.at(below(x, z), b, joint(x, z));
        beams.push(b);
      }
      // Floor slab on the beams.
      const sx0 = XS[0]! - EDGE, sx1 = XS[2]! + EDGE, sz0 = ZS[0]! - EDGE - 0.1, sz1 = ZS[1]! + EDGE + 0.1;
      const slab = site.box(k === N ? 'Çatı döşemesi' : `Döşeme ${k}`, {
        material: 'concrete', finish: 'smooth-concrete', size: [sx1 - sx0, SLAB_T, sz1 - sz0], at: [(sx0 + sx1) / 2, F - SLAB_T / 2, (sz0 + sz1) / 2],
        voxel: 0.05, rebar: REBAR.slab, tint: 0.95,
      });
      for (const b of beams) site.on(b, slab);
      site.load(slab, SUPERIMPOSED * (sx1 - sx0) * (sz1 - sz0));
      slabs.set(k, slab);
    }

    // X-bracing in the east end frame, one pair per storey.
    for (let k = 0; k < N; k++) {
      const x = XS[2]!;
      for (const [za, zb] of [[ZS[0]!, ZS[1]!], [ZS[1]!, ZS[0]!]] as const) {
        const b = site.beam({
          name: `Çapraz ${k}${za < 0 ? 'a' : 'b'}`, material: 'steel_s355', profile: PROFILES.CHS139,
          start: [x, level(k) + 0.25, za * 0.93], end: [x, level(k + 1) - 0.6, zb * 0.93], ends: { start: 'free', end: 'free' }, finish: 'painted', paintColor: 0x8c3b24,
        });
        const lo = region(x, za * 0.93, 0.35, level(k) - 0.1, level(k) + 0.6);
        const hi = region(x, zb * 0.93, 0.35, level(k + 1) - 0.95, level(k + 1) - 0.2);
        site.at(k === 0 ? 'ground' : colAt.get(`${k - 1}/${x}/${za}`)!, b, lo);
        site.at(colAt.get(`${k}/${x}/${zb}`)!, b, hi);
      }
    }

    curtainWall(site, slabs, level);

    site.time('decor', () => {
      site.decor.trees({ inner: 90, outer: 300, count: 260, seed: 17, mix: [0.45, 0.35, 0.2], groves: 14, groveRadius: 16 });
      site.decor.ridge({ radius: 1150, height: [25, 95], seed: 17 });
    });
  },
};

/**
 * Stick-system curtain wall on all four faces, storeys 1–5 (a glass prism over the open ground
 * storey, as in Mies's Lake Shore Drive towers): framed tempered units hung from the slab edge
 * above and restrained at the slab edge below, dark anodised mullions on every joint, a transom
 * at each floor line and a spandrel of back-painted glass hiding the slab edge and the beams. The
 * frame and spandrel of a storey are carried by the slab above it and go with it.
 */
function curtainWall(site: Site, slabs: Map<number, Destructible>, level: (k: number) => number): void {
  // The glass box: each face runs corner to corner in the planes GLASS_OUT outside the slab edges
  // (faces tagged Güney, Doğu, Kuzey, Batı).
  const xW = XS[0]! - EDGE - GLASS_OUT, xE = XS[2]! + EDGE + GLASS_OUT;
  const zS = ZS[0]! - EDGE - 0.1 - GLASS_OUT, zN = ZS[1]! + EDGE + 0.1 + GLASS_OUT;
  const faces = [
    { tag: 'G', along: 'x' as const, at: zS, out: -1, from: xW, to: xE, panes: 6 },
    { tag: 'D', along: 'z' as const, at: xE, out: 1, from: zS, to: zN, panes: 3 },
    { tag: 'K', along: 'x' as const, at: zN, out: 1, from: xW, to: xE, panes: 6 },
    { tag: 'B', along: 'z' as const, at: xW, out: -1, from: zS, to: zN, panes: 3 },
  ];
  // Slab extent along each axis (the edge supports are clipped to it).
  const slabX = [XS[0]! - EDGE, XS[2]! + EDGE] as const, slabZ = [ZS[0]! - EDGE - 0.1, ZS[1]! + EDGE + 0.1] as const;
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: 0.38, metalness: 0.75 });
  const spandrelMat = new THREE.MeshStandardMaterial({ color: 0x15191a, roughness: 0.12, metalness: 0.1 });
  for (let k = 1; k < N; k++) {
    const y0 = level(k), y1 = level(k + 1);
    const frame: THREE.BufferGeometry[] = [];
    const spandrel: THREE.BufferGeometry[] = [];
    for (const face of faces) {
      const w = (face.to - face.from) / face.panes;
      // Box in face coordinates: s along the face, y up, d outwards from the glass plane.
      const put = (list: THREE.BufferGeometry[], s: number, y: number, d: number, ls: number, ly: number, ld: number) => {
        const g = face.along === 'x' ? new THREE.BoxGeometry(ls, ly, ld) : new THREE.BoxGeometry(ld, ly, ls);
        const o = face.at + face.out * d;
        g.translate(face.along === 'x' ? s : o, y, face.along === 'x' ? o : s);
        list.push(g);
      };
      for (let i = 0; i < face.panes; i++) {
        const s = face.from + (i + 0.5) * w;
        const [x, z] = face.along === 'x' ? [s, face.at] : [face.at, s];
        const pane = site.glass({
          name: `Cam ${face.tag}${k}-${i + 1}`, type: 'tempered', width: w - MULL_W, height: STOREY - TRANSOM_H, thickness: 0.012,
          position: [x, (y0 + y1) / 2 + TRANSOM_H / 2, z], rotation: [0, face.along === 'x' ? 0 : Math.PI / 2, 0], tint: 0x9fb4b0, framed: true,
        });
        // Each unit hangs from the slab edge above and is restrained at the slab edge below: a
        // band 0.18 m into the slab behind the unit (clipped to the slab at the corners).
        const lim = face.along === 'x' ? slabX : slabZ;
        const s0 = Math.max(lim[0], s - w / 2 + 0.05), s1 = Math.min(lim[1], s + w / 2 - 0.05);
        const e0 = face.at - face.out * GLASS_OUT, e1 = e0 - face.out * 0.18;
        const edge = (y: number) => face.along === 'x'
          ? new THREE.Box3(new THREE.Vector3(s0, y - SLAB_T, Math.min(e0, e1)), new THREE.Vector3(s1, y, Math.max(e0, e1)))
          : new THREE.Box3(new THREE.Vector3(Math.min(e0, e1), y - SLAB_T, s0), new THREE.Vector3(Math.max(e0, e1), y, s1));
        site.at(slabs.get(k)!, pane, edge(y0));
        site.at(slabs.get(k + 1)!, pane, edge(y1));
      }
      // Mullions on every joint (and both ends), a transom on the floor line, the spandrel behind.
      for (let i = 0; i <= face.panes; i++) put(frame, face.from + i * w, (y0 + y1) / 2, 0.02, MULL_W, STOREY, MULL_D);
      put(frame, (face.from + face.to) / 2, y0 + TRANSOM_H / 2, 0.02, face.to - face.from, TRANSOM_H, MULL_D * 0.8);
      if (k === N - 1) put(frame, (face.from + face.to) / 2, y1 + 0.07, 0.02, face.to - face.from + MULL_W, 0.14, MULL_D);
      put(spandrel, (face.from + face.to) / 2, y1 - 0.34, -0.035, face.to - face.from - 0.02, 0.84, 0.02);
    }
    const slab = slabs.get(k + 1)!;
    const fg = mergeGeometries(frame, false)!, sg = mergeGeometries(spandrel, false)!;
    for (const g of [...frame, ...spandrel]) g.dispose();
    site.attach(slab, fg, frameMat, 'curtain-frame');
    site.attach(slab, sg, spandrelMat, 'spandrel');
  }
}
