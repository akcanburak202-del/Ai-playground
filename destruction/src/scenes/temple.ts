import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneDef, SimContext } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import type { SceneLook } from './look.ts';
import { COLLAPSE_BUDGET, Site } from './kit.ts';

/**
 * Dor Tapınağı — a Doric marble temple after the Parthenon's proportions, reduced to a 4 × 6
 * peristyle: a three-step crepidoma, fluted columns of stacked drums with entasis, capitals of a
 * convex echinus under a square abacus, architrave and frieze-and-cornice blocks spanning column to
 * column, triglyphs, mutules with guttae under the cornice, triangular pediments front and back,
 * and a cella of marble ashlar.
 *
 * Classical masonry is dry: nothing but weight and friction holds it. So everything above the
 * stylobate is a rigid body at rest (asleep until disturbed) — a hard hit topples drums, a lost
 * column lets its architraves slide off, exactly as earthquakes and gunpowder have done to real
 * temples. The stones are settled onto their beds before the viewer arrives.
 */

/** Lower column diameter (the module), column height, interaxial spacing, m (Parthenon ratios) */
const D = 1.0, COL_H = 5.4, BAY = 2.25;
const NX = 4, NZ = 6;
const STEP_H = 0.26, STEP_D = 0.4, STEPS = 3;
const DRUMS = 3;
/** Capital: echinus and abacus heights, abacus side */
const ECH_H = 0.26, ABA_H = 0.2, ABA = 1.14;
/** Entablature: architrave, frieze + cornice heights and depth */
const ARCH_H = 0.7, FRIEZE_H = 0.75, CORNICE_H = 0.3, ENT_D = 0.98;
/** How far the cornice projects past the frieze, m */
const CORNICE_OUT = 0.24;
/** Warm Pentelic marble: iron-bearing, weathered to honey */
const PENTELIC = 0xf4e6cc;

/** Golden-hour photography settings (see look.ts). */
export const templeLook: SceneLook = { sky: { turbidity: 3.6, rayleigh: 1.6 }, exposure: 1.0, fov: 55, visibility: 6000, glassProbes: true };

export const temple: SceneDef = {
  id: 'temple',
  name: 'Doric Temple',
  nameTr: 'Dor Tapınağı',
  blurb: 'A Doric marble temple on Parthenon proportions (4 × 6 columns): fluted drum columns with entasis, architraves, frieze, pediments and a cella; dry masonry held only by weight and friction.',
  blurbTr: 'Parthenon oranlarında Dor düzeninde mermer tapınak (4 × 6 kolon): entasisli yivli tambur kolonlar, arşitrav, friz, alınlıklar ve naos; yalnızca ağırlık ve sürtünmeyle ayakta duran harçsız taş.',
  // Low, from the front-left corner of the precinct: the peristyle rises over the viewer and the
  // entasis, flutes and triglyph rhythm read against the sky.
  spawn: { position: [-9.5, 1.6, 14.5], lookAt: [0, 4.2, 0] },
  sun: { elevation: 9, azimuth: 300 },
  build(ctx, make) {
    const site = new Site(ctx, make);
    site.look(templeLook);
    // A paved margin around the crepidoma, then the dry grass of the hilltop.
    site.time('terrain', () => createTerrain(ctx, { plaza: { halfX: 8, halfZ: 10, finish: 'travertine' } }));
    const marble = { material: 'marble' as const, finish: 'marble' as const, tint: PENTELIC };
    const ax = ((NX - 1) * BAY) / 2, az = ((NZ - 1) * BAY) / 2;
    const r0 = D / 2;

    // Crepidoma: three steps; the top one is the stylobate. Voxels: 5 cm on the stylobate (the
    // columns stand on it and it takes the hits), 6.5 cm below (exactly four per 26 cm riser).
    let stylobate: Destructible | null = null;
    for (let i = 0; i < STEPS; i++) {
      const grow = (STEPS - 1 - i) * STEP_D;
      const hx = ax + r0 + 0.3 + grow, hz = az + r0 + 0.3 + grow;
      const step = site.box(i === STEPS - 1 ? 'Stilobat' : `Basamak ${i + 1}`, { ...marble, size: [2 * hx, STEP_H, 2 * hz], at: [0, (i + 0.5) * STEP_H, 0], voxel: i === STEPS - 1 ? 0.05 : 0.065 });
      if (i === 0) site.ground(step);
      else site.on(stylobate!, step);
      stylobate = step;
    }
    const base = STEPS * STEP_H;

    // Columns: drums with entasis (linear taper to 0.78 D at the neck), then the capital.
    const shaftH = COL_H - ECH_H - ABA_H;
    const taper = 0.22;
    const loose: Destructible[] = [];
    const shapes = new Map<Destructible, ShapeFn>();
    const cols: [number, number][] = [];
    for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) if (i === 0 || i === NX - 1 || k === 0 || k === NZ - 1) cols.push([-ax + i * BAY, -az + k * BAY]);
    cols.forEach(([x, z], n) => {
      const dh = shaftH / DRUMS;
      for (let d = 0; d < DRUMS; d++) {
        const rBot = r0 * (1 - (taper * d) / DRUMS), rTop = r0 * (1 - (taper * (d + 1)) / DRUMS);
        const drum = site.voxel({
          name: `Tambur ${n + 1}.${d + 1}`, ...marble, shape: { type: 'cylinder', radius: rBot, height: dh, flutes: 20, taper: 1 - rTop / rBot },
          position: [x, base + (d + 0.5) * dh, z], voxelSize: 0.05, dynamic: true,
        }, box(x, base + d * dh, z, rBot, base + (d + 1) * dh));
        shapes.set(drum, drumShape((rBot + rTop) / 2, dh));
        loose.push(drum);
      }
      // Capital: the echinus, a convex cushion flaring from the neck, under the square abacus.
      const neck = r0 * (1 - taper), rEch = 0.95 * (ABA / 2);
      const ech = site.voxel({
        name: `Ekinus ${n + 1}`, ...marble, shape: echinusShape(neck, rEch, ECH_H),
        position: [x, base + shaftH + ECH_H / 2, z], voxelSize: 0.03, dynamic: true,
      }, box(x, base + shaftH, z, rEch, base + shaftH + ECH_H));
      shapes.set(ech, drumShape((neck + rEch) / 2, ECH_H));
      const aba = site.box(`Abaküs ${n + 1}`, { ...marble, size: [ABA, ABA_H, ABA], at: [x, base + shaftH + ECH_H + ABA_H / 2, z], voxel: 0.03, dynamic: true });
      shapes.set(aba, blockShape(ABA, ABA_H, ABA));
      loose.push(ech, aba);
    });

    // Entablature: the front and back blocks run through the corners; the flank blocks butt
    // against them.
    const top = base + COL_H;
    const hd = ENT_D / 2;
    const course = (name: string, y0: number, h: number, overhang: number): Destructible[] => {
      const d = hd + overhang;
      const out: Destructible[] = [];
      for (const z of [-az, az]) {
        for (let b = 0; b < NX - 1; b++) {
          const xa = b === 0 ? -ax - d : -ax + b * BAY, xb = b === NX - 2 ? ax + d : -ax + (b + 1) * BAY;
          const bl = block(site, `${name} ${z < 0 ? 'arka' : 'ön'} ${b + 1}`, xa, xb, y0, y0 + h, z - d, z + d);
          shapes.set(bl, blockShape(xb - xa, h, 2 * d));
          out.push(bl);
        }
      }
      for (const x of [-ax, ax]) {
        for (let b = 0; b < NZ - 1; b++) {
          const za = b === 0 ? -az + d : -az + b * BAY, zb = b === NZ - 2 ? az - d : -az + (b + 1) * BAY;
          const bl = block(site, `${name} ${x < 0 ? 'sol' : 'sağ'} ${b + 1}`, x - d, x + d, y0, y0 + h, za, zb);
          shapes.set(bl, blockShape(2 * d, h, zb - za));
          out.push(bl);
        }
      }
      loose.push(...out);
      return out;
    };
    course('Arşitrav', top, ARCH_H, 0);
    const frieze = course('Friz', top + ARCH_H, FRIEZE_H, 0);
    const cornice = course('Korniş', top + ARCH_H + FRIEZE_H, CORNICE_H, CORNICE_OUT);
    // Pediments on the front and back cornices.
    const pedW = 2 * (ax + hd + CORNICE_OUT), pedH = pedW * 0.13;
    for (const z of [-az, az]) {
      const ped = pediment(site, z < 0 ? 'Alınlık (arka)' : 'Alınlık (ön)', 0, top + ARCH_H + FRIEZE_H + CORNICE_H, z, pedW, pedH, ENT_D * 0.8);
      // The tympanum's lower half as a slab: it bears on the cornice over its whole width.
      shapes.set(ped, (R) => blockShape(pedW, pedH / 2, ENT_D * 0.8)(R).setTranslation(0, -pedH / 4, 0));
      loose.push(ped);
    }

    buildCella(site, stylobate!, base, ax, az, top);
    trueBeds(ctx, shapes);
    site.time('settle', () => settle(ctx, loose, 0.8));
    site.budget(COLLAPSE_BUDGET + loose.length);
    keepStonesLive(site, loose);
    triglyphs(site, frieze, ax, az, top + ARCH_H);
    mutules(site, cornice, ax, az, top + ARCH_H + FRIEZE_H);

    site.time('decor', () => {
      site.decor.trees({ inner: 70, outer: 260, count: 240, seed: 23, mix: [0.55, 0.2, 0.25], groves: 12, groveRadius: 14 });
      site.decor.ridge({ radius: 1150, height: [40, 140], seed: 23 });
    });
  },
};

function box(x: number, y0: number, z: number, r: number, y1: number): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(x - r, y0, z - r), new THREE.Vector3(x + r, y1, z + r));
}

/** A loose marble block (architrave, frieze) as a sleeping rigid body. */
function block(site: Site, name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Destructible {
  return site.box(name, {
    material: 'marble', finish: 'marble', tint: PENTELIC, size: [x1 - x0, y1 - y0, z1 - z0], at: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], voxel: 0.05, dynamic: true,
  });
}

/**
 * Triglyphs on the frieze: one over every column and one over every bay (the Doric rhythm),
 * pushed out to the very corners of the building. Each is three vertical bars (femora) proud of
 * the frieze between two grooves, carried by the frieze block it sits on — they move and vanish
 * with their stone.
 */
function triglyphs(site: Site, frieze: Destructible[], ax: number, az: number, y0: number): void {
  const W = 0.42, bar = 0.1, gap = (W - 3 * bar) / 2, proud = 0.035, H = FRIEZE_H - 0.02;
  const hd = ENT_D / 2;
  const mat = site.decor.track(new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.62 }));
  const per = new Map<Destructible, THREE.BufferGeometry[]>();
  const put = (x: number, z: number, nx: number, nz: number) => {
    const el = frieze.find((b) => {
      const bb = site.boxOf(b);
      return x >= bb.min.x - 1e-3 && x <= bb.max.x + 1e-3 && z >= bb.min.z - 1e-3 && z <= bb.max.z + 1e-3;
    });
    if (!el) return;
    const list = per.get(el) ?? [];
    for (let i = 0; i < 3; i++) {
      const off = -W / 2 + bar / 2 + i * (bar + gap);
      const g = new THREE.BoxGeometry(nx !== 0 ? proud : bar, H, nz !== 0 ? proud : bar);
      g.translate(x + nx * proud / 2 + (nz !== 0 ? off : 0) - el.root.position.x, y0 + FRIEZE_H / 2 - el.root.position.y, z + nz * proud / 2 + (nx !== 0 ? off : 0) - el.root.position.z);
      list.push(g);
    }
    per.set(el, list);
  };
  const along = (a: number, n: number) => {
    const out: number[] = [];
    for (let i = 0; i <= 2 * n; i++) out.push(-a + (i * a) / n);
    out[0] = -a - hd + W / 2;
    out[out.length - 1] = a + hd - W / 2;
    return out;
  };
  for (const x of along(ax, NX - 1)) for (const z of [-1, 1]) put(x, z * (az + hd), 0, z);
  for (const z of along(az, NZ - 1)) for (const x of [-1, 1]) put(x * (ax + hd), z, x, 0);
  for (const [el, geos] of per) {
    const g = mergeGeometries(geos, false);
    for (const q of geos) q.dispose();
    if (!g) continue;
    const m = new THREE.Mesh(site.decor.track(g), mat);
    m.castShadow = m.receiveShadow = true;
    m.name = 'triglyphs';
    el.root.add(m);
  }
}

/** Triangular pediment (tympanum and raking cornice as one block), resting on the cornice. */
function pediment(site: Site, name: string, x: number, y0: number, z: number, w: number, h: number, d: number): Destructible {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  // Intersection of the base plane and the two raking faces, extruded: exact inside, a lower
  // bound outside (all a density sample needs near the surface).
  const L = Math.hypot(2 * hh, hw);
  const sdf = (px: number, py: number, pz: number) => {
    const d2 = Math.max(-(py + hh), (2 * hh * Math.abs(px) + hw * py - hw * hh) / L);
    return Math.max(d2, Math.abs(pz) - hd);
  };
  return site.voxel({
    name, material: 'marble', finish: 'marble', tint: PENTELIC, shape: { type: 'sdf', bounds: [w, h, d], sdf }, position: [x, y0 + hh, z], voxelSize: 0.05, dynamic: true,
  }, new THREE.Box3(new THREE.Vector3(x - hw, y0, z - hd), new THREE.Vector3(x + hw, y0 + h, z + hd)));
}

/** The cella: ashlar walls on the stylobate with a doorway in the pronaos wall. */
function buildCella(site: Site, stylobate: Destructible, base: number, ax: number, az: number, top: number): void {
  const t = 0.6, x0 = -ax + 1.25, x1 = ax - 1.25, z0 = -az + 1.6, z1 = az - 2.3, y1 = top - 0.02;
  const wall = (name: string, a0: number, a1: number, b0: number, b1: number) => {
    const w = site.box(name, {
      material: 'marble', finish: 'marble', tint: PENTELIC, size: [a1 - a0, y1 - base, b1 - b0], at: [(a0 + a1) / 2, (base + y1) / 2, (b0 + b1) / 2], voxel: 0.06,
    });
    site.on(stylobate, w);
    return w;
  };
  wall('Naos duvarı (sol)', x0, x0 + t, z0, z1);
  wall('Naos duvarı (sağ)', x1 - t, x1, z0, z1);
  wall('Naos duvarı (arka)', x0 + t, x1 - t, z0, z0 + t);
  const door = 1.7;
  const left = wall('Naos kapısı (sol)', x0 + t, -door / 2, z1 - t, z1);
  const right = wall('Naos kapısı (sağ)', door / 2, x1 - t, z1 - t, z1);
  // The wall over the doorway, held between the jambs.
  const lintelY0 = base + 4.2;
  const lintel = site.box('Kapı lentosu', {
    material: 'marble', finish: 'marble', tint: PENTELIC, size: [door, y1 - lintelY0, t], at: [0, (lintelY0 + y1) / 2, z1 - t / 2], voxel: 0.05,
  });
  site.side(left, lintel);
  site.side(right, lintel);
}

/**
 * Give each loose stone a collision shape it can stand on. A dynamic voxel element's own hull is
 * built from ~120 subsampled surface samples about half a voxel inside its surface: fine for
 * rubble, but a drum's bed ends up as a few points and the loaded colonnade creeps and topples on
 * its own. Dry masonry stands on flat beds, and in Rapier large convex-hull faces in contact creep
 * too (measured: 10–70 cm over 8 s for a two-column bay), while its rounded primitives rest and
 * fall asleep (< 1 mm). So each stone gets a rounded cylinder or cuboid of its design size (1 cm
 * rounding), keeping its element's mass, friction, collision groups and contact-force reporting.
 * Once a stone has lost enough material its element rebuilds its own hull, as for any debris.
 */
type ShapeFn = (R: typeof RAPIER) => RAPIER.ColliderDesc;

function trueBeds(ctx: SimContext, shapes: Map<Destructible, ShapeFn>): void {
  const phys = ctx.physics;
  const bodies: RAPIER.RigidBody[] = [];
  phys.world.forEachRigidBody((b) => {
    if (b.isDynamic() && b.numColliders() === 1) bodies.push(b);
  });
  for (const b of bodies) {
    const old = b.collider(0);
    const owner = phys.ownerOf(old);
    const make = owner?.destructible ? shapes.get(owner.destructible) : undefined;
    if (!owner || !make) continue;
    const desc = make(phys.R);
    desc.setMass(old.mass()).setFriction(old.friction()).setRestitution(old.restitution()).setCollisionGroups(old.collisionGroups());
    desc.setActiveEvents(old.activeEvents()).setContactForceEventThreshold(old.contactForceEventThreshold());
    phys.removeCollider(old);
    phys.attachCollider(b, desc, owner);
    b.sleep();
  }
}

/**
 * The standing stones are architecture, not rubble: keep them out of the rigid-body budget. Once a
 * collapse goes over budget the physics world freezes (makes fixed) the oldest sleeping bodies,
 * and the colonnade — built first, asleep — would be first in line: a frozen drum no longer
 * topples when hit, and hangs in the air when the drum under it is shot away. Exempt bodies still
 * count towards the budget (the scene raises it by the number of stones), they are just never the
 * ones frozen. A stone that loses enough material rebuilds its hull as a new body and is rubble
 * from then on.
 */
function keepStonesLive(site: Site, loose: Destructible[]): void {
  const phys = site.ctx.physics;
  const stones = new Set(loose);
  phys.world.forEachRigidBody((b) => {
    if (!b.isDynamic() || b.numColliders() === 0) return;
    const el = phys.ownerOf(b.collider(0))?.destructible;
    if (el && stones.has(el)) phys.exemptFromBudget(b);
  });
}

/**
 * Let the loose stones find their beds together before the viewer arrives (woken all at once —
 * a stack woken piecemeal, a stone at a time, is kicked about by its sleeping neighbours), then
 * put them to sleep until something disturbs them. Steps only the physics world and the stones.
 */
function settle(ctx: SimContext, loose: Destructible[], seconds: number): void {
  const phys = ctx.physics;
  const bodies: RAPIER.RigidBody[] = [];
  phys.world.forEachRigidBody((b) => {
    if (b.isDynamic()) bodies.push(b);
  });
  for (const b of bodies) b.wakeUp();
  const dt = 1 / 60;
  // Settling is preparation, not an event: a stone finding its bed must not raise dust, clatter or
  // crack anything (FX were reset before the build, so their puffs would greet the viewer).
  const bus = ctx.events;
  const emit = bus.emit;
  bus.emit = () => {};
  try {
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      phys.step(dt);
      for (const el of loose) if (!el.disposed) el.fixedUpdate?.(dt);
    }
  } finally {
    bus.emit = emit;
  }
  for (const b of bodies) {
    b.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.sleep();
  }
}

/**
 * Doric echinus as a solid of revolution: radius r(u) = r_n + (r_e − r_n)·(1 − (1 − u)^p) from the
 * neck (u = 0) to the abacus (u = 1). The classical profile leaves the annulets at ≈ 45–50° and
 * curls up to meet the abacus nearly vertically (Parthenon: Penrose, "An Investigation of the
 * Principles of Athenian Architecture", 1888, pl. on the capitals); p = 1.7 gives that convex
 * cushion (a straight cone would be p = 1). The radial distance is divided by √(1 + r′²) so the
 * field stays a distance near the surface.
 */
function echinusShape(rn: number, re: number, h: number): { type: 'sdf'; bounds: [number, number, number]; sdf: (x: number, y: number, z: number) => number } {
  const p = 1.7, dr = re - rn;
  const sdf = (x: number, y: number, z: number) => {
    const u = Math.min(1, Math.max(0, y / h + 0.5));
    const q = Math.pow(1 - u, p - 1);
    const r = rn + dr * (1 - q * (1 - u));
    const slope = (dr * p * q) / h;
    const radial = (Math.hypot(x, z) - r) / Math.sqrt(1 + slope * slope);
    return Math.max(radial, Math.abs(y) - h / 2);
  };
  return { type: 'sdf', bounds: [2 * re + 0.02, h, 2 * re + 0.02], sdf };
}

/**
 * Mutules under the cornice soffit: a thin plaque over every triglyph and every metope, each with
 * three rows of six guttae (the stone "pegs" of the timber prototype), carried by the cornice
 * block above them. Vitruvius IV.3; proportions after the Parthenon (mutule ≈ triglyph width,
 * guttae ≈ 1/25 of the module across).
 */
function mutules(site: Site, cornice: Destructible[], ax: number, az: number, y0: number): void {
  // Plaques from just outside the triglyphs to just inside the cornice's drip edge.
  const hd = ENT_D / 2, W = 0.4, T = 0.035, from = 0.04, depth = CORNICE_OUT - 0.06, gr = 0.016, gh = 0.03;
  const mat = site.decor.track(new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.62 }));
  const per = new Map<Destructible, THREE.BufferGeometry[]>();
  const peg = new THREE.CylinderGeometry(gr, gr * 0.85, gh, 6, 1, false).deleteAttribute('uv');
  const plaque = new THREE.BoxGeometry(1, 1, 1).deleteAttribute('uv');
  // (x, z) on the frieze face, outward normal (nx, nz).
  const put = (x: number, z: number, nx: number, nz: number) => {
    const ox = x + nx * (from + depth / 2), oz = z + nz * (from + depth / 2);
    const el = cornice.find((b) => {
      const bb = site.boxOf(b);
      return ox >= bb.min.x - 1e-3 && ox <= bb.max.x + 1e-3 && oz >= bb.min.z - 1e-3 && oz <= bb.max.z + 1e-3;
    });
    if (!el) return;
    const list = per.get(el) ?? [];
    const sx = nx !== 0 ? depth : W, sz = nz !== 0 ? depth : W;
    list.push(plaque.clone().scale(sx, T, sz).translate(ox, y0 - T / 2, oz));
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 6; b++) {
        const out = from + (a + 0.5) * (depth / 3), side = -W / 2 + (b + 0.5) * (W / 6);
        const gx = x + nx * out + (nz !== 0 ? side : 0), gz = z + nz * out + (nx !== 0 ? side : 0);
        list.push(peg.clone().translate(gx, y0 - T - gh / 2, gz));
      }
    per.set(el, list);
  };
  // Over every triglyph (column axes, mid-bays, pushed out to the corners) and every metope between.
  const along = (a: number, n: number) => {
    const tri: number[] = [];
    for (let i = 0; i <= 2 * n; i++) tri.push(-a + (i * a) / n);
    tri[0] = -a - hd + 0.21;
    tri[tri.length - 1] = a + hd - 0.21;
    const out = [...tri];
    for (let i = 0; i + 1 < tri.length; i++) out.push((tri[i]! + tri[i + 1]!) / 2);
    return out;
  };
  for (const x of along(ax, NX - 1)) for (const z of [-1, 1]) put(x, z * (az + hd), 0, z);
  for (const z of along(az, NZ - 1)) for (const x of [-1, 1]) put(x * (ax + hd), z, x, 0);
  peg.dispose();
  plaque.dispose();
  for (const [el, geos] of per) {
    const g = mergeGeometries(geos, false);
    for (const q of geos) q.dispose();
    if (!g) continue;
    el.root.updateMatrixWorld(true);
    g.applyMatrix4(new THREE.Matrix4().copy(el.root.matrixWorld).invert());
    const m = new THREE.Mesh(site.decor.track(g), mat);
    m.castShadow = m.receiveShadow = true;
    m.name = 'mutules';
    el.root.add(m);
  }
}

/** Rounding of the stones' collision shapes, m */
const ROUND = 0.01;
const drumShape = (r: number, h: number): ShapeFn => (R) => R.ColliderDesc.roundCylinder(h / 2 - ROUND, r - ROUND, ROUND);
const blockShape = (x: number, y: number, z: number): ShapeFn => (R) => R.ColliderDesc.roundCuboid(x / 2 - ROUND, y / 2 - ROUND, z / 2 - ROUND, ROUND);
