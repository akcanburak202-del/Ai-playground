import * as THREE from 'three';
import type { SceneDef } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import { PROFILES, REBAR, Site, region } from './kit.ts';

/**
 * Çelik Kule — a six-storey steel moment frame: HEB 200 columns on a 6 m grid (two bays by one),
 * IPE 360 edge beams continuous over the columns, IPE 300 cross beams, CHS X-bracing in the east
 * end frame, 200 mm RC floor slabs, and a frameless tempered-glass curtain wall on the south and east
 * faces from the first floor up (the ground storey is open: pilotis).
 *
 * Loads are realistic for an office floor: slab self-weight 4.7 kPa plus 1.5 kPa of finishes,
 * services and the quasi-permanent share of the imposed load, so a middle ground-floor column
 * carries ≈ 0.8 MN, about 45 % of its buckling resistance (EN 1993-1-1 curve c). Blow the
 * ground-floor columns and the storeys above lose their supports one level after another.
 */

/** Column grid (m), storey height, storeys */
const XS = [-6, 0, 6], ZS = [-3, 3], STOREY = 3.6, N = 6;
/** Slab: thickness and edge overhang past the column lines, m */
const SLAB_T = 0.2, EDGE = 0.3;
/** Superimposed dead + quasi-permanent imposed load on the floors, Pa (EN 1991-1-1, ψ₂ = 0.3) */
const SUPERIMPOSED = 1500;

export const tower: SceneDef = {
  id: 'tower',
  name: 'Steel Tower',
  nameTr: 'Çelik Kule',
  blurb: 'A six-storey steel moment frame: HEB 200 columns, IPE beams, X-bracing in one bay, RC floor slabs, a frameless tempered-glass curtain wall on two faces over an open ground storey. Demolition-ready.',
  blurbTr: 'Altı katlı çelik moment çerçeve: HEB 200 kolonlar, IPE kirişler, tek açıklıkta X çaprazlar, betonarme döşemeler; açık zemin katın üstünde iki cephede çerçevesiz temperli cam giydirme. Yıkıma hazır.',
  spawn: { position: [17, 1.7, -19], lookAt: [0, 8, 0] },
  sun: { elevation: 12, azimuth: 222 },
  build(ctx, make) {
    const site = new Site(ctx, make);
    site.time('terrain', () => createTerrain(ctx, { plaza: { halfX: 24, halfZ: 20, finish: 'concrete' } }));
    const level = (k: number) => k * STOREY;
    const slabs = new Map<number, Destructible>();

    // Columns: one member per storey. Ground storey: fixed base, loaded head (roller). Above:
    // anchored on the column below.
    const cols: Destructible[][] = XS.map(() => []);
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
          cols[i]!.push(c);
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

    // Tempered glass curtain wall (structural silicone, no visible frame), south and east faces.
    const south = { along: 'x' as const, at: ZS[0]! - EDGE - 0.1 - 0.12, from: XS[0]! - EDGE, to: XS[2]! + EDGE, panes: 6 };
    const east = { along: 'z' as const, at: XS[2]! + EDGE + 0.12, from: ZS[0]! - EDGE - 0.1, to: ZS[1]! + EDGE + 0.1, panes: 3 };
    for (const face of [south, east]) {
      const w = (face.to - face.from) / face.panes;
      for (let k = 1; k < N; k++) {
        const y0 = level(k), y1 = level(k + 1);
        for (let i = 0; i < face.panes; i++) {
          const s = face.from + (i + 0.5) * w;
          const [x, z] = face.along === 'x' ? [s, face.at] : [face.at, s];
          const pane = site.glass({
            name: `Cam ${face.along}${k}-${i}`, type: 'tempered', width: w - 0.02, height: STOREY - 0.02, thickness: 0.012,
            position: [x, (y0 + y1) / 2, z], rotation: [0, face.along === 'x' ? 0 : Math.PI / 2, 0], tint: 0x9db3b0, framed: true,
          });
          // Unitised structural-silicone glazing: each unit hangs from the slab edge above and is
          // restrained at the slab edge below.
          const edge = (y: number, depth: number) => face.along === 'x'
            ? new THREE.Box3(new THREE.Vector3(s - w / 2 + 0.05, y - depth, face.at + 0.12), new THREE.Vector3(s + w / 2 - 0.05, y, face.at + 0.3))
            : new THREE.Box3(new THREE.Vector3(face.at - 0.3, y - depth, s - w / 2 + 0.05), new THREE.Vector3(face.at - 0.12, y, s + w / 2 - 0.05));
          site.at(slabs.get(k)!, pane, edge(y0, SLAB_T));
          site.at(slabs.get(k + 1)!, pane, edge(y1, SLAB_T));
        }
      }
    }

    site.time('decor', () => site.decor.trees({ inner: 70, outer: 260, count: 380, seed: 17, mix: [0.3, 0.3, 0.4] }));
  },
};
