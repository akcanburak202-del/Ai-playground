import * as THREE from 'three';
import type {
  BeamProfile, BrittleFinish, ElementFactories, GlassPaneSpec, RebarSpec, SimContext, SteelBeamSpec, SteelPlateSpec, VoxelElementSpec,
} from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import type { MaterialId } from '../physics/materials.ts';
import { setExternalLoad } from '../structure/index.ts';
import { Decor } from './decor.ts';

export type V3 = [number, number, number];

export interface BoxOpts {
  material: MaterialId;
  finish: BrittleFinish;
  /** Full size x, y, z before rotation, m */
  size: V3;
  /** Centre, m */
  at: V3;
  /** Rotation about the vertical, rad */
  rotY?: number;
  voxel?: number;
  rebar?: RebarSpec;
  tint?: number;
  dynamic?: boolean;
}

/** Rigid-body budget for a scene's rubble (DESIGN.md §5 allows 900; rubble at 500 keeps a collapse near 30 fps). */
export const DEFAULT_BODY_BUDGET = 500;

/** Common structural profiles (EN 10365 dimensions, m). */
export const PROFILES = {
  HEB200: { type: 'I', h: 0.2, b: 0.2, tw: 0.009, tf: 0.015 },
  HEB300: { type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 },
  IPE300: { type: 'I', h: 0.3, b: 0.15, tw: 0.0071, tf: 0.0107 },
  IPE360: { type: 'I', h: 0.36, b: 0.17, tw: 0.008, tf: 0.0127 },
  IPE400: { type: 'I', h: 0.4, b: 0.18, tw: 0.0086, tf: 0.0135 },
  CHS139: { type: 'tube', d: 0.1397, t: 0.008 },
} as const satisfies Record<string, BeamProfile>;

/** Reinforcement layouts used by the scenes (EN 1992-1-1 detailing: cover 30–40 mm). */
export const REBAR = {
  wall: { diameter: 0.012, spacing: 0.2, cover: 0.035, layout: 'two-faces' },
  heavyWall: { diameter: 0.016, spacing: 0.2, cover: 0.04, layout: 'two-faces' },
  thin: { diameter: 0.01, spacing: 0.15, cover: 0.03, layout: 'center' },
  slab: { diameter: 0.012, spacing: 0.2, cover: 0.03, layout: 'two-faces' },
} as const satisfies Record<string, RebarSpec>;

/**
 * Scene-building helpers: element factories that remember each element's design box (the exact
 * shape the scene asked for — element bounds are padded by a voxel), support links computed from
 * those boxes, and the decor group.
 */
export class Site {
  readonly ctx: SimContext;
  readonly make: ElementFactories;
  readonly decor: Decor;
  private readonly boxes = new Map<Destructible, THREE.Box3>();
  /** Build time per element kind (and 'links', 'decor'), ms — load-budget diagnostics */
  readonly timings: Record<string, number> = {};
  /** The most recent site (sandbox diagnostics) */
  static last: Site | null = null;

  constructor(ctx: SimContext, make: ElementFactories) {
    Site.last = this;
    this.ctx = ctx;
    this.make = make;
    this.decor = new Decor(ctx);
    this.budget(DEFAULT_BODY_BUDGET);
  }

  /**
   * Cap on simultaneously simulated rigid bodies for this scene (PhysicsWorld freezes the oldest
   * sleeping ones beyond it; the voxel module stops cutting rubble into pieces near it). The world
   * keeps the value across scene loads, so every site sets it.
   */
  budget(bodies: number): void {
    this.ctx.physics.maxDynamicBodies = bodies;
  }

  // ── Elements ──────────────────────────────────────────────────────────────────────────────

  /**
   * A large brittle box built as a grid of tiles no larger than `tile` in plan (paving, podia,
   * long walls). Each tile is its own element: Rapier rebuilds a voxel collider completely on the
   * step after any cell of it changes (≈ 0.1 µs per cell), so one 30 m podium would cost tens of
   * milliseconds on every step of a collapse; tiles keep that local.
   */
  tiles(name: string, o: BoxOpts & { tile: number }): Destructible[] {
    const [sx, sy, sz] = o.size;
    const nx = Math.max(1, Math.ceil(sx / o.tile - 1e-6)), nz = Math.max(1, Math.ceil(sz / o.tile - 1e-6));
    const out: Destructible[] = [];
    for (let i = 0; i < nx; i++)
      for (let k = 0; k < nz; k++) {
        const w = sx / nx, d = sz / nz;
        out.push(this.box(nx * nz > 1 ? `${name} ${i + 1}-${k + 1}` : name, {
          ...o, size: [w, sy, d], at: [o.at[0] - sx / 2 + (i + 0.5) * w, o.at[1], o.at[2] - sz / 2 + (k + 0.5) * d],
        }));
      }
    return out;
  }

  /** A brittle box element (wall, slab, block, step). */
  box(name: string, o: BoxOpts): Destructible {
    const spec: VoxelElementSpec = {
      name, material: o.material, finish: o.finish, shape: { type: 'box', size: o.size }, position: o.at,
      rotation: o.rotY ? [0, o.rotY, 0] : undefined, voxelSize: o.voxel, rebar: o.rebar, tint: o.tint, dynamic: o.dynamic,
    };
    const el = this.time('voxel', () => this.make.voxel(spec));
    this.boxes.set(el, orientedBox(o.at, o.size, o.rotY ?? 0));
    return el;
  }

  /** Any voxel element with its design box given explicitly (cylinders, SDF shapes). */
  voxel(spec: VoxelElementSpec, box: THREE.Box3): Destructible {
    const el = this.time('voxel', () => this.make.voxel(spec));
    this.boxes.set(el, box.clone());
    return el;
  }

  beam(spec: SteelBeamSpec): Destructible {
    const el = this.time('beam', () => this.make.beam(spec));
    const r = profileRadius(spec.profile);
    const a = vec(spec.start), b = vec(spec.end);
    // The swept section's extent: a disc of radius r normal to the axis (none along it).
    const ax = b.clone().sub(a).normalize();
    const e = new THREE.Vector3(r * Math.sqrt(1 - ax.x * ax.x), r * Math.sqrt(1 - ax.y * ax.y), r * Math.sqrt(1 - ax.z * ax.z));
    this.boxes.set(el, new THREE.Box3().setFromPoints([a, b]).expandByVector(e));
    return el;
  }

  plate(spec: SteelPlateSpec): Destructible {
    const el = this.time('plate', () => this.make.plate(spec));
    const rot = spec.rotation && !(spec.rotation instanceof THREE.Quaternion) ? vec(spec.rotation as V3) : new THREE.Vector3();
    this.boxes.set(el, orientedBox(arr(spec.position), [spec.width, spec.height, spec.thickness], rot.y));
    return el;
  }

  glass(spec: GlassPaneSpec): Destructible {
    const el = this.time('glass', () => this.make.glass(spec));
    const rot = spec.rotation && !(spec.rotation instanceof THREE.Quaternion) ? vec(spec.rotation as V3) : new THREE.Vector3();
    this.boxes.set(el, orientedBox(arr(spec.position), [spec.width, spec.height, spec.thickness], rot.y));
    return el;
  }

  /** Run `f`, adding its wall-clock time to `timings[key]`. */
  time<T>(key: string, f: () => T): T {
    const t0 = performance.now();
    const r = f();
    this.timings[key] = (this.timings[key] ?? 0) + performance.now() - t0;
    return r;
  }

  boxOf(el: Destructible): THREE.Box3 {
    return this.boxes.get(el) ?? el.bounds;
  }

  // ── Supports ──────────────────────────────────────────────────────────────────────────────

  /** Stands on the ground over its whole footprint (permanent). */
  ground(el: Destructible, band = 0.05): string {
    const b = this.boxOf(el);
    return this.time('links', () => this.ctx.structure.link('ground', el, new THREE.Box3(new THREE.Vector3(b.min.x, b.min.y - band, b.min.z), new THREE.Vector3(b.max.x, b.min.y + band, b.max.z))));
  }

  /**
   * `el` rests on top of `sup`: the contact is the plan overlap of the two boxes, a thin band
   * around the bearing plane. Throws when they do not touch (a scene layout error).
   */
  on(sup: Destructible, el: Destructible, band = 0.05): string {
    const a = this.boxOf(sup), b = this.boxOf(el);
    const y = b.min.y;
    if (Math.abs(a.max.y - y) > 0.06) throw new Error(`${el.name} does not rest on ${sup.name} (${a.max.y.toFixed(3)} vs ${y.toFixed(3)})`);
    const r = new THREE.Box3(
      new THREE.Vector3(Math.max(a.min.x, b.min.x), y - band, Math.max(a.min.z, b.min.z)),
      new THREE.Vector3(Math.min(a.max.x, b.max.x), y + band, Math.min(a.max.z, b.max.z)),
    );
    if (r.min.x > r.max.x || r.min.z > r.max.z) throw new Error(`${el.name} and ${sup.name} do not overlap in plan`);
    return this.time('links', () => this.ctx.structure.link(sup, el, r));
  }

  /** Lateral restraint: `el` is tied to the side of `sup` where their boxes touch. */
  side(sup: Destructible, el: Destructible, grow = 0.04): string {
    const a = this.boxOf(sup).clone().expandByScalar(grow), b = this.boxOf(el).clone().expandByScalar(grow);
    const r = a.intersect(b);
    if (r.isEmpty()) throw new Error(`${el.name} does not touch ${sup.name}`);
    return this.time('links', () => this.ctx.structure.link(sup, el, r));
  }

  /** Explicit contact region. */
  at(sup: Destructible | 'ground', el: Destructible, region: THREE.Box3): string {
    return this.time('links', () => this.ctx.structure.link(sup, el, region));
  }

  /** Extra dead load the graph cannot see (finishes, services, a test rig), N. */
  load(el: Destructible, newtons: number): void {
    setExternalLoad(this.ctx, el, newtons);
  }
}

/** Axis-aligned box around a point: centre (x, z), half size r in plan, y from y0 to y1. */
export function region(x: number, z: number, r: number, y0: number, y1: number): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(x - r, y0, z - r), new THREE.Vector3(x + r, y1, z + r));
}

/** World AABB of a box of full size `size` centred at `at`, rotated by `rotY` about the vertical. */
export function orientedBox(at: V3, size: V3, rotY: number): THREE.Box3 {
  const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
  const hx = (size[0] * c + size[2] * s) / 2, hz = (size[0] * s + size[2] * c) / 2, hy = size[1] / 2;
  return new THREE.Box3(new THREE.Vector3(at[0] - hx, at[1] - hy, at[2] - hz), new THREE.Vector3(at[0] + hx, at[1] + hy, at[2] + hz));
}

function profileRadius(p: BeamProfile): number {
  switch (p.type) {
    case 'I':
      return Math.max(p.h, p.b) / 2;
    case 'cruciform':
      return p.arm;
    case 'tube':
      return p.d / 2;
    case 'box':
      return Math.max(p.h, p.b) / 2;
  }
}

function vec(v: V3 | THREE.Vector3): THREE.Vector3 {
  return Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2]) : v.clone();
}
function arr(v: V3 | THREE.Vector3): V3 {
  return Array.isArray(v) ? v : [v.x, v.y, v.z];
}
