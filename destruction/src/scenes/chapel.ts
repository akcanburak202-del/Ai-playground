import type { SceneDef } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import type { SceneLook } from './look.ts';
import { COLLAPSE_BUDGET, REBAR, Site } from './kit.ts';

/**
 * Işık Kilisesi — after Tadao Ando's Church of the Light (Ibaraki, 1989). A board-formed
 * reinforced-concrete box three cubes long (5.9 × 17.7 × 5.9 m inside, 300 mm walls) sliced near
 * its entrance end by a freestanding wall at 15°; the altar wall is cut through by a cross of
 * slits, floor to ceiling and wall to wall, so its four panels are held only by the side walls,
 * the ground and the roof. A thin RC roof slab spans the side walls. Granite setts and a
 * reflecting pool on the forecourt; morning sun low in the east-south-east.
 *
 * Structure: ground → walls → roof; the upper altar panels hang off the side walls. Shoot away a
 * wall top and the roof loses that bearing; blow a long wall and the roof spans until it cannot.
 */

/** Interior width (z), length (x), height; wall thickness, m */
const W = 5.9, L = 17.7, H = 5.9, T = 0.3;
/** Outer half extents */
const HX = L / 2 + T, HZ = W / 2 + T;
/** Cross slit width and the height of its crossing (centre of the horizontal slit), m */
const SLIT = 0.18, CROSS_Y = 4.05;
/** The slicing wall: 15° to the long axis, crossing the south wall's inner face at x = −4.5 */
const SLICE_DEG = 15, SLICE_X0 = -4.5, SLICE_FROM = -11, SLICE_TO = 3, SLICE_H = 5.6;

/** Golden-hour photography settings (see look.ts). */
export const chapelLook: SceneLook = { sky: { turbidity: 3.4, rayleigh: 1.7 }, exposure: 0.9, ambient: 0.55, fov: 55, visibility: 7000, glassProbes: true };

export const chapel: SceneDef = {
  id: 'chapel',
  name: 'Church of the Light',
  nameTr: 'Işık Kilisesi',
  blurb: 'After Tadao Ando (Ibaraki, 1989): a board-formed reinforced-concrete box sliced by a freestanding wall at 15°, the altar wall cut through by a cross of light, a thin roof slab on the side walls.',
  blurbTr: 'Tadao Ando’dan (İbaraki, 1989): 15° açılı serbest bir duvarın kestiği kalıp izli betonarme kutu; sunak duvarını boydan boya kesen ışık haçı, yan duvarlara oturan ince çatı döşemesi.',
  // From the south-east across the pool: the cross in the sunlit altar wall, the long south wall
  // raked by the low sun (shows the board marks and tie holes), the slicing wall in cool shade.
  spawn: { position: [17, 1.6, 15], lookAt: [1, 2.6, 0] },
  // Early morning, east by south: the light comes through the cross into the nave.
  sun: { elevation: 9, azimuth: 72 },
  build(ctx, make) {
    const site = new Site(ctx, make);
    site.look(chapelLook);
    site.budget(COLLAPSE_BUDGET);
    site.time('terrain', () => createTerrain(ctx, { plaza: { halfX: 21, halfZ: 15, finish: 'pavers' } }));
    const concrete = { material: 'concrete' as const, finish: 'board-formed-concrete' as const, rebar: REBAR.wall, tint: 0.92 };
    const wall = (name: string, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, voxel = 0.025): Destructible =>
      site.box(name, { ...concrete, size: [x1 - x0, y1 - y0, z1 - z0], at: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], voxel });

    // Long walls. The south wall is broken where the slicing wall passes through it.
    const north = wall('Kuzey duvarı', -HX, HX, -HZ, -W / 2, 0, H, 0.03);
    const southE = wall('Güney duvarı (doğu)', -1.9, HX, W / 2, HZ, 0, H);
    const southW = wall('Güney duvarı (batı)', -HX, -5.3, W / 2, HZ, 0, H);
    // Entrance end wall, stopped short of the slicing wall.
    const west = wall('Batı duvarı', -HX, -L / 2, -W / 2, 1.45, 0, H, 0.03);
    // Altar wall: four panels around the cross.
    const x0 = L / 2, x1 = HX, yLo = CROSS_Y - SLIT / 2, yHi = CROSS_Y + SLIT / 2;
    const ll = wall('Sunak paneli (sol alt)', x0, x1, -W / 2, -SLIT / 2, 0, yLo);
    const lr = wall('Sunak paneli (sağ alt)', x0, x1, SLIT / 2, W / 2, 0, yLo);
    const ul = wall('Sunak paneli (sol üst)', x0, x1, -W / 2, -SLIT / 2, yHi, H);
    const ur = wall('Sunak paneli (sağ üst)', x0, x1, SLIT / 2, W / 2, yHi, H);
    // The freestanding wall at 15°.
    const a = (SLICE_DEG * Math.PI) / 180;
    const len = (SLICE_TO - SLICE_FROM) / Math.cos(a);
    const cx = (SLICE_FROM + SLICE_TO) / 2;
    const cz = W / 2 + Math.tan(a) * (cx - SLICE_X0);
    const slice = site.box('Serbest duvar (15°)', { ...concrete, size: [len, SLICE_H, T], at: [cx, SLICE_H / 2, cz], rotY: -a, voxel: 0.025 });
    // Roof slab.
    const roof = site.box('Çatı döşemesi', {
      material: 'concrete', finish: 'smooth-concrete', size: [2 * HX, 0.3, 2 * HZ], at: [0, H + 0.15, 0], voxel: 0.05, rebar: REBAR.slab, tint: 0.92,
    });

    for (const el of [north, southE, southW, west, ll, lr, slice]) site.ground(el);
    // The altar panels are tied into the side walls; the upper two hang from them.
    site.side(north, ll);
    site.side(southE, lr);
    site.side(north, ul);
    site.side(southE, ur);
    for (const el of [north, southE, southW, west, ul, ur]) site.on(el, roof);

    buildForecourt(site);
    site.time('decor', () => {
      site.decor.trees({ inner: 80, outer: 260, count: 240, seed: 11, mix: [0.45, 0.35, 0.2], groves: 12, groveRadius: 14 });
      site.decor.ridge({ radius: 1150, height: [30, 110], seed: 11 });
    });
  },
};

/** Granite-kerbed reflecting pool on the forecourt, parallel to the long south wall. */
function buildForecourt(site: Site): void {
  const x0 = 0, x1 = 14, z0 = 7, z1 = 10.5, k = 0.3, h = 0.28;
  const kerb = (name: string, ax0: number, ax1: number, az0: number, az1: number) => {
    const el = site.box(name, {
      material: 'granite', finish: 'granite', size: [ax1 - ax0, h, az1 - az0], at: [(ax0 + ax1) / 2, h / 2, (az0 + az1) / 2], voxel: 0.03, tint: 0.8,
    });
    site.ground(el);
  };
  kerb('Havuz kenarı (kuzey)', x0 - k, x1 + k, z0 - k, z0);
  kerb('Havuz kenarı (güney)', x0 - k, x1 + k, z1, z1 + k);
  kerb('Havuz kenarı (batı)', x0 - k, x0, z0, z1);
  kerb('Havuz kenarı (doğu)', x1, x1 + k, z0, z1);
  site.decor.water({ x0, x1, z0, z1, y: h - 0.05, deep: 0x0c1312 });
}
