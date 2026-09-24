import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SimContext } from '../../app/contracts.ts';
import { allocateDestructibleId, type Destructible, type RayHit } from '../Destructible.ts';
import { MATERIALS, type MaterialProps } from '../../physics/materials.ts';
import { GROUPS_STATIC, type PhysicsOwner } from '../../physics/PhysicsWorld.ts';
import type { BlastLoad, ImpactEvent, ThicknessProbe } from '../../physics/ballistics/types.ts';
import { fireballRadius } from '../../physics/ballistics/blast.ts';
import { Noise3 } from '../../core/noise.ts';
import { Heightfield } from './heightfield.ts';
import { blastCrater, craterProfile, rimWobbleTable, wobbleAt, type CraterShape } from './crater.ts';
import { createGroundMaterial, type PlazaFinish } from './material.ts';
import { createGroundNoise, createPockAtlas } from './textures.ts';
import { PockDecals } from './pocks.ts';
import { RELIEF_DEEP, RELIEF_SPAN } from './relief.ts';
import { setGroundProvider, type GroundProvider } from '../../fx/ground.ts';

export interface TerrainOptions {
  /** Total side length of the walkable ground, m (default 600) */
  size?: number;
  /** Cell size of the detailed height field, m (default 0.25) */
  resolution?: number;
  /** Side length of the detailed (deformable) region around the origin, m (default 160) */
  detail?: number;
  plaza?: { halfX: number; halfZ: number; finish: PlazaFinish };
}

/** Paving build-ups: surface material and thickness of the wearing course. */
const PAVING: Record<PlazaFinish, { material: MaterialProps; thickness: number; dust: number }> = {
  pavers: { material: MATERIALS.granite, thickness: 0.08, dust: 0xb9b2a6 },
  travertine: { material: MATERIALS.travertine, thickness: 0.04, dust: 0xe0d5bf },
  concrete: { material: MATERIALS.concrete, thickness: 0.15, dust: 0xc4c0b8 },
};
const SOIL_DUST = 0x9a8466;
const GRASS_DUST = 0x8f7f63;
/** Detailed-mesh tile edge, in cells */
const TILE = 64;
/** Splat texture resolution over the detailed region */
const SPLAT = 2048;
const SPLAT_SOOT = 0, SPLAT_SOIL = 1, SPLAT_PAVING = 2, SPLAT_RELIEF = 3;
const RELIEF_ZERO = Math.round((RELIEF_DEEP / RELIEF_SPAN) * 255);

/** Per-frame time budget for deferred splat painting, ms */
const PAINT_BUDGET_MS = 1.5;

interface PaintJob {
  cx: number;
  cz: number;
  radius: number;
  ch: number;
  value: (r: number, angle: number) => number;
  accumulate: boolean;
  x0: number;
  x1: number;
  /** Next row to paint */
  y: number;
  y1: number;
  edge: Float32Array;
}

const _v = new THREE.Vector3();
const _nv = new THREE.Vector3();
const _n: number[] = [0, 1, 0];

interface Tile {
  i0: number;
  j0: number;
  mesh: THREE.Mesh;
  collider: RAPIER.Collider | null;
  dirty: boolean;
  /** Index buffer level currently bound (0 = full resolution) */
  lod: number;
  /** Has been cratered: keep it finer at distance */
  scarred: boolean;
}

/** Render LOD steps (cells per quad) and the camera distance up to which each is used, m. */
const LOD_STEPS = [1, 2, 4, 8];
const LOD_RANGE = [28, 55, 110, Infinity];
/**
 * Vertical skirt hung below every tile edge, m (plus half the tile's relief). Neighbouring tiles at
 * different LODs meet in T-junctions, which leave pixel cracks (sky specks at grazing angles) even
 * where the heights agree; the skirt fills them from below.
 */
const SKIRT = 0.3;
/** Vertices of one tile: the (TILE+1)² grid, then one row of skirt vertices per edge. */
const GRID_VERTS = (TILE + 1) * (TILE + 1);
const TILE_VERTS = GRID_VERTS + 4 * (TILE + 1);

/** Grid index of the k-th vertex along tile edge e (0: j = 0, 1: j = TILE, 2: i = 0, 3: i = TILE). */
function edgeVertex(e: number, k: number): number {
  const s = TILE + 1;
  return e === 0 ? k : e === 1 ? TILE * s + k : e === 2 ? k * s : k * s + TILE;
}

/**
 * The ground: a large field (default 600 m) whose central part (default 160 × 160 m) is a
 * deformable height field at 0.25 m, rendered as tiles with a procedural plaza / grass shader and
 * collided through per-tile Rapier height fields. Blasts dig craters with lips and ejecta, shatter
 * the paving and leave soot; heavy rounds dig pocks; small arms leave chipped pock decals.
 */
export class Terrain implements Destructible {
  readonly id = allocateDestructibleId();
  readonly kind = 'terrain' as const;
  readonly name = 'ground';
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  disposed = false;

  readonly field: Heightfield;
  readonly size: number;
  readonly detail: number;
  readonly plaza: TerrainOptions['plaza'] | null;
  private ctx: SimContext;
  private owner: PhysicsOwner;
  private body: RAPIER.RigidBody | null = null;
  private outer: RAPIER.Collider[] = [];
  private tiles: Tile[] = [];
  private tilesPerSide: number;
  /** One shared index buffer per LOD step (identical tile topology) */
  private indices: THREE.BufferAttribute[] = [];
  private material: THREE.MeshStandardMaterial;
  private far: THREE.Mesh;
  private noiseTex: THREE.DataTexture;
  private splatData: Uint8Array;
  private splat: THREE.DataTexture;
  private splatDirty: { x0: number; x1: number; y0: number; y1: number } | null = null;
  private paintJobs: PaintJob[] = [];
  private pocks: PockDecals;
  private pockAtlas: THREE.DataTexture;
  private noise = new Noise3(4242);
  private craters = 0;
  private physicsWorld: RAPIER.World | null = null;
  private hidden: THREE.Object3D[] = [];

  constructor(ctx: SimContext, opts: TerrainOptions = {}) {
    this.ctx = ctx;
    this.size = opts.size ?? 600;
    const res = opts.resolution ?? 0.25;
    this.detail = Math.min(opts.detail ?? 160, this.size);
    this.plaza = opts.plaza ?? null;
    this.root.name = 'terrain';
    this.owner = { kind: 'terrain', material: MATERIALS.soil, destructible: this };

    // Detailed field: flat under the plaza, gentle swales (±0.25 m) beyond, back to 0 at the edge
    // so it meets the flat far field without a seam.
    const half = this.detail / 2;
    const pl = this.plaza;
    this.field = new Heightfield(this.detail, res, (x, z) => {
      const dPl = pl ? Math.max(Math.abs(x) - pl.halfX, Math.abs(z) - pl.halfZ) : Math.hypot(x, z) - 8;
      const inner = smooth01((dPl - 1.5) / 14);
      const edge = 1 - smooth01((Math.max(Math.abs(x), Math.abs(z)) - (half - 14)) / 12);
      const n = this.noise.fbm(x * 0.018, 0.3, z * 0.018, 3) * 0.22 + this.noise.noise3(x * 0.07, 1.7, z * 0.07) * 0.04;
      return n * inner * edge;
    });
    // Tiles share their index buffers (identical topology). Coarser levels skip vertices; the
    // vertex normals still come from the full-resolution grid, the gentle swales deviate < 1 mm
    // between levels, and edge skirts close the T-junction cracks where levels meet.
    this.tilesPerSide = Math.ceil(this.field.n / TILE);
    const s = TILE + 1;
    for (const step of LOD_STEPS) {
      const idx: number[] = [];
      for (let j = 0; j < TILE; j += step) {
        for (let i = 0; i < TILE; i += step) {
          const a = j * s + i, b = a + step, c = a + step * s, d = c + step;
          // Same diagonal as Heightfield / Rapier: (i,j)–(i+1,j+1). Counter-clockwise seen from +Y.
          idx.push(a, d, b, a, c, d);
        }
      }
      // Skirts, both windings (a crack can be seen from either side of the edge).
      for (let e = 0; e < 4; e++) {
        for (let k = 0; k < TILE; k += step) {
          const a = edgeVertex(e, k), b = edgeVertex(e, k + step);
          const sa = GRID_VERTS + e * s + k, sb = sa + step;
          idx.push(a, b, sb, a, sb, sa, a, sb, b, a, sa, sb);
        }
      }
      this.indices.push(new THREE.BufferAttribute(new Uint16Array(idx), 1));
    }

    this.noiseTex = createGroundNoise(256);
    this.splatData = new Uint8Array(SPLAT * SPLAT * 4);
    for (let i = SPLAT_RELIEF; i < this.splatData.length; i += 4) this.splatData[i] = RELIEF_ZERO;
    this.splat = new THREE.DataTexture(this.splatData, SPLAT, SPLAT, THREE.RGBAFormat);
    this.splat.generateMipmaps = true;
    this.splat.minFilter = THREE.LinearMipmapLinearFilter;
    this.splat.magFilter = THREE.LinearFilter;
    this.splat.colorSpace = THREE.NoColorSpace;
    this.splat.needsUpdate = true;
    this.material = createGroundMaterial({
      noise: this.noiseTex,
      splat: this.splat,
      splatRect: [this.field.x0, this.field.z0, this.detail],
      plaza: this.plaza,
    });

    for (let tj = 0; tj < this.tilesPerSide; tj++) {
      for (let ti = 0; ti < this.tilesPerSide; ti++) {
        const mesh = new THREE.Mesh(this.buildTileGeometry(ti * TILE, tj * TILE), this.material);
        mesh.name = `terrain-tile-${ti}-${tj}`;
        mesh.receiveShadow = true;
        // Only ground where things stand (the plaza) or that has been cratered casts sun shadows:
        // it closes the PCF light leak along wall bases and lets crater lips shade their bowls,
        // while the open field (most of the triangles) stays out of the shadow passes.
        mesh.castShadow = this.tileNearPlaza(ti * TILE, tj * TILE);
        this.root.add(mesh);
        this.tiles.push({ i0: ti * TILE, j0: tj * TILE, mesh, collider: null, dirty: false, lod: 0, scarred: false });
      }
    }
    // The ring reaches 2 m under the detailed field (just below it) so the long shared edge can
    // never open pixel cracks (T-junctions against the 0.25 m grid).
    this.far = new THREE.Mesh(farRing(half - 2, 2000), this.material);
    this.far.position.y = -0.08;
    this.far.name = 'terrain-far';
    this.far.receiveShadow = true;
    this.far.castShadow = false;
    this.root.add(this.far);

    this.pockAtlas = createPockAtlas();
    this.pocks = new PockDecals(this.pockAtlas, 1536);
    this.root.add(this.pocks.mesh);

    this.updateBounds();
    this.buildPhysics();
    this.hideDefaultGround();
    setGroundProvider(ctx.scene, this.provider);
  }

  // ─── Ground provider (effects query the surface they land on) ─────────────────────────────

  private provider: GroundProvider = {
    heightAt: (x, z) => this.heightAt(x, z),
    dustColorAt: (x, z) => this.dustColorAt(x, z),
    materialAt: (x, z) => this.surfaceMaterial(x, z),
  };

  heightAt(x: number, z: number): number {
    return this.field.contains(x, z) ? this.field.heightAt(x, z) : 0;
  }

  private heightFn = (x: number, z: number): number => this.heightAt(x, z);
  private normalFn = (x: number, z: number, out: number[]): number[] => this.field.normalAt(x, z, out);

  private onPlaza(x: number, z: number): boolean {
    const p = this.plaza;
    return !!p && Math.abs(x) <= p.halfX && Math.abs(z) <= p.halfZ;
  }

  private splatAt(x: number, z: number, ch: number): number {
    const u = (x - this.field.x0) / this.detail, v = (z - this.field.z0) / this.detail;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return 0;
    const px = Math.floor(u * SPLAT), py = Math.floor(v * SPLAT);
    return this.splatData[(py * SPLAT + px) * 4 + ch]! / 255;
  }

  /** Material of the wearing surface at (x, z): paving (until shattered) or soil. */
  surfaceMaterial(x: number, z: number): MaterialProps {
    if (this.plaza && this.onPlaza(x, z) && this.splatAt(x, z, SPLAT_PAVING) < 0.75) return PAVING[this.plaza.finish].material;
    return MATERIALS.soil;
  }

  dustColorAt(x: number, z: number): number {
    if (this.plaza && this.onPlaza(x, z) && this.splatAt(x, z, SPLAT_PAVING) < 0.75) return PAVING[this.plaza.finish].dust;
    return this.splatAt(x, z, SPLAT_SOIL) > 0.3 ? SOIL_DUST : GRASS_DUST;
  }

  // ─── Destructible ────────────────────────────────────────────────────────────────────────

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    const f = this.field;
    // Most bullet segments are well above the ground: reject them in O(1).
    const endY = origin.y + dir.y * maxDist;
    if (Math.min(origin.y, endY) > Math.max(f.maxH, 0) + 1e-3) return null;
    let t = f.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist);
    let nx = 0, ny = 1, nz = 0;
    if (t >= 0) {
      const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
      f.normalAt(px, pz, _n);
      nx = _n[0]!; ny = _n[1]!; nz = _n[2]!;
    } else if (dir.y < -1e-9 && origin.y >= 0) {
      // Flat far field (y = 0) outside the detailed square, inside the ground extent.
      const tp = -origin.y / dir.y;
      const px = origin.x + dir.x * tp, pz = origin.z + dir.z * tp;
      const h = this.size / 2;
      if (tp <= maxDist && Math.abs(px) <= h && Math.abs(pz) <= h && !f.contains(px, pz)) t = tp;
    }
    if (t < 0) return null;
    const point = new THREE.Vector3().copy(dir).multiplyScalar(t).add(origin);
    const normal = new THREE.Vector3(nx, ny, nz);
    if (normal.dot(dir) > 0) normal.negate();
    return { target: this, point, normal, distance: t, material: this.surfaceMaterial(point.x, point.z) };
  }

  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    const cosI = Math.max(0.05, Math.abs(dir.dot(hit.normal)));
    const segments: ThicknessProbe['segments'] = [];
    let start = 0;
    if (this.plaza && hit.material !== MATERIALS.soil) {
      const pav = PAVING[this.plaza.finish];
      const run = Math.min(maxDepth, pav.thickness / cosI);
      segments.push({ material: pav.material, start: 0, end: run, strength: 1 });
      start = run;
    }
    // Compacted soil below: a deep run (projectiles never perforate the ground).
    if (start < maxDepth) segments.push({ material: MATERIALS.soil, start, end: maxDepth, strength: 1 });
    return { segments, exits: false };
  }

  applyImpact(e: ImpactEvent): void {
    if (e.outcome === 'ricochet' && e.craterRadius < 0.01) {
      this.pocks.add(e.point, e.normal, Math.max(0.012, e.ammo.diameter * 1.5), e.material.class === 'soil' ? 1 : 0, this.ctx.rng.next());
      return;
    }
    const soilHit = e.material.class === 'soil';
    const r = Math.max(e.craterRadius, e.ammo.diameter * 1.2, 0.01);
    const p = e.point;
    // Cannon and heavier: the pock is big enough for the height field (≥ 0.6 cell). Dig first so
    // the mark lands on the new surface (the floor of the pock) rather than hovering over it.
    if (r >= 0.6 * this.field.cell && this.field.contains(p.x, p.z)) {
      const depth = Math.min(Math.max(e.craterDepth, 0.4 * r), 1.2 * r);
      const c: CraterShape = { radius: r, depth, lipHeight: 0.15 * depth, ejectaRadius: 2.2 * r, pavingRadius: soilHit ? 0 : 1.3 * r };
      this.dig(p.x, p.z, c, 0.15);
      this.field.normalAt(p.x, p.z, _n);
      _v.set(p.x, this.field.heightAt(p.x, p.z), p.z);
      _nv.set(_n[0]!, _n[1]!, _n[2]!);
      this.pocks.add(_v, _nv, r * (soilHit ? 1.6 : 1.25), soilHit ? 1 : 0, this.ctx.rng.next());
      return;
    }
    this.pocks.add(p, e.normal, r * (soilHit ? 1.6 : 1.25), soilHit ? 1 : 0, this.ctx.rng.next());
  }

  applyBlast(load: BlastLoad): void {
    const cx = load.center.x, cz = load.center.z;
    const ground = this.heightAt(cx, cz);
    const hob = load.center.y - ground;
    const W = load.tntKg;
    if (!(W > 0)) return;
    const thermo = load.kind === 'thermobaric';
    // Fireball footprint on the ground (the ballistics module's fireball radius, ≈ 1.75 W^⅓ after
    // Baker et al. 1983, larger for thermobaric fills) — soot where it touched.
    const Rf = fireballRadius(W, thermo);
    if (hob < Rf) {
      const rs = Math.sqrt(Math.max(0, Rf * Rf - Math.max(0, hob) ** 2));
      this.paintScorch(cx, cz, rs * 0.85, 0.75 * Math.min(1, 1.2 - hob / Rf));
    }
    const contact = load.contactTargetId === this.id || hob < 0.6 * Math.cbrt(W);
    if (!contact || !this.field.contains(cx, cz)) return;
    const cd = load.contactDamage(MATERIALS.soil, 10);
    let pavingBreach = 0;
    if (this.plaza && this.onPlaza(cx, cz)) {
      const pav = PAVING[this.plaza.finish];
      const pd = load.contactDamage(pav.material, pav.thickness);
      pavingBreach = pd.breach ? pd.breachRadius : pd.craterRadius;
    }
    const crater = blastCrater(cd.craterRadius, cd.craterDepth, hob, W, pavingBreach * 1.1);
    if (crater.radius < 0.05) return;
    this.dig(cx, cz, crater, 1);
  }

  /** Excavate a crater, paint its splat and refresh meshes / colliders / resting bodies. */
  private dig(cx: number, cz: number, c: CraterShape, sootAmount: number): void {
    const seed = ++this.craters * 7.31;
    const ref = this.field.heightAt(cx, cz);
    const reach = Math.max(c.ejectaRadius, c.radius * 1.6);
    const rim = rimWobbleTable(seed);
    // The mesh gets the lip widened to at least ~1.3 cells (same cross-section): a ridge narrower
    // than the grid aliases into isolated spikes. The splat relief keeps the true profile.
    const minLip = 1.3 * this.field.cell;
    const range = this.field.stamp(cx, cz, reach, (r, a) => craterProfile(c, r, wobbleAt(rim, a), minLip), ref);
    if (range) this.markDirty(range.i0, range.i1, range.j0, range.j1);
    this.paintRelief(cx, cz, reach, c, rim);
    // Marks inside the crater went with the ground; the rest now sit on the lip and ejecta.
    this.pocks.conform(cx, cz, reach, Math.max(c.radius * 1.05, c.pavingRadius * 0.8), this.heightFn, this.normalFn);
    // Splat: soil cover inside the ejecta blanket, shattered paving, soot at the seat.
    this.paintDisc(cx, cz, c.ejectaRadius, SPLAT_SOIL, (r) => (r < c.radius * 1.05 ? 1 : Math.pow(Math.max(0, 1 - (r - c.radius) / (c.ejectaRadius - c.radius + 1e-6)), 1.6) * 0.9), seed);
    if (this.plaza && c.pavingRadius > 0) {
      this.paintDisc(cx, cz, c.pavingRadius * 1.8, SPLAT_PAVING, (r) => (r < c.pavingRadius ? 1 : 0.7 * Math.max(0, 1 - (r - c.pavingRadius) / (0.8 * c.pavingRadius))), seed + 1, false, true);
    }
    if (sootAmount > 0) this.paintScorch(cx, cz, c.radius * 1.4, 0.35 * sootAmount);
    for (const b of this.ctx.physics.bodiesInSphere(_v.set(cx, ref, cz), reach + 1)) b.wakeUp();
  }

  /** Sub-grid crater relief for shading (same profile as the height field, at splat resolution). */
  private paintRelief(cx: number, cz: number, reach: number, c: CraterShape, rim: Float32Array): void {
    const f = this.field;
    const scale = SPLAT / this.detail;
    const x0 = Math.max(0, Math.floor((cx - reach - f.x0) * scale)), x1 = Math.min(SPLAT - 1, Math.ceil((cx + reach - f.x0) * scale));
    const y0 = Math.max(0, Math.floor((cz - reach - f.z0) * scale)), y1 = Math.min(SPLAT - 1, Math.ceil((cz + reach - f.z0) * scale));
    if (x0 > x1 || y0 > y1) return;
    const d = this.splatData;
    const code = (m: number) => Math.max(0, Math.min(255, Math.round(((m + RELIEF_DEEP) / RELIEF_SPAN) * 255)));
    const decode = (v: number) => (v / 255) * RELIEF_SPAN - RELIEF_DEEP;
    const kc = (Math.min(SPLAT - 1, Math.max(0, Math.floor((cz - f.z0) * scale))) * SPLAT + Math.min(SPLAT - 1, Math.max(0, Math.floor((cx - f.x0) * scale)))) * 4 + SPLAT_RELIEF;
    const ref = decode(d[kc]!);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const wx = f.x0 + (x + 0.5) / scale - cx, wz = f.z0 + (y + 0.5) / scale - cz;
        const r = Math.hypot(wx, wz);
        if (r > reach) continue;
        const p = craterProfile(c, r, wobbleAt(rim, Math.atan2(wz, wx)));
        const k = (y * SPLAT + x) * 4 + SPLAT_RELIEF;
        let h = decode(d[k]!);
        if (Number.isFinite(p.cut)) h = Math.min(h, ref + p.cut);
        d[k] = code(h + p.add);
      }
    }
    this.markSplat(x0, x1, y0, y1);
  }

  private markSplat(x0: number, x1: number, y0: number, y1: number): void {
    const dirty = this.splatDirty;
    this.splatDirty = dirty
      ? { x0: Math.min(dirty.x0, x0), x1: Math.max(dirty.x1, x1), y0: Math.min(dirty.y0, y0), y1: Math.max(dirty.y1, y1) }
      : { x0, x1, y0, y1 };
  }

  /** Soot with radial streaks (blast products sweep outward along the ground). */
  private paintScorch(cx: number, cz: number, radius: number, strength: number): void {
    const seed = this.craters * 3.7 + cx * 0.13;
    this.paintDisc(cx, cz, radius * 1.3, SPLAT_SOOT, (r, a) => {
      const streak = 0.65 + 0.35 * Math.sin(a * 23 + seed) * Math.sin(a * 9.3 + 2 * seed);
      const fall = Math.max(0, 1 - Math.pow(r / (radius * (0.85 + 0.25 * streak)), 1.5));
      return strength * fall * (0.7 + 0.3 * streak);
    }, seed, true);
  }

  /**
   * Paint a radial value into one splat channel. Visual-only channels are queued and painted a few
   * rows at a time within a per-frame budget (a 20 kg fireball's soot covers ~25 k texels); the
   * paving channel feeds `probe()` / `surfaceMaterial()` and is painted at once.
   */
  private paintDisc(cx: number, cz: number, radius: number, ch: number, value: (r: number, angle: number) => number, seed: number, accumulate = false, immediate = false): void {
    const f = this.field;
    const scale = SPLAT / this.detail;
    const x0 = Math.max(0, Math.floor((cx - radius - f.x0) * scale));
    const x1 = Math.min(SPLAT - 1, Math.ceil((cx + radius - f.x0) * scale));
    const y0 = Math.max(0, Math.floor((cz - radius - f.z0) * scale));
    const y1 = Math.min(SPLAT - 1, Math.ceil((cz + radius - f.z0) * scale));
    if (x0 > x1 || y0 > y1) return;
    // Ragged edge: the radius is perturbed by an angular wobble (stronger towards the rim).
    const job: PaintJob = { cx, cz, radius, ch, value, accumulate, x0, x1, y: y0, y1, edge: rimWobbleTable(seed * 1.7 + 0.3, 128) };
    if (immediate) this.runPaint(job, Infinity);
    else this.paintJobs.push(job);
  }

  /** Paint rows of a job until it is done or the deadline (performance.now() ms) passes. */
  private runPaint(job: PaintJob, deadline: number): boolean {
    const f = this.field;
    const scale = SPLAT / this.detail;
    const d = this.splatData;
    const inv = 1 / Math.max(job.radius, 1e-3);
    const yStart = job.y;
    while (job.y <= job.y1) {
      const y = job.y++;
      const wz = f.z0 + (y + 0.5) / scale - job.cz;
      for (let x = job.x0; x <= job.x1; x++) {
        const wx = f.x0 + (x + 0.5) / scale - job.cx;
        const r = Math.hypot(wx, wz);
        if (r > job.radius) continue;
        const a = Math.atan2(wz, wx);
        const edge = wobbleAt(job.edge, a) * 0.16;
        const v = Math.max(0, Math.min(1, job.value(r * (1 + edge * r * inv), a)));
        const k = (y * SPLAT + x) * 4 + job.ch;
        const cur = d[k]! / 255;
        const nv = job.accumulate ? 1 - (1 - cur) * (1 - v) : Math.max(cur, v);
        d[k] = Math.round(nv * 255);
      }
      if ((y & 7) === 7 && performance.now() > deadline) break;
    }
    this.markSplat(job.x0, job.x1, yStart, job.y - 1);
    return job.y > job.y1;
  }

  /** Work through queued splat painting for at most `budgetMs`. */
  private flushPaint(budgetMs: number): void {
    if (this.paintJobs.length === 0) return;
    const deadline = performance.now() + budgetMs;
    while (this.paintJobs.length > 0) {
      if (!this.runPaint(this.paintJobs[0]!, deadline)) break;
      this.paintJobs.shift();
      if (performance.now() > deadline) break;
    }
  }

  /** Pick each tile's index buffer from its distance to the camera. */
  private updateLod(): void {
    const cam = this.ctx.camera.position;
    const f = this.field;
    const span = TILE * f.cell;
    for (const t of this.tiles) {
      const cx = f.x0 + t.i0 * f.cell + span / 2, cz = f.z0 + t.j0 * f.cell + span / 2;
      const dx = Math.max(0, Math.abs(cam.x - cx) - span / 2), dz = Math.max(0, Math.abs(cam.z - cz) - span / 2);
      const d = Math.hypot(dx, dz, cam.y);
      let lod = 0;
      while (lod < LOD_RANGE.length - 1 && d > LOD_RANGE[lod]!) lod++;
      // Cratered tiles keep their full detail wherever the crater can still be resolved.
      if (t.scarred) lod = d > LOD_RANGE[2]! ? Math.min(lod, 1) : 0;
      if (lod !== t.lod) {
        t.lod = lod;
        t.mesh.geometry.setIndex(this.indices[lod]!);
      }
    }
  }

  frameUpdate(): void {
    this.updateLod();
    this.flushPaint(PAINT_BUDGET_MS);
    if (this.splatDirty) {
      const { y0, y1, x0, x1 } = this.splatDirty;
      // three uploads each update range as a single row (texSubImage2D height 1): one per row.
      for (let y = y0; y <= y1; y++) this.splat.addUpdateRange((y * SPLAT + x0) * 4, (x1 - x0 + 1) * 4);
      this.splat.needsUpdate = true;
      this.splatDirty = null;
    }
    this.flushTiles();
  }

  fixedUpdate(): void {
    // Colliders must follow the craters before the next physics step (debris rests in them).
    this.flushTiles();
    // A scene load replaces the Rapier world: rebuild our bodies in the new one.
    if (this.physicsWorld !== this.ctx.physics.world) this.buildPhysics();
  }

  // ─── Meshes and physics ──────────────────────────────────────────────────────────────────

  private markDirty(i0: number, i1: number, j0: number, j1: number): void {
    const t0 = Math.max(0, Math.floor((i0 - 1) / TILE)), t1 = Math.min(this.tilesPerSide - 1, Math.floor((i1 + 1) / TILE));
    const u0 = Math.max(0, Math.floor((j0 - 1) / TILE)), u1 = Math.min(this.tilesPerSide - 1, Math.floor((j1 + 1) / TILE));
    for (let tj = u0; tj <= u1; tj++) for (let ti = t0; ti <= t1; ti++) this.tiles[tj * this.tilesPerSide + ti]!.dirty = true;
  }

  private flushTiles(): void {
    let any = false;
    for (const t of this.tiles) {
      if (!t.dirty) continue;
      t.dirty = false;
      any = true;
      this.writeTileAttributes(t.mesh.geometry, t.i0, t.j0);
      this.rebuildCollider(t);
      t.mesh.castShadow = true;
      t.scarred = true;
    }
    if (any) this.updateBounds();
  }

  private tileNearPlaza(i0: number, j0: number): boolean {
    const p = this.plaza;
    const f = this.field;
    const x0 = f.x0 + i0 * f.cell, z0 = f.z0 + j0 * f.cell, x1 = x0 + TILE * f.cell, z1 = z0 + TILE * f.cell;
    const hx = p ? p.halfX + 3 : 10, hz = p ? p.halfZ + 3 : 10;
    return x1 >= -hx && x0 <= hx && z1 >= -hz && z0 <= hz;
  }

  private buildTileGeometry(i0: number, j0: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TILE_VERTS * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(TILE_VERTS * 3), 3));
    g.setIndex(this.indices[0]!);
    this.writeTileAttributes(g, i0, j0);
    return g;
  }

  private writeTileAttributes(g: THREE.BufferGeometry, i0: number, j0: number): void {
    const f = this.field;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const P = pos.array as Float32Array, N = nor.array as Float32Array;
    const c = f.cell, m = f.n;
    let k = 0;
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j <= TILE; j++) {
      const gj = Math.min(j0 + j, m);
      for (let i = 0; i <= TILE; i++) {
        const gi = Math.min(i0 + i, m);
        const h = f.vertex(gi, gj);
        P[k] = f.x0 + gi * c;
        P[k + 1] = h;
        P[k + 2] = f.z0 + gj * c;
        // Central differences on the grid (one-sided at the edge).
        const hl = f.vertex(Math.max(gi - 1, 0), gj), hr = f.vertex(Math.min(gi + 1, m), gj);
        const hd = f.vertex(gi, Math.max(gj - 1, 0)), hu = f.vertex(gi, Math.min(gj + 1, m));
        const dx = (hr - hl) / (c * (Math.min(gi + 1, m) - Math.max(gi - 1, 0)));
        const dz = (hu - hd) / (c * (Math.min(gj + 1, m) - Math.max(gj - 1, 0)));
        const l = Math.hypot(dx, 1, dz);
        N[k] = -dx / l;
        N[k + 1] = 1 / l;
        N[k + 2] = -dz / l;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
        k += 3;
      }
    }
    // Skirt: a copy of each edge vertex lowered by the skirt depth, with the edge's normal so its
    // (rarely visible) sliver shades like the surface above it. Deeper where the tile has relief
    // (a crater crossing the edge can differ more between LOD levels).
    const drop = SKIRT + 0.5 * (hi - lo);
    for (let e = 0; e < 4; e++) {
      for (let q = 0; q <= TILE; q++) {
        const src = edgeVertex(e, q) * 3;
        const dst = (GRID_VERTS + e * (TILE + 1) + q) * 3;
        P[dst] = P[src]!;
        P[dst + 1] = P[src + 1]! - drop;
        P[dst + 2] = P[src + 2]!;
        N[dst] = N[src]!;
        N[dst + 1] = N[src + 1]!;
        N[dst + 2] = N[src + 2]!;
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    const x0 = f.x0 + i0 * c, z0 = f.z0 + j0 * c;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, lo - drop, z0), new THREE.Vector3(x0 + TILE * c, hi, z0 + TILE * c));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  }

  private buildPhysics(): void {
    const phys = this.ctx.physics;
    this.physicsWorld = phys.world;
    phys.removeDefaultGround();
    this.body = phys.createFixed(new THREE.Vector3(), undefined, [], this.owner);
    for (const t of this.tiles) {
      t.collider = null;
      this.rebuildCollider(t);
    }
    // Flat ground around the detailed square (four slabs, top at y = 0).
    const h = this.size / 2, d = this.detail / 2, th = 2;
    const R = phys.R;
    const slabs: [number, number, number, number][] = [
      [0, -(h + d) / 2, h, (h - d) / 2],
      [0, (h + d) / 2, h, (h - d) / 2],
      [-(h + d) / 2, 0, (h - d) / 2, d],
      [(h + d) / 2, 0, (h - d) / 2, d],
    ];
    this.outer = [];
    for (const [x, z, hx, hz] of slabs) {
      if (hx <= 0 || hz <= 0) continue;
      const cd = R.ColliderDesc.cuboid(hx, th, hz).setTranslation(x, -th, z).setFriction(0.9);
      this.outer.push(phys.attachCollider(this.body, cd.setCollisionGroups(GROUPS_STATIC), this.owner));
    }
  }

  private rebuildCollider(t: Tile): void {
    const phys = this.ctx.physics;
    if (!this.body || this.physicsWorld !== phys.world) return;
    if (t.collider) phys.removeCollider(t.collider);
    const f = this.field;
    const m = TILE + 1;
    const heights = new Float32Array(m * m);
    // Rapier: column-major (nrows+1)×(ncols+1), rows along z, columns along x, centred on the collider.
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) heights[j + i * m] = f.vertex(Math.min(t.i0 + i, f.n), Math.min(t.j0 + j, f.n));
    }
    const span = TILE * f.cell;
    const cx = f.x0 + t.i0 * f.cell + span / 2, cz = f.z0 + t.j0 * f.cell + span / 2;
    const R = phys.R;
    const cd = R.ColliderDesc.heightfield(TILE, TILE, heights, { x: span, y: 1, z: span }, R.HeightFieldFlags.FIX_INTERNAL_EDGES)
      .setTranslation(cx, 0, cz)
      .setFriction(0.9)
      .setCollisionGroups(GROUPS_STATIC);
    t.collider = phys.attachCollider(this.body, cd, this.owner);
  }

  private updateBounds(): void {
    const h = this.size / 2;
    this.bounds.min.set(-h, Math.min(this.field.minH, 0) - 0.5, -h);
    this.bounds.max.set(h, Math.max(this.field.maxH, 0) + 0.5, h);
  }

  private hideDefaultGround(): void {
    this.ctx.scene.traverse((o) => {
      if (o.name === 'basic-ground' && o.visible) {
        o.visible = false;
        this.hidden.push(o);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const phys = this.ctx.physics;
    if (this.body && this.physicsWorld === phys.world) phys.removeBody(this.body);
    this.body = null;
    // Spread the shared LOD index buffers over the tiles first, so disposing the geometries frees
    // every index buffer the renderer uploaded, not only the ones bound right now.
    this.tiles.forEach((t, i) => t.mesh.geometry.setIndex(this.indices[i % this.indices.length]!));
    for (const t of this.tiles) t.mesh.geometry.dispose();
    this.far.geometry.dispose();
    this.material.dispose();
    this.noiseTex.dispose();
    this.splat.dispose();
    this.pocks.dispose();
    this.pockAtlas.dispose();
    this.root.removeFromParent();
    for (const o of this.hidden) o.visible = true;
    setGroundProvider(this.ctx.scene, null);
  }
}

function smooth01(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** Flat square ring from the detailed square's edge (half-size `a`) out to `b`, at y = 0. */
function farRing(a: number, b: number): THREE.BufferGeometry {
  // Inner ring vertices sit exactly on the detailed field's border (height 0 there).
  const pts = [
    [-a, -a], [a, -a], [a, a], [-a, a],
    [-b, -b], [b, -b], [b, b], [-b, b],
  ];
  const pos = new Float32Array(pts.length * 3);
  pts.forEach(([x, z], k) => {
    pos[k * 3] = x!;
    pos[k * 3 + 1] = 0;
    pos[k * 3 + 2] = z!;
  });
  const nor = new Float32Array(pts.length * 3);
  for (let k = 0; k < pts.length; k++) nor[k * 3 + 1] = 1;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  // Four trapezoids between the squares, wound counter-clockwise seen from +Y.
  g.setIndex([0, 5, 4, 0, 1, 5, 1, 6, 5, 1, 2, 6, 2, 7, 6, 2, 3, 7, 3, 4, 7, 3, 0, 4]);
  return g;
}
