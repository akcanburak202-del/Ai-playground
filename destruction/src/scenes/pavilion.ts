import * as THREE from 'three';
import type { BeamProfile, SceneDef } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import type { SceneLook } from './look.ts';
import { COLLAPSE_BUDGET, REBAR, Site } from './kit.ts';

/**
 * Barselona Pavyonu — after Ludwig Mies van der Rohe's German Pavilion (Barcelona, 1929). A
 * travertine podium with a large shallow pool; a thin flat roof slab floating on eight chrome
 * cruciform columns with generous overhangs; freestanding walls that slide past each other and
 * never carry the roof: the onyx doré wall, green Tinos marble, travertine; grey-green tinted
 * glass between chrome mullions.
 *
 * Structure: the roof rests only on the columns (as in the original), so a lost column leaves
 * the slab to span twice as far or cantilever past its reach: it breaks off progressively. The
 * glass is held at its head by the roof and shatters when the roof above it goes.
 */

/** Podium: top level and plan extents, m */
const TOP = 0.6;
const PX0 = -17, PX1 = 15, PZ0 = -8.5, PZ1 = 8.5;
/** Big pool in the open court */
const POOL = { x0: -15.5, x1: -7.5, z0: -3.5, z1: 6.5 };
/** Column grid (two rows of four) and storey height */
const COL_X = [-4.4, 1.2, 6.8, 12.4], COL_Z = [-2.9, 2.9], STOREY = 3.1;
/** Roof slab */
const ROOF = { x0: -6.5, x1: 14.5, z0: -5.6, z1: 5.6, t: 0.3 };
/** Chrome cruciform: four 20 mm plates, 180 mm across */
const CRUCIFORM: BeamProfile = { type: 'cruciform', arm: 0.09, t: 0.02 };
const MULLION: BeamProfile = { type: 'box', h: 0.1, b: 0.05, t: 0.004 };
const TINOS = 0x6f9a80;

/**
 * Golden-hour photography settings (see look.ts): the pipeline's own sky balance, and local
 * reflection probes for the glass (budgeted by the glass module to one cube face per frame).
 */
export const pavilionLook: SceneLook = { sky: { turbidity: 3.2, rayleigh: 1.8 }, exposure: 1.0, fov: 55, visibility: 7000, glassProbes: true };

export const pavilion: SceneDef = {
  id: 'pavilion',
  name: 'Barcelona Pavilion',
  nameTr: 'Barselona Pavyonu',
  blurb: 'After Mies van der Rohe (Barcelona, 1929): travertine podium and pool, a thin roof slab on eight chrome cruciform columns, freestanding onyx, green marble and travertine walls, tinted glass.',
  blurbTr: 'Mies van der Rohe’dan (Barselona, 1929): traverten podyum ve havuz, sekiz krom haç kesitli kolona oturan ince çatı döşemesi, serbest oniks, yeşil mermer ve traverten duvarlar, renkli cam.',
  // On the podium's west strip, eye height over the travertine: the big pool in the foreground,
  // the roof floating on its chrome columns, the onyx wall glowing under it.
  spawn: { position: [-16.2, 2.2, 4.8], lookAt: [3, 2.1, -2.5] },
  sun: { elevation: 10, azimuth: 305 },
  build(ctx, make) {
    const site = new Site(ctx, make);
    site.look(pavilionLook);
    site.budget(COLLAPSE_BUDGET);
    site.time('terrain', () => createTerrain(ctx, { plaza: { halfX: 26, halfZ: 16, finish: 'travertine' } }));
    const stone = (name: string, material: 'travertine' | 'marble' | 'onyx', finish: 'travertine' | 'marble' | 'onyx', x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, o: { voxel?: number; tint?: number } = {}) =>
      site.box(name, { material, finish, size: [x1 - x0, y1 - y0, z1 - z0], at: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], voxel: o.voxel ?? 0.025, tint: o.tint });

    // Podium around the pool, laid as travertine blocks of up to 6 m. 7.5 cm voxels: the podium is
    // 0.6 m deep and 500 m² (≈ 0.7 M voxels at this size, 2.2 M at 5 cm, which alone would take the
    // scene past its 3 s load budget); the roof, which breaks and falls, gets 5 cm.
    const block = (name: string, x0: number, x1: number, z0: number, z1: number) =>
      site.tiles(name, { material: 'travertine', finish: 'travertine', size: [x1 - x0, TOP, z1 - z0], at: [(x0 + x1) / 2, TOP / 2, (z0 + z1) / 2], voxel: 0.075, tile: 6 });
    const podium = [
      ...block('Podyum (kuzey)', PX0, PX1, PZ0, POOL.z0),
      ...block('Podyum', POOL.x1, PX1, POOL.z0, PZ1),
      ...block('Podyum (batı)', PX0, POOL.x0, POOL.z0, PZ1),
      ...block('Podyum (güney)', POOL.x0, POOL.x1, POOL.z1, PZ1),
    ];
    for (const p of podium) site.ground(p);
    site.decor.water({ ...POOL, y: TOP - 0.13, deep: 0x060808, ripple: 0.008 });

    // Columns and roof.
    const cols: Destructible[] = [];
    for (const x of COL_X)
      for (const z of COL_Z) {
        const c = site.beam({
          name: `Krom kolon ${cols.length + 1}`, material: 'stainless', profile: CRUCIFORM, start: [x, TOP, z], end: [x, TOP + STOREY, z],
          ends: { start: 'fixed', end: 'fixed' }, finish: 'chrome',
        });
        standOn(site, podium, c);
        cols.push(c);
      }
    const roof = site.box('Çatı döşemesi', {
      material: 'concrete', finish: 'smooth-concrete', size: [ROOF.x1 - ROOF.x0, ROOF.t, ROOF.z1 - ROOF.z0],
      at: [(ROOF.x0 + ROOF.x1) / 2, TOP + STOREY + ROOF.t / 2, (ROOF.z0 + ROOF.z1) / 2], voxel: 0.05, rebar: REBAR.slab, tint: 1.25,
    });
    for (const c of cols) site.on(c, roof);

    // Freestanding walls (they stop just under the roof and never carry it).
    const h1 = TOP + STOREY - 0.01;
    const walls = [
      stone('Oniks duvar', 'onyx', 'onyx', 1.6, 7.6, -0.55, -0.3, TOP, h1),
      stone('Yeşil mermer duvar (kuzey)', 'marble', 'marble', -4.6, 3.6, -4.5, -4.3, TOP, h1, { tint: TINOS }),
      stone('Yeşil mermer duvar (güneydoğu)', 'marble', 'marble', 8.8, 14.8, 6.2, 6.4, TOP, h1, { tint: TINOS }),
      stone('Traverten duvar', 'travertine', 'travertine', -16.6, -4.2, -7.75, -7.45, TOP, h1),
    ];
    for (const w of walls) standOn(site, podium, w);

    // Glass: laminated grey-green on the south front, annealed bottle-green to the east.
    glassWall(site, podium, roof, { axis: 'x', at: 3.9, from: -2.8, to: 10.0, panes: 4, type: 'laminated', t: 0.0128, tint: 0x8fa79b });
    glassWall(site, podium, roof, { axis: 'z', at: 11.4, from: -3.2, to: 3.2, panes: 2, type: 'annealed', t: 0.01, tint: 0x7fa088 });

    // A dark grove behind the pavilion (as on Montjuïc) and scattered groves further out.
    site.time('decor', () => {
      site.decor.trees({ rect: [-90, -130, 90, -60], count: 120, seed: 5, mix: [0.35, 0.45, 0.2] });
      site.decor.trees({ inner: 100, outer: 280, count: 200, seed: 9, mix: [0.4, 0.4, 0.2], groves: 12, groveRadius: 14 });
      site.decor.ridge({ radius: 1150, height: [30, 120], seed: 5 });
    });
  },
};

/** Link an element to every podium block it stands on. */
function standOn(site: Site, blocks: Destructible[], el: Destructible): void {
  const b = site.boxOf(el);
  let n = 0;
  for (const p of blocks) {
    const q = site.boxOf(p);
    if (q.max.x <= b.min.x || q.min.x >= b.max.x || q.max.z <= b.min.z || q.min.z >= b.max.z) continue;
    site.on(p, el);
    n++;
  }
  if (!n) throw new Error(`${el.name} stands on no podium block`);
}

/**
 * A glass wall of equal framed panes between chrome box mullions, standing on the podium; each
 * pane is held at its head by the roof slab (lateral link) and breaks when the roof lets go.
 */
function glassWall(site: Site, podium: Destructible[], roof: Destructible, o: { axis: 'x' | 'z'; at: number; from: number; to: number; panes: number; type: 'laminated' | 'annealed'; t: number; tint: number }): void {
  const w = (o.to - o.from) / o.panes;
  const y0 = TOP, y1 = TOP + STOREY;
  const pos = (s: number): [number, number] => (o.axis === 'x' ? [s, o.at] : [o.at, s]);
  const rot = o.axis === 'x' ? 0 : Math.PI / 2;
  for (let i = 0; i <= o.panes; i++) {
    const [x, z] = pos(o.from + i * w);
    const m = site.beam({
      name: `Kayıt ${o.axis}${i}`, material: 'stainless', profile: MULLION, start: [x, y0, z], end: [x, y1 - 0.005, z],
      up: o.axis === 'x' ? [0, 0, 1] : [1, 0, 0], ends: { start: 'free', end: 'free' }, finish: 'chrome',
    });
    standOn(site, podium, m);
    site.at(roof, m, new THREE.Box3(new THREE.Vector3(x - 0.08, y1 - 0.06, z - 0.08), new THREE.Vector3(x + 0.08, y1 + 0.04, z + 0.08)));
  }
  for (let i = 0; i < o.panes; i++) {
    const s = o.from + (i + 0.5) * w;
    const [x, z] = pos(s);
    const pane = site.glass({
      name: `${o.type === 'laminated' ? 'Lamine' : 'Tavlanmış'} cam ${o.axis}${i}`, type: o.type, width: w - 0.06, height: STOREY - 0.04, thickness: o.t,
      position: [x, (y0 + y1) / 2, z], rotation: [0, rot, 0], tint: o.tint, framed: true,
    });
    const hw = (w - 0.06) / 2;
    const head = o.axis === 'x'
      ? new THREE.Box3(new THREE.Vector3(x - hw, y1 - 0.05, z - 0.1), new THREE.Vector3(x + hw, y1 + 0.05, z + 0.1))
      : new THREE.Box3(new THREE.Vector3(x - 0.1, y1 - 0.05, z - hw), new THREE.Vector3(x + 0.1, y1 + 0.05, z + hw));
    site.at(roof, pane, head);
  }
}
