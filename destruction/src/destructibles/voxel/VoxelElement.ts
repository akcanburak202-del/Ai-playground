import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SimContext, VoxelElementSpec } from '../../app/contracts.ts';
import { AIR_DENSITY, G } from '../../core/units.ts';
import { MATERIALS, type MaterialProps } from '../../physics/materials.ts';
import { groups, type PhysicsOwner, type ContactForceInfo } from '../../physics/PhysicsWorld.ts';
import type { BlastLoad, ContactDamage, ImpactEvent, MemberInfo, ProbeSegment, ThicknessProbe } from '../../physics/ballistics/types.ts';
import { allocateDestructibleId, type Destructible, type RayHit, type Structural } from '../Destructible.ts';
import { CHUNK, EMPTY, FULL, ISO, VoxelGrid, densityFromSdf } from './grid.ts';
import { fillGrid, layoutFor, makeShape, type ShapeSdf, BoxShape, CylinderShape } from './shape.ts';
import { chunkMayHaveSurface, meshChunk, type MeshData } from './mesher.ts';
import { Carver, type Roughness } from './carve.ts';
import { probeRun, traceRay, type RunSegment, type SampleBox, type TraceHit } from './trace.ts';
import { layoutRebar, segSegDist2, type RebarSet } from './rebar.ts';
import { Connectivity, type Island } from './connectivity.ts';
import { pickSeeds, planarCellDepth, splitSelection, type Piece, type Selection } from './fracture.ts';
import { VoxelLook, type DiscardUniforms } from './look.ts';
import { buildBaseGeometry } from './baseMesh.ts';
import { schedulerFor, type RemeshClient, type RemeshScheduler } from './scheduler.ts';
import { GrowingBatch, type BatchClient, type BatchSlot } from './batch.ts';

/**
 * A brittle structural element (concrete, stone, brick; optionally reinforced) backed by a sparse
 * voxel density grid. See DESIGN.md §4 M2 and the module files for the individual models:
 *   grid.ts (storage) · shape.ts (analytic shape) · carve.ts (craters, damage, crumbling)
 *   mesher.ts (Surface Nets) · trace.ts (rays and probes) · rebar.ts · connectivity.ts · fracture.ts
 *
 * Static elements render an analytic base mesh plus Surface Nets meshes for damaged chunks and
 * collide through a coarse Rapier voxel collider. Material that loses support is cut out into new
 * VoxelElements in rigid-body mode (convex-hull colliders) — still shootable, still fracturing.
 *
 * Elements that were never anchored (no StructureApi.link) and are not dynamic stay in place as a
 * whole; only islands detached from their largest remaining part fall. Anchored elements whose
 * anchors are all released fall entirely.
 */

// ── Calibration (see the comments where each is used) ─────────────────────────────────────────
/**
 * Continuum-damage calibration for projectile impacts. The micro-cracked zone (ΔD at the splat
 * centre), the crushed thread of a sub-voxel tunnel and a crater too small to carve all feed D;
 * exposed material crumbles out as D saturates. Calibrated so sustained 5.56 mm fire (σ ≈ 2.5 cm
 * at the target) on 25 cm of C40 digs ~5 cm in 30 rounds, ~10 cm in 100, exposes the bars by
 * ~50 and loopholes at ~200–250 rounds — FM 3-06.11 (2002), ch. 7: about 250 rounds of 5.56 mm
 * to loophole 8 in. (20 cm) of reinforced concrete, bars left in place.
 */
const IMPACT_DAMAGE_PEAK = 0.07;
/** Pieces smaller than this become chips (m³) — about a 5 cm cube */
const CHIP_VOLUME = 1.25e-4;
/** Minimum piece edge for rigid bodies (m) */
const MIN_PIECE_SIZE = 0.08;
/** One Voronoi piece per this much released volume (m³) */
const VOLUME_PER_PIECE = 0.05;
const MAX_PIECES_PER_EVENT = 24;
/** ΔD of a voxel fully occupied by a crater that is too small to carve */
const SUBVOXEL_CRATER_DAMAGE = 0.22;
/** Scale of the voxel-averaged damage of a sub-voxel crushed tunnel */
const TUNNEL_DAMAGE = 0.35;
/** How much a fully confined entry (pit floor) shrinks the front crater (applied squared) */
const CONFINED_CRATER = 0.9;
/** Seconds between the first material loss and the (debounced) support check */
const CHECK_DELAY = 0.08;
/** Low-cycle accumulation of free-field blast cracking (Carver.damage `accumulate`) */
const BLAST_DAMAGE_ACCUMULATION = 0.2;
/** Most surface patches one element scans for one blast (larger charges use coarser patches) */
const MAX_BLAST_PATCHES = 24000;
/**
 * Debris whose largest extent is under this (m) casts no shadow: at the sun's shadow-map texel
 * size (≈ 5–10 cm near the camera) its shadow is a blur of a few texels.
 */
const SHADOW_MIN_SIZE = 0.3;
/** Share of a member's face at P–I damage ≥ 2 that fails it as a whole panel (yield-line mechanism) */
const PANEL_FAILURE_SHARE = 0.5;
/** A severe region at least this many span² in area fails as one region (half a span square) */
const PANEL_REGION_SPANS = 0.25;
/** Face area of one slab of a panel failure, m² (≈ 1 m pieces) */
const PANEL_PIECE_AREA = 1.0;
const PANEL_MAX_PIECES = 32;
/** Cap on the rigid-plastic throw speed of blast-driven pieces, m/s (as for breach plugs) */
const PANEL_MAX_SPEED = 80;
/** Cantilever reach from one support, in element thicknesses */
const CANTILEVER_FACTOR = 10;
/** Largest span between two supports, in element thicknesses (RC slab span/depth ≈ 35) */
const SPAN_FACTOR = 35;

const REBAR = MATERIALS.rebar_b500;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _hit: TraceHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, bar: -1 };
const _best: TraceHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, bar: -1 };
function copyHit(a: TraceHit, b: TraceHit): void {
  b.t = a.t; b.x = a.x; b.y = a.y; b.z = a.z; b.nx = a.nx; b.ny = a.ny; b.nz = a.nz; b.bar = a.bar;
}
const _vSnap = new THREE.Vector3();
const _runs: RunSegment[] = [];
const _bm = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const IDENTITY = new THREE.Matrix4();

interface PieceInit {
  parent: VoxelElement;
  grid: VoxelGrid;
  rebar: RebarSet | null;
  linvel: THREE.Vector3;
  angvel: THREE.Vector3;
  /** Spawn event the piece belongs to (its Voronoi siblings share it) */
  group: number;
  /** Seeds of the split and this piece's index: its collision hull stays in its planar cell */
  cell: { seeds: number[]; index: number } | null;
}

/**
 * Speed a piece may gain in one step beyond gravity before the contact-gain limit looks at it,
 * m/s, and the coefficient of restitution the limit allows (debris uses 0.08; generous margin).
 */
const CONTACT_GAIN_SLACK = 1;
const CONTACT_RESTITUTION = 0.3;
/** Pushes from blasts and hits are real: the limit leaves a piece alone this long after one (s) */
const PUSH_GRACE = 0.1;
/** Freshly split siblings do not push each other apart for this long (s): their hulls are disjoint */
const SIBLING_SOLVER_GRACE = 0.07;
/** Pieces of gravity releases and landings smaller than this become chips, not bodies (m) */
const RUBBLE_MIN_SIZE = 0.1;
/** Contacts in the first steps of a piece's life are spawn transients, not landings (s) */
const SPAWN_SETTLE = 0.05;
/** Siblings bumping into each other this soon after the split do not crack each other (s) */
const SIBLING_CONTACT_GRACE = 0.6;
let spawnEvents = 0;

export interface VoxelStats {
  lastCarveMs: number;
  lastCheckMs: number;
  lastReleaseMs: number;
  meshedChunks: number;
  triangles: number;
  pieces: number;
}

function vec3(v: [number, number, number] | THREE.Vector3): THREE.Vector3 {
  return Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2]) : v.clone();
}

let pieceCounter = 0;

export class VoxelElement implements Destructible, Structural, RemeshClient, BatchClient {
  readonly id = allocateDestructibleId();
  readonly kind = 'voxel' as const;
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  disposed = false;
  readonly structural?: Structural;
  readonly spec: VoxelElementSpec;
  readonly material: MaterialProps;
  readonly shape: ShapeSdf;
  readonly grid: VoxelGrid;
  readonly rebar: RebarSet | null;
  readonly dynamic: boolean;
  readonly stats: VoxelStats = { lastCarveMs: 0, lastCheckMs: 0, lastReleaseMs: 0, meshedChunks: 0, triangles: 0, pieces: 0 };

  private readonly ctx: SimContext;
  private readonly carver: Carver;
  private readonly conn: Connectivity;
  private readonly look: VoxelLook;
  private readonly scheduler: RemeshScheduler;
  private sampleBox: SampleBox;
  // rendering
  private baseMesh: THREE.Mesh | null = null;
  private baseMaterial: THREE.MeshStandardMaterial | null = null;
  private depthMats: { depth: THREE.MeshDepthMaterial; distance: THREE.MeshDistanceMaterial } | null = null;
  private readonly meshed: Uint8Array;
  private readonly chunkMask: Uint8Array;
  private maskTex: THREE.Data3DTexture | null = null;
  /** Static elements: every re-meshed chunk is one slot of this element's batch (one draw per pass) */
  private chunkBatch: GrowingBatch | null = null;
  private readonly chunkSlots: (BatchSlot | null)[];
  private readonly chunkTris: Uint32Array;
  /** Dynamic elements: per-chunk mesh data, merged into one slot of the family's rubble batch */
  private pieceParts: (MeshData | null)[] | null = null;
  private solidSlot: BatchSlot | null = null;
  private solidBatch: GrowingBatch | null = null;
  private barSlot: BatchSlot | null = null;
  private barBatch: GrowingBatch | null = null;
  private solidDirty = false;
  private barsDirty = false;
  private matrixDirty = false;
  /**
   * A new piece draws its collision hull until the chunks queued at its birth are meshed (they
   * are spread over frames by the remesh budget; a released slab is ~1 000 chunks).
   */
  private proxy: { attrs: Record<string, THREE.BufferAttribute>; index: THREE.BufferAttribute } | null = null;
  private proxyShown = false;
  private birthChunks: Uint8Array | null = null;
  private birthPending = 0;
  private hullPts: Float32Array | null = null;
  private rebarMesh: THREE.InstancedMesh | null = null;
  private rebarLen: THREE.InstancedBufferAttribute | null = null;
  private rebarSeen = -1;
  private rebarDirty = true;
  // physics
  private readonly owner: PhysicsOwner;
  private fixedBody: RAPIER.RigidBody | null = null;
  private voxelCollider: RAPIER.Collider | null = null;
  private colF = 2;
  private colCells: Uint8Array | null = null;
  private colN: [number, number, number] = [0, 0, 0];
  private body: RAPIER.RigidBody | null = null;
  private mass = 0;
  private hullVolume = 0;
  // structure
  private anchors = new Map<string, THREE.Box3>();
  private anchorMasks: Uint8Array[] = [];
  private everAnchored = false;
  private imposedLoad = 0;
  private failed = false;
  private checkAt = -1;
  private readonly horizontal: [number, number, number] = [0, 0, 0];
  private lastImpact = new THREE.Vector3();
  private pendingBlast: { load: BlastLoad; thickness: number; until: number } | null = null;
  private initialCounts = new Map<string, number>();
  private pendingSplit: { point: THREE.Vector3 } | null = null;
  /** Inward axis of the contact charge being realised (bar bending direction), local */
  private blastAxis: THREE.Vector3 | null = null;
  private lastContactEvent = -1;
  /** Set by panelFailure during applyBlast: material left as pieces, supports must be re-checked */
  private panelReleased = false;
  private eventSeed = 1;
  private invQ = new THREE.Quaternion();
  /** Spawn event id shared with sibling pieces (0 for original elements) */
  private spawnGroup = 0;
  private bornAt = 0;
  private hullCell: { seeds: number[]; index: number } | null = null;
  /** Body velocity at the end of the previous fixed step (contact energy bookkeeping) */
  private readonly prevLin = new THREE.Vector3();
  private readonly prevAng = new THREE.Vector3();
  /** Last explicit push (projectile hit, blast load) on this piece, sim s */
  private pushedAt = -1;
  /** Solver contacts with same-event siblings are off until then (sim s); −1 once restored */
  private siblingSolverUntil = -1;

  constructor(ctx: SimContext, spec: VoxelElementSpec, piece?: PieceInit) {
    this.ctx = ctx;
    this.spec = spec;
    this.material = MATERIALS[spec.material];
    this.scheduler = schedulerFor(ctx);
    watchBlasts(ctx);
    if (piece) {
      this.name = `${piece.parent.name}·${++pieceCounter}`;
      this.shape = piece.parent.shape;
      this.grid = piece.grid;
      this.rebar = piece.rebar;
      this.look = piece.parent.look.acquire();
      this.root.position.copy(piece.parent.root.position);
      this.root.quaternion.copy(piece.parent.root.quaternion);
      this.dynamic = true;
      this.spawnGroup = piece.group;
      this.bornAt = ctx.time.now;
      this.hullCell = piece.cell;
    } else {
      this.name = spec.name;
      this.shape = makeShape(spec.shape);
      this.grid = new VoxelGrid(layoutFor(this.shape, spec.voxelSize ?? 0.025));
      fillGrid(this.grid, this.shape);
      this.rebar = spec.rebar ? layoutRebar(this.shape, spec.rebar) : null;
      this.root.position.copy(vec3(spec.position));
      if (spec.rotation instanceof THREE.Quaternion) this.root.quaternion.copy(spec.rotation);
      else if (spec.rotation) {
        const r = vec3(spec.rotation as [number, number, number]);
        this.root.quaternion.setFromEuler(new THREE.Euler(r.x, r.y, r.z, 'XYZ'));
      }
      const aniso = ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
      const sh = this.shape;
      const shapeInfo = sh instanceof BoxShape ? { kind: 1 as const }
        : sh instanceof CylinderShape ? { kind: 2 as const, radius: sh.radius, halfHeight: sh.height / 2, taper: sh.taper, flutes: sh.flutes, fluteDepth: sh.fluteDepth }
        : { kind: 0 as const };
      this.look = new VoxelLook(spec.finish, spec.tint, this.shape.half, ((this.id * 0.6180339) % 1) * 10, sh instanceof BoxShape, Math.min(8, aniso), shapeInfo).acquire();
      this.dynamic = !!spec.dynamic;
    }
    this.root.name = this.name;
    this.root.updateMatrixWorld(true);
    this.invQ.copy(this.root.quaternion).invert();
    this.rebar?.register(this.grid);
    this.carver = new Carver(this.grid);
    this.conn = new Connectivity(this.grid, this.grid.h < 0.035 ? 2 : 1);
    this.conn.update(this.grid, null);
    this.grid.occDirtyList.length = 0;
    this.grid.occDirty.fill(0);
    this.grid.dirtyList.length = 0;
    this.grid.dirty.fill(0);
    this.meshed = new Uint8Array(this.grid.chunkCount);
    this.chunkMask = new Uint8Array(this.grid.chunkCount);
    this.chunkSlots = new Array(this.grid.chunkCount).fill(null);
    this.chunkTris = new Uint32Array(this.grid.chunkCount);
    this.sampleBox = this.grid.solidSampleBounds() ?? [0, 0, 0, 0, 0, 0];
    this.owner = { kind: 'voxel', material: this.material, destructible: this, onContactForce: (i) => this.onContactForce(i) };
    this.computeHorizontal();

    if (piece) {
      // Debris pieces are Surface Nets throughout; their chunks are meshed by the scheduler as
      // urgent work (ahead of the parent's own remesh, whose old mesh shows the material in place
      // until then).
      this.queueAllChunks(-1e9);
    } else {
      this.buildBase();
    }
    this.buildRebarMesh();
    if (this.dynamic) this.makeDynamicBody(piece?.linvel, piece?.angvel, !piece);
    else this.makeStaticBody();
    if (piece && this.birthPending > 0) this.buildProxy();
    if (!this.dynamic) this.structural = this;
    this.updateBounds();
  }

  // ── Frames ────────────────────────────────────────────────────────────────────────────────

  private toLocal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).sub(this.root.position).applyQuaternion(this.invQ);
  }
  private toLocalDir(d: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(d).applyQuaternion(this.invQ);
  }
  private toWorld(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).applyQuaternion(this.root.quaternion).add(this.root.position);
  }
  private toWorldDir(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).applyQuaternion(this.root.quaternion);
  }

  /** Horizontal length of one coarse step along each local axis (cantilever rule weights). */
  private computeHorizontal(): void {
    const step = this.conn.F * this.grid.h;
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    for (let a = 0; a < 3; a++) {
      const w = axes[a]!.applyQuaternion(this.root.quaternion);
      const vert = Math.abs(w.dot(UP));
      this.horizontal[a] = step * Math.sqrt(Math.max(0, 1 - vert * vert));
      if (this.horizontal[a]! < step * 0.02) this.horizontal[a] = 0;
    }
  }

  private updateBounds(): void {
    const g = this.grid, b = this.sampleBox;
    const h = g.h;
    const x0 = g.ox + (b[0] - 1) * h, y0 = g.oy + (b[1] - 1) * h, z0 = g.oz + (b[2] - 1) * h;
    const x1 = g.ox + (b[3] + 1) * h, y1 = g.oy + (b[4] + 1) * h, z1 = g.oz + (b[5] + 1) * h;
    this.bounds.makeEmpty();
    for (let c = 0; c < 8; c++) {
      this.toWorld(c & 1 ? x1 : x0, c & 2 ? y1 : y0, c & 4 ? z1 : z0, _v);
      this.bounds.expandByPoint(_v);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────────────────

  private buildBase(): void {
    const g = this.grid;
    this.maskTex = new THREE.Data3DTexture(this.chunkMask, g.cx, g.cy, g.cz);
    this.maskTex.format = THREE.RedFormat;
    this.maskTex.type = THREE.UnsignedByteType;
    this.maskTex.minFilter = this.maskTex.magFilter = THREE.NearestFilter;
    this.maskTex.unpackAlignment = 1;
    this.maskTex.needsUpdate = true;
    const discard: DiscardUniforms = {
      uChunkMask: { value: this.maskTex },
      uGridOrigin: { value: new THREE.Vector3(g.ox, g.oy, g.oz) },
      uVoxel: { value: g.h },
      uChunkDims: { value: new THREE.Vector3(g.cx, g.cy, g.cz) },
    };
    this.baseMaterial = this.look.makeBaseMaterial(discard);
    this.depthMats = this.look.makeDepthMaterials(discard);
    const geom = buildBaseGeometry(this.shape, g);
    this.baseMesh = new THREE.Mesh(geom, this.baseMaterial);
    this.baseMesh.castShadow = this.baseMesh.receiveShadow = true;
    this.baseMesh.customDepthMaterial = this.depthMats.depth;
    this.baseMesh.customDistanceMaterial = this.depthMats.distance;
    this.baseMesh.name = `${this.name}:base`;
    this.root.add(this.baseMesh);
  }

  /** RemeshClient: rebuild chunk ci's Surface Nets mesh. */
  remesh(ci: number, force = false): boolean {
    const g = this.grid;
    if (!force && !g.dirty[ci] && this.meshed[ci]) return false;
    g.dirty[ci] = 0;
    const a = ci % g.cx, b = Math.floor(ci / g.cx) % g.cy, c = Math.floor(ci / (g.cx * g.cy));
    const m = chunkMayHaveSurface(g, a, b, c) ? meshChunk(g, this.shape, a, b, c) : null;
    if (this.birthChunks?.[ci]) {
      this.birthChunks[ci] = 0;
      if (--this.birthPending <= 0) {
        // Every chunk of the new piece is meshed: the real surface replaces the hull proxy.
        this.birthChunks = null;
        this.proxy = null;
      }
    }
    this.setChunkMesh(ci, m);
    if (!this.meshed[ci]) {
      this.meshed[ci] = 1;
      this.chunkMask[ci] = 255;
      if (this.maskTex) this.maskTex.needsUpdate = true;
      this.rebarDirty = true;
      this.stats.meshedChunks++;
    }
    return true;
  }

  /** Queue every chunk that can own surface for meshing with priority `prio`. */
  private queueAllChunks(prio: number): void {
    const g = this.grid;
    this.birthChunks = new Uint8Array(g.chunkCount);
    for (let ci = 0; ci < g.chunkCount; ci++) {
      const a = ci % g.cx, b = Math.floor(ci / g.cx) % g.cy, c = Math.floor(ci / (g.cx * g.cy));
      if (chunkMayHaveSurface(g, a, b, c)) {
        g.dirty[ci] = 1;
        this.scheduler.request(this, ci, prio);
        this.birthChunks[ci] = 1;
        this.birthPending++;
      }
      if (!this.meshed[ci]) {
        this.meshed[ci] = 1;
        this.chunkMask[ci] = 255;
      }
    }
  }

  private setChunkMesh(ci: number, m: MeshData | null): void {
    if (this.dynamic) {
      this.setPiecePart(ci, m);
      return;
    }
    const old = this.chunkSlots[ci];
    this.stats.triangles -= this.chunkTris[ci]!;
    this.chunkTris[ci] = 0;
    if (!m) {
      if (old) {
        this.chunkBatch!.remove(old);
        this.chunkSlots[ci] = null;
      }
      return;
    }
    const attrs = solidAttributes(m.positions, m.normals, m.damage, m.depth, m.soot);
    const index = new THREE.BufferAttribute(m.indices, 1);
    const batch = (this.chunkBatch ??= this.makeChunkBatch());
    this.chunkSlots[ci] = old ? batch.update(old, attrs, index, IDENTITY) : batch.add(attrs, index, IDENTITY);
    this.chunkTris[ci] = m.indexCount / 3;
    this.stats.triangles += m.indexCount / 3;
  }

  /** The batch of a static element's re-meshed chunks, under its root (identity instances). */
  private makeChunkBatch(): GrowingBatch {
    const b = new GrowingBatch(this.look.batchedChunkMaterial(), `${this.name}:chunks`, true, 16, 1 << 13, 3 << 13);
    this.root.add(b.mesh);
    return b;
  }

  /**
   * Debris pieces span only a few chunks: their chunk meshes are merged into one geometry, one
   * instance of the family's rubble batch (see batch.ts), pushed when the batch is next drawn.
   */
  private setPiecePart(ci: number, m: MeshData | null): void {
    const parts = (this.pieceParts ??= new Array(this.grid.chunkCount).fill(null));
    const old = parts[ci];
    if (old) this.stats.triangles -= old.indexCount / 3;
    parts[ci] = m;
    if (m) this.stats.triangles += m.indexCount / 3;
    this.solidDirty = true;
    // The surface moved: bars may have been laid bare (or buried by a remesh of a fresh piece).
    if (this.rebar) this.barsDirty = true;
    this.requestBatchFlush();
  }

  /** Large pieces cast shadows, small ones do not (SHADOW_MIN_SIZE). */
  private castsShadow(): boolean {
    const b = this.sampleBox;
    return Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) * this.grid.h >= SHADOW_MIN_SIZE;
  }

  /** Pending batch work: pushed in this piece's frameUpdate (or by flushMeshes). */
  private requestBatchFlush(): void {
    this.look.batches.markDirty(this);
  }

  /** BatchClient: push pending geometry and the current transform into the family batches. */
  flushBatch(): void {
    if (this.disposed) return;
    const parent = this.root.parent ?? this.ctx.world;
    _bm.compose(this.root.position, this.root.quaternion, _one);
    if (this.solidDirty) {
      this.solidDirty = false;
      this.pushSolid(parent, _bm);
    }
    if (this.barsDirty) {
      this.barsDirty = false;
      this.pushBars(parent, _bm);
    }
    if (this.matrixDirty) {
      this.matrixDirty = false;
      if (this.solidSlot) this.solidBatch!.setMatrix(this.solidSlot, _bm);
      if (this.barSlot) this.barBatch!.setMatrix(this.barSlot, _bm);
    }
  }

  /**
   * The proxy drawn until a new piece is meshed: the convex hull of its collider points, with
   * vertices within ~a voxel of an original box face put back on that face (the hull points sit
   * ~0.65 voxel inside the surface), so the shader shades those faces as the original finish.
   */
  private buildProxy(): void {
    const pts = this.hullPts;
    this.hullPts = null;
    if (!pts || pts.length < 12) return;
    const v: THREE.Vector3[] = [];
    for (let i = 0; i < pts.length; i += 3) v.push(new THREE.Vector3(pts[i], pts[i + 1], pts[i + 2]));
    let geo: THREE.BufferGeometry;
    try {
      geo = new ConvexGeometry(v);
    } catch {
      return;
    }
    const pos = geo.getAttribute('position').array as Float32Array;
    geo.dispose();
    const n = pos.length / 3;
    if (n < 3) return;
    if (this.shape instanceof BoxShape) {
      const half = this.shape.half, reach = 0.8 * this.grid.h;
      for (let i = 0; i < pos.length; i++) {
        const hh = half[i % 3]!;
        if (Math.abs(pos[i]!) >= hh - reach) pos[i] = Math.sign(pos[i]!) * hh;
      }
    }
    const nrm = new Float32Array(pos.length);
    for (let t = 0; t < pos.length; t += 9) {
      _v.set(pos[t + 3]! - pos[t]!, pos[t + 4]! - pos[t + 1]!, pos[t + 5]! - pos[t + 2]!);
      _v2.set(pos[t + 6]! - pos[t]!, pos[t + 7]! - pos[t + 1]!, pos[t + 8]! - pos[t + 2]!);
      _v.cross(_v2).normalize();
      for (let k = 0; k < 3; k++) { nrm[t + k * 3] = _v.x; nrm[t + k * 3 + 1] = _v.y; nrm[t + k * 3 + 2] = _v.z; }
    }
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    this.proxy = { attrs: solidAttributes(pos, nrm, new Float32Array(n), new Float32Array(n), new Float32Array(n)), index: new THREE.BufferAttribute(idx, 1) };
    this.solidDirty = true;
    this.requestBatchFlush();
  }

  private pushSolid(parent: THREE.Object3D, matrix: THREE.Matrix4): void {
    if (this.proxy) {
      // Chunks meshed meanwhile wait until the whole piece is done (a partial surface has holes).
      if (this.proxyShown) return;
      const batch = this.solidBatch ?? this.look.batches.solid(this.castsShadow(), parent);
      this.solidSlot = this.solidSlot ? batch.update(this.solidSlot, this.proxy.attrs, this.proxy.index, matrix) : batch.add(this.proxy.attrs, this.proxy.index, matrix);
      this.solidBatch = batch;
      this.proxyShown = true;
      return;
    }
    const parts = this.pieceParts ?? [];
    let nv = 0, ni = 0;
    for (const q of parts) if (q) { nv += q.vertexCount; ni += q.indexCount; }
    if (nv === 0) {
      if (this.solidSlot) this.solidBatch!.remove(this.solidSlot);
      this.solidSlot = null;
      return;
    }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
    const dmg = new Float32Array(nv), dep = new Float32Array(nv), soot = new Float32Array(nv);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const q of parts) {
      if (!q) continue;
      pos.set(q.positions.subarray(0, q.vertexCount * 3), vo * 3);
      nrm.set(q.normals.subarray(0, q.vertexCount * 3), vo * 3);
      dmg.set(q.damage.subarray(0, q.vertexCount), vo);
      dep.set(q.depth.subarray(0, q.vertexCount), vo);
      soot.set(q.soot.subarray(0, q.vertexCount), vo);
      for (let k = 0; k < q.indexCount; k++) idx[io + k] = q.indices[k]! + vo;
      vo += q.vertexCount;
      io += q.indexCount;
    }
    const attrs = solidAttributes(pos, nrm, dmg, dep, soot);
    const index = new THREE.BufferAttribute(idx, 1);
    const batch = this.look.batches.solid(this.castsShadow(), parent);
    if (this.solidSlot && this.solidBatch === batch) {
      this.solidSlot = batch.update(this.solidSlot, attrs, index, matrix);
    } else {
      if (this.solidSlot) this.solidBatch!.remove(this.solidSlot);
      this.solidSlot = batch.add(attrs, index, matrix);
      this.solidBatch = batch;
    }
  }

  /**
   * Debris bars baked into one geometry in the element frame (8-sided open tubes, like the
   * static elements' instanced bars) and added to the family's rebar batch. Only bars that can
   * show are drawn: a segment whose axis lies deeper than its radius (plus a third of a voxel for
   * the smoothing of the surface) below the concrete surface at both ends and mid-length stays
   * hidden, as static elements hide bars in chunks that were never re-meshed. (A slab piece
   * carries ~2 600 segments, ~40 k triangles, nearly all of them embedded.)
   */
  private pushBars(parent: THREE.Object3D, matrix: THREE.Matrix4): void {
    const rb = this.rebar!;
    const g = this.grid;
    const segs: number[] = [];
    const nn = rb.nodes;
    for (let s = 0; s < rb.segCount; s++) {
      if (rb.segGone[s] || rb.segCut[s]) continue;
      // Density ramps from ISO at the surface to 255 one voxel inside (densityFromSdf).
      const hidden = ISO + (ISO * (rb.radius(s) + 0.33 * g.h)) / g.h;
      const a = rb.segA[s]! * 3, b = rb.segB[s]! * 3;
      const ax = nn[a]!, ay = nn[a + 1]!, az = nn[a + 2]!, bx = nn[b]!, by = nn[b + 1]!, bz = nn[b + 2]!;
      if (
        g.densityAt(g.gx(ax), g.gy(ay), g.gz(az)) < hidden || g.densityAt(g.gx(bx), g.gy(by), g.gz(bz)) < hidden ||
        g.densityAt(g.gx((ax + bx) / 2), g.gy((ay + by) / 2), g.gz((az + bz) / 2)) < hidden
      ) segs.push(s);
    }
    const SIDES = 8;
    const pos = new Float32Array(segs.length * SIDES * 2 * 3), nrm = new Float32Array(segs.length * SIDES * 2 * 3);
    const along = new Float32Array(segs.length * SIDES * 2);
    const idx = new Uint32Array(segs.length * SIDES * 6);
    const n = rb.nodes;
    let nv = 0, ni = 0;
    for (const s of segs) {
      const a = rb.segA[s]! * 3, b = rb.segB[s]! * 3;
      _v.set(n[a]!, n[a + 1]!, n[a + 2]!);
      _v2.set(n[b]!, n[b + 1]!, n[b + 2]!);
      const L = _v.distanceTo(_v2);
      if (L < 1e-5) continue;
      const r = rb.radius(s);
      const t = _s.subVectors(_v2, _v).divideScalar(L);
      // Ring basis: u = t × (helper axis), w = t × u.
      const hx = Math.abs(t.y) < 0.9 ? 0 : 1, hy = 1 - hx;
      let ux = -t.z * hy, uy = t.z * hx, uz = t.x * hy - t.y * hx;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const wx = t.y * uz - t.z * uy, wy = t.z * ux - t.x * uz, wz = t.x * uy - t.y * ux;
      // Overlap the joints by 0.3 r at each end (as the instanced bars do).
      const e = 0.3 * r;
      const base = nv;
      for (let end = 0; end < 2; end++) {
        const cx = end ? _v2.x + t.x * e : _v.x - t.x * e;
        const cy = end ? _v2.y + t.y * e : _v.y - t.y * e;
        const cz = end ? _v2.z + t.z * e : _v.z - t.z * e;
        for (let k = 0; k < SIDES; k++) {
          const ang = (k / SIDES) * Math.PI * 2;
          const c = Math.cos(ang), sn = Math.sin(ang);
          const nx = ux * c + wx * sn, ny = uy * c + wy * sn, nz = uz * c + wz * sn;
          pos[nv * 3] = cx + nx * r; pos[nv * 3 + 1] = cy + ny * r; pos[nv * 3 + 2] = cz + nz * r;
          nrm[nv * 3] = nx; nrm[nv * 3 + 1] = ny; nrm[nv * 3 + 2] = nz;
          along[nv] = end ? L : 0;
          nv++;
        }
      }
      // Counter-clockwise seen from outside: (a1 − a0) × (b0 − a0) ∝ w × t = u, outward.
      for (let k = 0; k < SIDES; k++) {
        const k1 = (k + 1) % SIDES;
        const a0 = base + k, a1 = base + k1, b0 = base + SIDES + k, b1 = base + SIDES + k1;
        idx[ni++] = a0; idx[ni++] = a1; idx[ni++] = b0;
        idx[ni++] = a1; idx[ni++] = b1; idx[ni++] = b0;
      }
    }
    const batch = this.look.batches.rebar(parent);
    if (nv === 0) {
      if (this.barSlot) batch.remove(this.barSlot);
      this.barSlot = null;
      return;
    }
    const attrs = {
      position: new THREE.BufferAttribute(pos.subarray(0, nv * 3), 3),
      normal: new THREE.BufferAttribute(nrm.subarray(0, nv * 3), 3),
      aAlong: new THREE.BufferAttribute(along.subarray(0, nv), 1),
    };
    const index = new THREE.BufferAttribute(idx.subarray(0, ni), 1);
    this.barSlot = this.barSlot ? batch.update(this.barSlot, attrs, index, matrix) : batch.add(attrs, index, matrix);
    this.barBatch = batch;
  }

  /** Queue remeshing of every chunk the last edits dirtied, nearest to the camera first. */
  private flushDirty(): void {
    const g = this.grid;
    if (!g.dirtyList.length) return;
    const cam = this.ctx.camera.position;
    const half = (CHUNK / 2) * g.h;
    for (const ci of g.dirtyList) {
      const a = ci % g.cx, b = Math.floor(ci / g.cx) % g.cy, c = Math.floor(ci / (g.cx * g.cy));
      this.toWorld(g.ox + a * CHUNK * g.h + half, g.oy + b * CHUNK * g.h + half, g.oz + c * CHUNK * g.h + half, _v);
      this.scheduler.request(this, ci, _v.distanceToSquared(cam));
    }
    g.dirtyList.length = 0;
  }

  private buildRebarMesh(): void {
    // Debris bars are baked into the family's rebar batch instead (pushBars).
    if (!this.rebar || this.dynamic) return;
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    this.rebarLen = new THREE.InstancedBufferAttribute(new Float32Array(this.rebar.segCount), 1);
    geo.setAttribute('aLen', this.rebarLen);
    this.rebarMesh = new THREE.InstancedMesh(geo, this.look.rebarMaterial, this.rebar.segCount);
    this.rebarMesh.count = 0;
    this.rebarMesh.castShadow = true;
    this.rebarMesh.receiveShadow = true;
    this.rebarMesh.frustumCulled = false;
    this.rebarMesh.name = `${this.name}:rebar`;
    this.root.add(this.rebarMesh);
  }

  /** Instance the bar segments that lie in re-meshed chunks (the rest are hidden in concrete). */
  private updateRebarInstances(): void {
    const rb = this.rebar;
    if (!rb) return;
    if (!this.rebarDirty && this.rebarSeen === rb.version) return;
    if (this.dynamic) {
      this.rebarDirty = false;
      this.rebarSeen = rb.version;
      this.barsDirty = true;
      this.requestBatchFlush();
      return;
    }
    const mesh = this.rebarMesh;
    if (!mesh || !this.rebarLen) return;
    this.rebarDirty = false;
    this.rebarSeen = rb.version;
    const stamp = rb.nextStamp();
    let n = 0;
    const nodes = rb.nodes;
    const place = (s: number) => {
      if (rb.segGone[s] || rb.segCut[s] || rb.seen(s, stamp)) return;
      const a = rb.segA[s]! * 3, b = rb.segB[s]! * 3;
      _v.set(nodes[a]!, nodes[a + 1]!, nodes[a + 2]!);
      _v2.set(nodes[b]!, nodes[b + 1]!, nodes[b + 2]!);
      const L = _v.distanceTo(_v2);
      if (L < 1e-5) return;
      const r = rb.radius(s);
      _s.subVectors(_v2, _v).divideScalar(L);
      _q.setFromUnitVectors(UP, _s);
      _v.add(_v2).multiplyScalar(0.5);
      _m.compose(_v, _q, _s.set(r, L + r * 0.6, r));
      mesh.setMatrixAt(n, _m);
      this.rebarLen!.setX(n, L);
      n++;
    };
    for (const [ci, list] of rb.chunkSegs) if (this.meshed[ci]) for (const s of list) place(s);
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    this.rebarLen.needsUpdate = true;
  }

  // ── Physics ───────────────────────────────────────────────────────────────────────────────

  /** Coarse voxel collider cell (I,J,K) covers samples [2 + F·I, 2 + F·(I+1)) so box faces land on cell faces. */
  private colliderFilled(I: number, J: number, K: number): boolean {
    const g = this.grid, F = this.colF;
    const i0 = 2 + F * I, j0 = 2 + F * J, k0 = 2 + F * K;
    let n = 0;
    for (let k = k0; k < k0 + F; k++) for (let j = j0; j < j0 + F; j++) for (let i = i0; i < i0 + F; i++) if (g.density(i, j, k) >= ISO) n++;
    return n * 2 >= F * F * F;
  }

  private makeStaticBody(): void {
    const g = this.grid;
    const p = this.ctx.physics;
    this.colF = Math.max(1, Math.round(0.05 / g.h));
    const F = this.colF;
    this.colN = [Math.ceil((g.nx - 2) / F), Math.ceil((g.ny - 2) / F), Math.ceil((g.nz - 2) / F)];
    const [nx, ny, nz] = this.colN;
    this.colCells = new Uint8Array(nx * ny * nz);
    const coords: number[] = [];
    for (let K = 0; K < nz; K++)
      for (let J = 0; J < ny; J++)
        for (let I = 0; I < nx; I++) {
          if (!this.colliderFilled(I, J, K)) continue;
          this.colCells[I + nx * (J + ny * K)] = 1;
          coords.push(I, J, K);
        }
    if (!coords.length) return;
    const s = F * g.h;
    const desc = p.R.ColliderDesc.voxels(new Int32Array(coords), { x: s, y: s, z: s })
      .setTranslation(g.ox + 1.5 * g.h, g.oy + 1.5 * g.h, g.oz + 1.5 * g.h)
      .setFriction(0.8);
    this.fixedBody = p.createFixed(this.root.position, this.root.quaternion, [desc], this.owner);
    this.voxelCollider = this.fixedBody.collider(0);
  }

  /** Clear collider cells that lost their material in the given (occupancy-dirty) chunks. */
  private syncCollider(chunks: readonly number[]): void {
    if (!this.voxelCollider || !this.colCells) return;
    const g = this.grid, F = this.colF;
    const [nx, ny, nz] = this.colN;
    for (const ci of chunks) {
      const a = ci % g.cx, b = Math.floor(ci / g.cx) % g.cy, c = Math.floor(ci / (g.cx * g.cy));
      const I0 = Math.max(0, Math.floor((a * CHUNK - 2) / F)), I1 = Math.min(nx - 1, Math.floor((a * CHUNK + CHUNK - 1 - 2) / F));
      const J0 = Math.max(0, Math.floor((b * CHUNK - 2) / F)), J1 = Math.min(ny - 1, Math.floor((b * CHUNK + CHUNK - 1 - 2) / F));
      const K0 = Math.max(0, Math.floor((c * CHUNK - 2) / F)), K1 = Math.min(nz - 1, Math.floor((c * CHUNK + CHUNK - 1 - 2) / F));
      for (let K = K0; K <= K1; K++)
        for (let J = J0; J <= J1; J++)
          for (let I = I0; I <= I1; I++) {
            const idx = I + nx * (J + ny * K);
            if (!this.colCells[idx]) continue;
            if (this.colliderFilled(I, J, K)) continue;
            this.colCells[idx] = 0;
            try {
              this.voxelCollider.setVoxel(I, J, K, false);
            } catch {
              /* world replaced by a scene load */
            }
          }
    }
  }

  /**
   * Empty the static collider wherever a new piece's material lies. syncCollider keeps a coarse
   * cell while it is at least half full, so without this a piece cut from a partly emptied cell
   * would spawn inside its parent's collider and be kicked out at depenetration speed. Piece grids
   * share the parent's lattice (cropGrid), so their samples map onto it by an integer offset.
   */
  private clearColliderUnder(piece: VoxelGrid): void {
    if (!this.voxelCollider || !this.colCells) return;
    const g = this.grid, F = this.colF;
    const [nx, ny, nz] = this.colN;
    const di = Math.round((piece.ox - g.ox) / g.h), dj = Math.round((piece.oy - g.oy) / g.h), dk = Math.round((piece.oz - g.oz) / g.h);
    const b = piece.solidSampleBounds();
    if (!b) return;
    for (let k = b[2]; k <= b[5]; k++)
      for (let j = b[1]; j <= b[4]; j++)
        for (let i = b[0]; i <= b[3]; i++) {
          if (piece.density(i, j, k) < ISO) continue;
          const I = Math.floor((i + di - 2) / F), J = Math.floor((j + dj - 2) / F), K = Math.floor((k + dk - 2) / F);
          if (I < 0 || J < 0 || K < 0 || I >= nx || J >= ny || K >= nz) continue;
          const idx = I + nx * (J + ny * K);
          if (!this.colCells[idx]) continue;
          this.colCells[idx] = 0;
          try {
            this.voxelCollider.setVoxel(I, J, K, false);
          } catch {
            /* world replaced by a scene load */
          }
        }
  }

  /**
   * Also empty the cells a new piece's convex collision hull reaches into: the hull spans the
   * concave rim of the hole the piece came out of, where the parent's cells are still more than
   * half full. Measured on a 3 kg breach: plug pieces started up to 43 mm inside the wall's
   * collider and kept only 63 % of their launch speed.
   */
  private clearColliderUnderHull(piece: VoxelElement): void {
    const col = piece.body?.numColliders() ? piece.body.collider(0) : null;
    if (!this.voxelCollider || !this.colCells || !col) return;
    const g = this.grid, F = this.colF, s = F * g.h;
    const [nx, ny, nz] = this.colN;
    const lb = this.localBox(piece.bounds);
    const c0 = g.ox + 1.5 * g.h, c1 = g.oy + 1.5 * g.h, c2 = g.oz + 1.5 * g.h;
    const I0 = Math.max(0, Math.floor((lb.min.x - c0) / s)), I1 = Math.min(nx - 1, Math.floor((lb.max.x - c0) / s));
    const J0 = Math.max(0, Math.floor((lb.min.y - c1) / s)), J1 = Math.min(ny - 1, Math.floor((lb.max.y - c1) / s));
    const K0 = Math.max(0, Math.floor((lb.min.z - c2) / s)), K1 = Math.min(nz - 1, Math.floor((lb.max.z - c2) / s));
    const reach2 = (0.87 * s) ** 2;
    const q = { x: 0, y: 0, z: 0 };
    for (let K = K0; K <= K1; K++)
      for (let J = J0; J <= J1; J++)
        for (let I = I0; I <= I1; I++) {
          const idx = I + nx * (J + ny * K);
          if (!this.colCells[idx]) continue;
          this.toWorld(c0 + (I + 0.5) * s, c1 + (J + 0.5) * s, c2 + (K + 0.5) * s, _v);
          q.x = _v.x; q.y = _v.y; q.z = _v.z;
          const pr = col.projectPoint(q, true);
          if (!pr) continue;
          const d2 = (pr.point.x - q.x) ** 2 + (pr.point.y - q.y) ** 2 + (pr.point.z - q.z) ** 2;
          if (!pr.isInside && d2 > reach2) continue;
          this.colCells[idx] = 0;
          try {
            this.voxelCollider.setVoxel(I, J, K, false);
          } catch {
            /* world replaced by a scene load */
          }
        }
  }

  /**
   * Hull points from the grid: solid samples with an air neighbour (the surface layer), thinned to
   * ~120 and pulled in slightly. A piece cut by warped Voronoi planes is not convex and its hull
   * would reach into its siblings; keeping only points inside its own planar cell (convex) makes
   * sibling hulls disjoint, so pieces start apart instead of being kicked out of each other.
   */
  private hullPoints(): Float32Array {
    const g = this.grid, b = this.sampleBox;
    const surf: number[] = [];
    // Large pieces (a slab of a blown-out wall is ~20 k samples) are scanned on every other
    // sample: ~120 points are kept anyway, and the hull shrinks by at most a voxel.
    const st = (b[3] - b[0] + 1) * (b[4] - b[1] + 1) * (b[5] - b[2] + 1) > 16000 ? 2 : 1;
    for (let k = b[2]; k <= b[5]; k += st)
      for (let j = b[1]; j <= b[4]; j += st)
        for (let i = b[0]; i <= b[3]; i += st) {
          if (g.density(i, j, k) < ISO) continue;
          if (
            g.density(i - st, j, k) < ISO || g.density(i + st, j, k) < ISO || g.density(i, j - st, k) < ISO ||
            g.density(i, j + st, k) < ISO || g.density(i, j, k - st) < ISO || g.density(i, j, k + st) < ISO
          ) surf.push(i, j, k);
        }
    const cell = this.hullCell;
    if (cell) {
      const inCell: number[] = [];
      for (let q = 0; q < surf.length; q += 3) {
        if (planarCellDepth(cell.seeds, cell.index, g.lx(surf[q]!), g.ly(surf[q + 1]!), g.lz(surf[q + 2]!)) >= 0.1 * g.h) inCell.push(surf[q]!, surf[q + 1]!, surf[q + 2]!);
      }
      // A sliver that lies mostly across its plane keeps its full hull.
      if (inCell.length >= 36 && inCell.length >= 0.3 * surf.length) {
        surf.length = 0;
        for (const v of inCell) surf.push(v);
      }
    }
    const pts: number[] = [];
    const stride = Math.max(1, Math.floor(surf.length / 3 / 120));
    for (let q = 0; q < surf.length; q += 3 * stride) pts.push(g.lx(surf[q]!), g.ly(surf[q + 1]!), g.lz(surf[q + 2]!));
    if (pts.length < 12) {
      for (let c = 0; c < 8; c++) pts.push(g.lx(c & 1 ? b[3] + 0.5 : b[0] - 0.5), g.ly(c & 2 ? b[4] + 0.5 : b[1] - 0.5), g.lz(c & 4 ? b[5] + 0.5 : b[2] - 0.5));
    }
    // Surface samples sit ~½ voxel inside the iso surface already; pull in a little more.
    let cx = 0, cy = 0, cz = 0;
    const n = pts.length / 3;
    for (let i = 0; i < pts.length; i += 3) { cx += pts[i]!; cy += pts[i + 1]!; cz += pts[i + 2]!; }
    cx /= n; cy /= n; cz /= n;
    const inset = 0.15 * g.h;
    for (let i = 0; i < pts.length; i += 3) {
      const dx = pts[i]! - cx, dy = pts[i + 1]! - cy, dz = pts[i + 2]! - cz;
      const l = Math.hypot(dx, dy, dz);
      const k = l > 2 * inset ? (l - inset) / l : 0.5;
      pts[i] = cx + dx * k; pts[i + 1] = cy + dy * k; pts[i + 2] = cz + dz * k;
    }
    return new Float32Array(pts);
  }

  private makeDynamicBody(linvel?: THREE.Vector3, angvel?: THREE.Vector3, sleeping = false): void {
    const p = this.ctx.physics;
    if (!this.dynamic) return;
    const pts = this.hullPoints();
    if (this.birthPending > 0) this.hullPts = pts;
    this.mass = this.grid.solidVolume() * this.material.density + (this.rebar?.mass() ?? 0);
    const size = Math.cbrt(this.grid.solidVolume());
    let desc = p.R.ColliderDesc.convexHull(pts);
    if (!desc) {
      const b = this.sampleBox, g = this.grid;
      desc = p.R.ColliderDesc.cuboid(((b[3] - b[0] + 1) * g.h) / 2, ((b[4] - b[1] + 1) * g.h) / 2, ((b[5] - b[2] + 1) * g.h) / 2)
        .setTranslation(g.lx((b[0] + b[3]) / 2), g.ly((b[1] + b[4]) / 2), g.lz((b[2] + b[5]) / 2));
    }
    desc.setMass(Math.max(0.05, this.mass)).setFriction(0.85).setRestitution(0.08);
    // Siblings of one split start apart (disjoint planar-cell hulls); for a few steps they are
    // kept from pushing each other anyway (solver groups: membership bit of the spawn event,
    // filter everything else), so a residual overlap cannot kick them apart.
    const sib = this.siblingBit();
    if (sib) {
      desc.setSolverGroups(groups(sib, 0xffff & ~sib));
      if (this.siblingSolverUntil < 0) this.siblingSolverUntil = this.bornAt + SIBLING_SOLVER_GRACE;
    }
    const fast = (linvel?.length() ?? 0) > 6;
    this.body = p.createDynamic({
      position: this.root.position,
      quaternion: this.root.quaternion,
      colliders: [desc],
      owner: this.owner,
      linvel,
      angvel,
      ccd: size < 0.3 && fast,
      contactForceThreshold: Math.max(50, this.mass * G * 8),
      small: size < 0.12,
      linearDamping: 0.03,
      angularDamping: 0.15,
    });
    this.hullVolume = this.grid.solidVolume();
    if (linvel) this.prevLin.copy(linvel);
    if (angvel) this.prevAng.copy(angvel);
    if (sleeping) this.body.sleep();
  }

  /** Solver-group bit of this piece's spawn event while the sibling window is open, else 0. */
  private siblingBit(): number {
    if (!this.spawnGroup || this.siblingSolverUntil === -2) return 0;
    if (this.siblingSolverUntil >= 0 && this.ctx.time.now >= this.siblingSolverUntil) return 0;
    return 1 << (4 + (this.spawnGroup % 12));
  }

  /** Close the sibling window: full solver contacts again. */
  private restoreSolverGroups(): void {
    this.siblingSolverUntil = -2;
    const b = this.body;
    if (!b) return;
    try {
      for (let i = 0; i < b.numColliders(); i++) b.collider(i).setSolverGroups(0xffffffff);
    } catch {
      /* world replaced */
    }
  }

  /**
   * Contact-gain limit. A light piece squeezed between heavy ones (a brick under a falling slab)
   * or started inside another collider is driven out by the solver at whatever speed resolves the
   * overlap — measured: 1–2 kg pieces of a collapsing roof left at 24–47 m/s. A collision cannot
   * do that: Newton's restitution law bounds the speed a light body leaves a heavy one with at
   * (1 + e)·V_other + e·v_own (V the other body's speed, e the restitution), and resting or
   * static neighbours (V ≈ 0) cannot launch anything. A gain beyond that bound (plus gravity) is
   * solver error and is removed; spin is bounded alike (ω·r ≤ the speed bound). Blasts and hits
   * push for real and are exempt for PUSH_GRACE.
   */
  private limitContactGain(dt: number): void {
    const b = this.body!;
    if (b.isSleeping()) return;
    const v = b.linvel();
    const s1 = Math.hypot(v.x, v.y, v.z), s0 = this.prevLin.length();
    const w = b.angvel();
    const w1 = Math.hypot(w.x, w.y, w.z), w0 = this.prevAng.length();
    const r = 0.5 * Math.cbrt(Math.max(1e-6, this.grid.solidVolume()));
    const free = s0 + G * dt + CONTACT_GAIN_SLACK;
    if (s1 <= free && w1 * r <= Math.max(w0 * r, free)) return;
    const now = this.ctx.time.now;
    if (now - this.pushedAt <= PUSH_GRACE || recentBlastNear(this.ctx, this.root.position, now)) return;
    let vOther = 0;
    try {
      this.ctx.physics.world.contactPairsWith(b.collider(0), (c2) => {
        const pb = c2.parent();
        if (!pb || !pb.isDynamic()) return;
        const u = pb.linvel();
        vOther = Math.max(vOther, Math.hypot(u.x, u.y, u.z));
      });
    } catch {
      return;
    }
    const cap = Math.max(free, (1 + CONTACT_RESTITUTION) * vOther + CONTACT_RESTITUTION * s0 + G * dt + CONTACT_GAIN_SLACK);
    if (s1 > cap) {
      const k = cap / s1;
      b.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
    }
    const wCap = Math.max(w0, cap / r);
    if (w1 > wCap) {
      const k = wCap / w1;
      b.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true);
    }
  }

  private syncFromBody(): void {
    const b = this.body;
    if (!b) return;
    const t = b.translation(), r = b.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    this.invQ.copy(this.root.quaternion).invert();
    this.updateBounds();
    if (!b.isSleeping() && !this.matrixDirty) {
      this.matrixDirty = true;
      this.look.batches.markDirty(this);
    }
  }

  private onContactForce(info: ContactForceInfo): void {
    if (!this.dynamic || this.disposed) return;
    const now = this.ctx.time.now;
    // Depenetration of a freshly cut piece (from its siblings, or from what is left of its parent)
    // is not a landing: no clatter, no secondary fracture.
    const age = now - this.bornAt;
    if (this.spawnGroup && age < SPAWN_SETTLE) return;
    const other = info.otherOwner?.destructible;
    if (this.spawnGroup && age < SIBLING_CONTACT_GRACE && other instanceof VoxelElement && other.spawnGroup === this.spawnGroup) return;
    // What the contact did to the body over this step: momentum change m·|Δv| and kinetic energy
    // lost ½m(v₀² − v₁²) (impulse–momentum; v₀ from the previous fixed step). Rapier's summed
    // contact-force magnitudes include penetration correction and friction and overstated the
    // energy of a gentle 8 cm settle about 25-fold, cracking resting rubble again and again.
    let impulse = info.totalForce * info.dt, dE = 0;
    const b = this.body;
    if (b) {
      const v = b.linvel(), p0 = this.prevLin;
      impulse = this.mass * Math.hypot(v.x - p0.x, v.y - p0.y, v.z - p0.z);
      dE = 0.5 * this.mass * Math.max(0, p0.lengthSq() - (v.x * v.x + v.y * v.y + v.z * v.z));
    }
    const size = Math.cbrt(Math.max(1e-6, this.grid.solidVolume()));
    if (impulse > 2 && now - this.lastContactEvent > 0.12) {
      this.lastContactEvent = now;
      this.ctx.events.emit('debrisContact', {
        time: now, position: (info.point ?? this.root.position).clone(), impulse, size, material: this.material,
      });
    }
    // Secondary fracture on hard landings: a crack across the piece needs G_F·A with
    // G_F = 73·f_cm^0.18 N/m (fib Model Code 2010, eq. 5.1-9), and only a few percent of the impact
    // energy goes into new crack surface (fragmentation efficiency, cf. Grady & Kipp 1985) — hence
    // the factor 25. A 20 cm C40 chunk splits landing at ≳ 4 m/s (≈ 0.8 m drop), larger ones lower.
    if (this.pendingSplit || size < 2 * MIN_PIECE_SIZE) return;
    const fcm = this.material.compressiveStrength / 1e6 + 8;
    const Gf = 73 * Math.pow(fcm, 0.18);
    // Past 60 % of the body budget landings only clatter: the remaining bodies are kept for new
    // failures (a blown-out wall alone throws 32 slabs that would otherwise cascade into ~700).
    if (dE > 25 * Gf * size * size && this.ctx.physics.dynamicCount < this.ctx.physics.maxDynamicBodies * 0.6) {
      this.pendingSplit = { point: (info.point ?? this.root.position).clone() };
    }
  }

  // ── Destructible: queries ─────────────────────────────────────────────────────────────────

  /**
   * `radius` is the round's radius: a hole or gap narrower than the round must stop it. Rounds of
   * at least 0.3 voxel radius (sub-voxel holes cannot be represented anyway, so small arms keep
   * the single ray) are traced as their centre line plus a ring of six parallel rays at 0.9 r;
   * the nearest material any of them meets is where the round's body strikes (the rim of a hole
   * smaller than the round, or the edge of one it passes off-centre).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius = 0): RayHit | null {
    if (this.disposed || this.grid.totalSolid === 0) return null;
    this.toLocal(origin, _v);
    this.toLocalDir(dir, _v2);
    const g = this.grid, box = this.sampleBox, rb = this.rebar;
    const dx = _v2.x, dy = _v2.y, dz = _v2.z;
    _best.t = Infinity;
    if (traceRay(g, box, rb, _v.x, _v.y, _v.z, dx, dy, dz, maxDist, _hit)) copyHit(_hit, _best);
    if (radius >= 0.3 * g.h) {
      // Ring basis: u ⟂ d, w = d × u.
      const hx = Math.abs(dy) < 0.9 ? 0 : 1, hy = 1 - hx;
      let ux = -dz * hy, uy = dz * hx, uz = dx * hy - dy * hx;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
      const rr = 0.9 * radius;
      for (let q = 0; q < 6; q++) {
        const c = Math.cos((q * Math.PI) / 3) * rr, sn = Math.sin((q * Math.PI) / 3) * rr;
        const ox = _v.x + ux * c + wx * sn, oy = _v.y + uy * c + wy * sn, oz = _v.z + uz * c + wz * sn;
        if (traceRay(g, box, rb, ox, oy, oz, dx, dy, dz, Math.min(maxDist, _best.t), _hit) && _hit.t < _best.t) copyHit(_hit, _best);
      }
    }
    if (!Number.isFinite(_best.t)) return null;
    const bar = _best.bar >= 0;
    return {
      target: this,
      point: this.toWorld(_best.x, _best.y, _best.z, new THREE.Vector3()),
      normal: this.toWorldDir(_best.nx, _best.ny, _best.nz, new THREE.Vector3()),
      distance: _best.t,
      material: bar ? REBAR : this.material,
      part: bar ? _best.bar : undefined,
    };
  }

  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    this.toLocal(hit.point, _v);
    this.toLocalDir(dir, _v2);
    _runs.length = 0;
    const exits = probeRun(this.grid, this.rebar, _v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z, maxDepth, _runs);
    const segments: ProbeSegment[] = _runs.map((r) => ({
      material: r.steel ? REBAR : this.material, start: r.start, end: r.end, strength: Math.min(1, Math.max(0.05, r.strength)),
    }));
    return { segments, exits };
  }

  // ── Destructible: impacts ─────────────────────────────────────────────────────────────────

  applyImpact(e: ImpactEvent): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const g = this.grid, h = g.h;
    const p = this.toLocal(e.point, new THREE.Vector3());
    const d = this.toLocalDir(e.direction, new THREE.Vector3()).normalize();
    const n = this.toLocalDir(e.normal, new THREE.Vector3()).normalize();
    this.lastImpact.copy(p);
    const seed = this.eventSeed++;
    this.carver.stats.reset();
    // Cone axis halfway between the shot line and the inward normal: brittle spall cones open
    // towards the free surface but lean with the projectile.
    const a = new THREE.Vector3().subVectors(d, n);
    if (a.lengthSq() < 1e-8) a.copy(d);
    a.normalize();
    // Front spall cones need a free surface: in the floor of an existing pit the surrounding walls
    // confine the material and the cone shrinks (the round still penetrates and crushes).
    const conf = this.confinement(p, Math.max(2 * e.craterRadius, 1.5 * h));
    const open = (1 - CONFINED_CRATER * conf) ** 2;
    // Representation correction: the density field rounds a cone's apex off by ~0.3 voxel and
    // shrinks craters under ~2 voxels across, so carve slightly deeper/wider to render the
    // resolved crater at its true size (measured on flat C40, see test/voxel-core.test.ts).
    const R0 = Math.max(0, e.craterRadius) * open;
    const R = R0 > 0 ? R0 + Math.max(0, 0.3 * h * (1 - R0 / (2 * h))) : 0;
    const cDepth = e.craterDepth > 0 ? e.craterDepth * open + 0.3 * h * open : 0;
    const crater: Roughness = { lobe: 0.2 * R, lobeScale: 0.7 * R + h, grain: Math.min(0.25 * h, 0.3 * R), seed };
    // A crater under two voxels across sits at the grid's resolution limit: centred between four
    // sample columns, every sample lies just outside the cone and the chip vanishes (measured:
    // M855 on C40 left a 7 mm dent there but 27 mm on a column). Centre such chips on the
    // nearest sample column of the face, a shift of at most 0.7 h (inside the chip's own radius),
    // so every round leaves the same, resolved mark.
    const cp = R < 2 * h ? this.snapToColumn(p, n, _vSnap) : p;
    if (R >= 0.6 * h && cDepth > 0) this.carver.cone(cp.x, cp.y, cp.z, a.x, a.y, a.z, R, cDepth, crater, 0.5 * (1 - conf));
    // A crater below voxel size cannot be carved faithfully (any cavity rounds up to ~one voxel):
    // record it as crushed material that crumbles out once damage saturates.
    else if (R > 0 && cDepth > 0) this.carver.damage(p.x + a.x * cDepth * 0.5, p.y + a.y * cDepth * 0.5, p.z + a.z * cDepth * 0.5, Math.max(h, 1.5 * R), SUBVOXEL_CRATER_DAMAGE * Math.min(1, (R * R * cDepth) / (h * h * h) * 6), seed);
    if (e.tunnelRadius > 0 && e.depth > e.craterDepth) {
      const L = e.depth;
      if (e.tunnelRadius >= 0.35 * h) {
        this.carver.capsule(p.x, p.y, p.z, p.x + d.x * L, p.y + d.y * L, p.z + d.z * L, e.tunnelRadius, { lobe: 0.3 * e.tunnelRadius, lobeScale: 4 * e.tunnelRadius + h, grain: 0.25 * h, seed: seed + 0.5 });
      } else {
        // A sub-voxel tunnel (small arms) is a thread of crushed material: damage, not a void.
        // Voxel-averaged, the crushed core (D = 1 within ~2 tunnel radii) is worth ΔD ≈ its
        // volume fraction of the voxel.
        const frac = Math.min(1, (Math.PI * (2 * e.tunnelRadius) ** 2) / (h * h)) * TUNNEL_DAMAGE;
        for (let s = cDepth; s <= L; s += h) this.carver.damage(p.x + d.x * s, p.y + d.y * s, p.z + d.z * s, 1.2 * h, frac, seed + s);
      }
    }
    // Rear spall (scab) crater at the exit face.
    let exit: THREE.Vector3 | null = null;
    if (e.spallRadius > 0 && e.spallDepth > 0) {
      if (e.exitPoint) exit = this.toLocal(e.exitPoint, new THREE.Vector3());
      else {
        _runs.length = 0;
        probeRun(g, null, p.x, p.y, p.z, d.x, d.y, d.z, 4, _runs);
        const end = _runs.length ? _runs[_runs.length - 1]!.end : 0;
        exit = p.clone().addScaledVector(d, end);
      }
      const Rs = e.spallRadius;
      this.carver.cone(exit.x, exit.y, exit.z, -d.x, -d.y, -d.z, Rs, e.spallDepth, { lobe: 0.3 * Rs, lobeScale: 0.6 * Rs + h, grain: 0.6 * h, seed: seed + 0.25 });
    }
    // Continuum damage: micro-cracked zone around the crater bottom; saturated rubble crumbles out.
    if (e.damageRadius > 0) {
      const cd = Math.min(e.depth, Math.max(e.craterDepth, 0.5 * e.depth));
      const cx = p.x + d.x * cd * 0.6, cy = p.y + d.y * cd * 0.6, cz = p.z + d.z * cd * 0.6;
      this.carver.damage(cx, cy, cz, e.damageRadius, IMPACT_DAMAGE_PEAK, seed);
      if (exit && e.spallRadius > 0) this.carver.damage(exit.x, exit.y, exit.z, e.spallRadius * 1.5, IMPACT_DAMAGE_PEAK * 0.7, seed + 3);
      const st = this.carver.stats;
      this.carver.crumble(st.i0, st.j0, st.k0, st.i1, st.j1, st.k1);
    }
    this.cleanCarved();
    // Rebar struck by the penetrator: notch (area loss), cut past 80 %.
    let barHit: THREE.Vector3 | null = null;
    if (this.rebar) barHit = this.nickBars(p, d, e);
    this.stats.lastCarveMs = performance.now() - t0;
    const removed = this.carver.stats.removed;
    this.afterMaterialLoss(removed > 0 || e.damageRadius > 0);
    this.impactFx(e, removed, barHit);
    if (this.body && this.dynamic) {
      this.pushedAt = this.ctx.time.now;
      try {
        this.ctx.physics.applyImpulseAt(this.body, e.momentum, e.point);
      } catch {
        /* body gone */
      }
    }
  }

  /**
   * The surface point over the sample column nearest to local point p: the two coordinates across
   * the dominant normal axis snap to the lattice, then a short ray along −n finds the surface.
   * Returns p itself when no surface is found within ±1.5 voxels.
   */
  private snapToColumn(p: THREE.Vector3, n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const g = this.grid, h = g.h;
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    const t = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const x = t === 0 ? p.x : g.ox + Math.round(g.gx(p.x)) * h;
    const y = t === 1 ? p.y : g.oy + Math.round(g.gy(p.y)) * h;
    const z = t === 2 ? p.z : g.oz + Math.round(g.gz(p.z)) * h;
    const s = 1.5 * h;
    if (traceRay(g, this.sampleBox, null, x + n.x * s, y + n.y * s, z + n.z * s, -n.x, -n.y, -n.z, 2 * s, _hit)) return out.set(_hit.x, _hit.y, _hit.z);
    return p;
  }

  /** Remove thin slivers where material was removed by the last operations. */
  private cleanCarved(): void {
    const st = this.carver.stats;
    if (st.ci1 < st.ci0) return;
    this.carver.cleanSlivers(st.ci0 - 1, st.cj0 - 1, st.ck0 - 1, st.ci1 + 1, st.cj1 + 1, st.ck1 + 1);
  }

  /**
   * Confinement of a surface point, 0 (flat face or convex edge) … 1 (floor of a narrow pit): the
   * solid fraction of 26 points on a sphere of radius r around it, mapped from 0.5 → 0 to 0.9 → 1.
   */
  private confinement(p: THREE.Vector3, r: number): number {
    const g = this.grid;
    let solid = 0, n = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy && !dz) continue;
          const l = r / Math.hypot(dx, dy, dz);
          n++;
          // Soft count: a point on the surface itself (density ≈ iso) counts one half.
          const d = g.densityAt(g.gx(p.x + dx * l), g.gy(p.y + dy * l), g.gz(p.z + dz * l));
          solid += Math.min(1, Math.max(0, (d - 64) / 128));
        }
    return Math.min(1, Math.max(0, (solid / n - 0.5) / 0.4));
  }

  /**
   * Bars within reach of the penetration path lose cross-section. Removed steel volume from the
   * specific cutting energy of carbon steel, u ≈ 3 J/mm³ (Kalpakjian & Schmid, Manufacturing
   * Engineering and Technology, specific-energy table for turning, 2.7–9.3 W·s/mm³), times the
   * fraction of the projectile's energy that goes into the bar (lead-core ball splashes: 0.15;
   * hardened AP cores: 0.6; long rods, jets and fragments: 1).
   */
  private nickBars(p: THREE.Vector3, d: THREE.Vector3, e: ImpactEvent): THREE.Vector3 | null {
    const rb = this.rebar!;
    const reachEnd = e.depth + 0.03;
    const ex = p.x + d.x * reachEnd, ey = p.y + d.y * reachEnd, ez = p.z + d.z * reachEnd;
    const list: number[] = [];
    const pad = 0.05;
    rb.query(this.grid, Math.min(p.x, ex) - pad, Math.min(p.y, ey) - pad, Math.min(p.z, ez) - pad, Math.max(p.x, ex) + pad, Math.max(p.y, ey) + pad, Math.max(p.z, ez) + pad, list);
    const k = e.ammo.kind;
    // Lead-core ball flattens on a bar and barely nicks it (FM 3-06.11: 5.56 mm does not cut
    // reinforcing bars), so it gets a low efficiency and cannot take a bar below 60 % of its area.
    const softBall = k === 'ball' && e.ammo.deformable;
    const eff = k === 'ball' ? (softBall ? 0.03 : 0.35) : k === 'ap' ? 0.6 : 1.0;
    const uc = 3e9; // J/m³
    let hitPoint: THREE.Vector3 | null = null;
    for (const s of list) {
      if (!rb.alive(s)) continue;
      const n = rb.nodes, a = rb.segA[s]! * 3, b = rb.segB[s]! * 3;
      const r = rb.radius(s);
      const reach = Math.max(e.tunnelRadius, e.ammo.diameter / 2) + r + 0.002;
      const d2 = segSegDist2(p.x, p.y, p.z, ex, ey, ez, n[a]!, n[a + 1]!, n[a + 2]!, n[b]!, n[b + 1]!, n[b + 2]!);
      if (d2 > reach * reach) continue;
      const width = Math.max(e.ammo.diameter, 2 * e.tunnelRadius, 0.004);
      const vol = (eff * e.kineticEnergy) / uc;
      const area0 = Math.PI * rb.segR[s]! ** 2;
      let frac = Math.min(1, vol / width / area0);
      if (softBall) frac = Math.min(frac, Math.max(0, rb.segArea[s]! - 0.6));
      rb.nick(s, frac, this.ctx.rng.range(-1, 1));
      hitPoint = new THREE.Vector3((n[a]! + n[b]!) / 2, (n[a + 1]! + n[b + 1]!) / 2, (n[a + 2]! + n[b + 2]!) / 2);
      break;
    }
    return hitPoint;
  }

  private impactFx(e: ImpactEvent, removed: number, barHit: THREE.Vector3 | null): void {
    const fx = this.ctx.fx;
    const wp = e.point;
    const wn = e.normal;
    const mass = removed * this.material.density;
    if (removed > 0) {
      const chipSize = Math.min(0.03, Math.max(0.003, 0.3 * e.craterRadius));
      const count = Math.max(2, Math.min(40, Math.round(removed / (chipSize * chipSize * chipSize) * 0.08)));
      fx.chips({ position: wp, direction: wn, spread: 0.7, speed: 6 + Math.sqrt(Math.max(0, e.kineticEnergy)) * 0.2, count, size: chipSize, color: this.material.color, kind: 'stone' });
      fx.dust({ position: wp, velocity: _v.copy(wn).multiplyScalar(1.5), radius: Math.max(0.05, e.craterRadius * 2.5), amount: Math.min(5, Math.sqrt(mass) * 2), color: this.material.dustColor });
    }
    if (barHit || e.material.id === 'rebar_b500') {
      fx.sparks({ position: wp, direction: wn, count: 12, speed: 25, hot: 1 });
    }
  }

  // ── Destructible: blasts ──────────────────────────────────────────────────────────────────

  applyBlast(load: BlastLoad): void {
    if (this.disposed || this.grid.totalSolid === 0) return;
    // The BlastSystem pushes this piece's body in the same step (contact-gain limit exemption).
    if (this.dynamic) this.pushedAt = this.ctx.time.now;
    const t0 = performance.now();
    const g = this.grid, h = g.h;
    const c = this.toLocal(load.center, new THREE.Vector3());
    this.carver.stats.reset();
    const seed = this.eventSeed++;
    const W = Math.max(1e-3, load.tntKg);
    // Nearest solid surface point within ~0.35 m of the charge.
    const near = this.nearestSurface(c, 0.35);
    const contact = load.contactTargetId === this.id || (near !== null && near.dist < 0.3);
    let thickness = this.shape.thickness;
    if (contact && near) {
      const nOut = load.normal ? this.toLocalDir(load.normal, new THREE.Vector3()).normalize() : near.normal;
      // Surface point under the charge along the normal.
      const s = near.point;
      const inward = nOut.clone().negate();
      _runs.length = 0;
      probeRun(g, null, s.x, s.y, s.z, inward.x, inward.y, inward.z, 6, _runs);
      thickness = _runs.length ? Math.max(h, _runs[_runs.length - 1]!.end) : this.shape.thickness;
      const cd = load.contactDamage(this.material, thickness);
      this.realiseContact(load, s, inward, thickness, cd, seed);
      this.lastImpact.copy(s);
      this.blastAxis = inward;
    } else {
      thickness = this.blastPatches(load, c, seed);
      this.lastImpact.copy(near ? near.point : c);
    }
    // Soot where the fireball licks the surface: dense within ~0.5·W^⅓ m, streaking out towards
    // the fireball radius (≈ 1.6·W^⅓ m for condensed HE, cf. Baker et al. 1983, "Explosion
    // hazards and evaluation"); only surfaces facing the charge.
    const Rs = (contact ? 0.7 : 1.0) * Math.cbrt(W);
    this.carver.sootSplat(c.x, c.y, c.z, Rs, 0.95, seed);
    const barsMoved = this.rebar && this.grid.totalSolid > 0 && this.barsMayBend(load) ? this.bendBars(load, c) : false;
    this.blastAxis = null;
    this.pendingBlast = { load, thickness, until: this.ctx.time.now + 0.5 };
    this.stats.lastCarveMs = performance.now() - t0;
    // Supports only need re-checking when material or bars actually moved; cracking and soot
    // alone just remesh. The static collider must lose the blown-out material now: the thrown
    // plug is flying through it this very step.
    const released = this.panelReleased;
    this.panelReleased = false;
    if (this.carver.stats.removed > 0 || barsMoved || released) {
      this.refreshOccupancy();
      this.afterMaterialLoss(true, 0.02);
    } else this.flushDirty();
    // A loose piece is pushed as a rigid body by the BlastSystem (DESIGN.md §1, step 6), which
    // does that for every dynamic body in range; pushing it here as well would double the impulse.
  }

  /** Closest solid surface point to local point c within `radius` (sample search), or null. */
  private nearestSurface(c: THREE.Vector3, radius: number): { point: THREE.Vector3; normal: THREE.Vector3; dist: number } | null {
    const g = this.grid;
    const i0 = Math.max(0, Math.floor(g.gx(c.x - radius))), i1 = Math.min(g.nx - 1, Math.ceil(g.gx(c.x + radius)));
    const j0 = Math.max(0, Math.floor(g.gy(c.y - radius))), j1 = Math.min(g.ny - 1, Math.ceil(g.gy(c.y + radius)));
    const k0 = Math.max(0, Math.floor(g.gz(c.z - radius))), k1 = Math.min(g.nz - 1, Math.ceil(g.gz(c.z + radius)));
    let best = Infinity, bi = -1, bj = -1, bk = -1;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          if (g.density(i, j, k) < ISO) continue;
          const dx = g.lx(i) - c.x, dy = g.ly(j) - c.y, dz = g.lz(k) - c.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best) { best = d2; bi = i; bj = j; bk = k; }
        }
    if (bi < 0) return null;
    const normal = new THREE.Vector3();
    g.normalAt(bi, bj, bk, normal);
    // March from the charge towards the sample to land on the iso surface.
    const target = new THREE.Vector3(g.lx(bi), g.ly(bj), g.lz(bk));
    const dir = target.clone().sub(c);
    const L = dir.length();
    let point = target;
    if (L > 1e-6) {
      dir.divideScalar(L);
      if (traceRay(g, this.sampleBox, null, c.x, c.y, c.z, dir.x, dir.y, dir.z, L + g.h, _hit)) {
        point = new THREE.Vector3(_hit.x, _hit.y, _hit.z);
        normal.set(_hit.nx, _hit.ny, _hit.nz);
      }
    }
    return { point, normal, dist: Math.max(0, Math.sqrt(best) - 0.5 * g.h) };
  }

  /**
   * Contact / near-contact charge: front crater, breach (a ragged through-hole whose plug is
   * thrown out of the rear face as debris), rear scab, heavy damage around, bars in the hole cut.
   */
  private realiseContact(load: BlastLoad, s: THREE.Vector3, a: THREE.Vector3, t: number, cd: ContactDamage, seed: number): void {
    const g = this.grid, h = g.h;
    const Rc = Math.max(cd.craterRadius, h);
    // Throw the breach plug / scab as pieces before carving the crater.
    if (cd.breach && cd.breachRadius > 0) {
      const Rb = cd.breachRadius;
      const len = t + 0.1;
      const lobe = 0.25 * Rb;
      const sel = this.cylinderSelection(s.x - a.x * 0.05, s.y - a.y * 0.05, s.z - a.z * 0.05, a, len + 0.05, Rb, lobe, seed);
      const v = Math.max(8, cd.spallVelocity);
      this.throwSelection(sel, Math.PI * Rb * Rb * t, a, v, s, seed);
    } else if (cd.spallRadius > 0 && cd.spallDepth > 0) {
      const rear = s.clone().addScaledVector(a, t);
      const sel = this.coneSelection(rear, a.clone().negate(), cd.spallRadius, cd.spallDepth, seed);
      this.throwSelection(sel, (Math.PI * cd.spallRadius * cd.spallRadius * cd.spallDepth) / 3, a, Math.max(3, cd.spallVelocity), s, seed + 1);
    }
    this.carver.cone(s.x, s.y, s.z, a.x, a.y, a.z, Rc * 1.05, Math.max(h, cd.craterDepth), { lobe: 0.22 * Rc, lobeScale: 0.5 * Rc + h, grain: 0.8 * h, seed });
    if (cd.breach && cd.breachRadius > 0) {
      const Rb = cd.breachRadius;
      this.carver.cylinder(s.x - a.x * 0.05, s.y - a.y * 0.05, s.z - a.z * 0.05, a.x, a.y, a.z, t + 0.15, Rb, { lobe: 0.22 * Rb, lobeScale: 0.45 * Rb + h, grain: 0.8 * h, seed: seed + 2 });
    }
    if (cd.spallRadius > 0 && cd.spallDepth > 0) {
      const rear = s.clone().addScaledVector(a, t);
      this.carver.cone(rear.x, rear.y, rear.z, -a.x, -a.y, -a.z, cd.spallRadius, cd.spallDepth, { lobe: 0.28 * cd.spallRadius, lobeScale: 0.5 * cd.spallRadius + h, grain: 0.8 * h, seed: seed + 3 });
    }
    const Rd = Math.max(Rc, cd.breachRadius, cd.spallRadius) * 1.6;
    const mid = s.clone().addScaledVector(a, t * 0.5);
    this.carver.damage(mid.x, mid.y, mid.z, Rd, 0.9, seed);
    const st = this.carver.stats;
    this.carver.crumble(st.i0, st.j0, st.k0, st.i1, st.j1, st.k1);
    this.cleanCarved();
    // Bars through the breach are cut near its centre (shock + fragments), nicked further out.
    if (this.rebar && (cd.breach || cd.craterDepth > 0.5 * t)) {
      const rb = this.rebar;
      const Rb = Math.max(cd.breachRadius, 0.5 * Rc);
      const list: number[] = [];
      rb.query(g, s.x - Rb - 0.1, s.y - Rb - 0.1, s.z - Rb - 0.1, s.x + Rb + 0.1, s.y + Rb + 0.1, s.z + Rb + 0.1, list);
      const ex = s.x + a.x * t, ey = s.y + a.y * t, ez = s.z + a.z * t;
      for (const sg of list) {
        const n = rb.nodes, na = rb.segA[sg]! * 3, nb = rb.segB[sg]! * 3;
        const d = Math.sqrt(segSegDist2(s.x, s.y, s.z, ex, ey, ez, n[na]!, n[na + 1]!, n[na + 2]!, n[nb]!, n[nb + 1]!, n[nb + 2]!));
        if (d < 0.45 * Rb) rb.nick(sg, 1, this.ctx.rng.range(-1, 1));
        else if (d < Rb) rb.nick(sg, 0.4 * (1 - d / Rb), this.ctx.rng.range(-1, 1));
      }
    }
    const fx = this.ctx.fx;
    const wp = this.toWorld(s.x, s.y, s.z, new THREE.Vector3());
    const wa = this.toWorldDir(a.x, a.y, a.z, new THREE.Vector3());
    const removed = st.removed;
    void load;
    fx.dust({ position: wp, velocity: wa.clone().multiplyScalar(-3), radius: Math.max(0.3, Rc * 3), amount: Math.min(5, 0.5 + removed * 40), color: this.material.dustColor });
    fx.chips({ position: wp, direction: wa.clone().negate(), spread: 1.0, speed: 25, count: 40, size: 0.02, color: this.material.color, kind: 'stone' });
    if (cd.spallRadius > 0 || cd.breach) {
      const rw = this.toWorld(s.x + a.x * t, s.y + a.y * t, s.z + a.z * t, new THREE.Vector3());
      fx.chips({ position: rw, direction: wa, spread: 0.7, speed: Math.max(5, cd.spallVelocity), count: 50, size: 0.025, color: this.material.color, kind: 'stone' });
      fx.dust({ position: rw, velocity: wa.clone().multiplyScalar(4), radius: Math.max(0.3, cd.spallRadius * 2), amount: 2, color: this.material.dustColor });
    }
  }

  /**
   * Free-field blast on a stand-off element: sample the surface patches that face the charge and
   * turn load.damageAt (P–I damage number) into per-patch micro-cracking, face erosion, rear
   * scabbing and, at ≥ 2, local breaching with the plug thrown by the reflected impulse.
   * Returns the typical thickness met.
   */
  private blastPatches(load: BlastLoad, c: THREE.Vector3, seed: number): number {
    // Upper bound for the whole element: the load at its nearest point, on a face turned to the
    // charge, at half its thickness (P–I damage grows as the member thins). Below the onset of
    // cracking used per patch there is nothing to realise, so skip the scan (a charge loads every
    // element within tens of metres). The nearest point is taken on the element's own (oriented)
    // material box: the world AABB of a rotated wall reaches metres closer to the charge than
    // the wall does.
    const member = this.memberInfo();
    const near = this.nearestBoxPoint(c, new THREE.Vector3());
    const facing = new THREE.Vector3().copy(load.center).sub(near);
    const d0 = facing.length();
    const tRef = 0.5 * this.shape.thickness;
    if (d0 > 1e-3) {
      facing.divideScalar(d0);
      if (load.overpressureAt(near) < 15e3 || load.damageAt(near, facing, this.material, tRef, member) < 1) return this.shape.thickness;
    } else facing.set(0, 1, 0);
    // Reach of the load: the distance out to which a face turned to the charge, at the same
    // reference thickness, still sees ≥ 15 kPa and a damage number ≥ 1 (both fall monotonically
    // with distance). Only patches inside that sphere can be realised, so the scan is bounded by
    // it instead of evaluating the Kingery–Bulmash fits at every patch of every element in range
    // (measured: 1.0–1.6 s of realisation per 2.3 kg charge among the pavilion's elements, most
    // of it in the fits). The test face must be turned *towards* the charge (normal = −away):
    // a face turned away sees neither the reflection nor the gas pressure of a confined charge,
    // which shrank the reach of a 12 kg charge in the chapel to ~3 m and left walls 5 m away
    // untouched under a damage number of 2.3.
    // A panel loaded to damage ≥ 2 over most of its face fails as a whole: decided on a coarse
    // sample of the face, without the patch scan and crack field the pieces would carry away.
    if (this.wholePanelLoaded(load, c, member)) {
      this.panelFailure(load, c, [], 0, true, seed);
      return this.shape.thickness;
    }
    const away = facing.clone().negate();
    const reach = blastReach(load, away, (q) => load.overpressureAt(q) >= 15e3 && load.damageAt(q, facing, this.material, tRef, member) >= 1, Math.max(d0, 1e-3));
    const g = this.grid, h = g.h, conn = this.conn;
    const F = conn.F;
    // Coarse surface patches (~10 cm) facing the charge; coarser when the sphere of reach would
    // hold more than MAX_BLAST_PATCHES of them (very large charges), so the work stays bounded.
    let P = Math.max(1, Math.round(0.1 / (F * h)));
    const span = (lo: number, hi: number, n: number, cell: number) => Math.max(0, Math.min(n - 1, Math.ceil(hi / cell)) - Math.max(0, Math.floor(lo / cell)) + 1);
    const R0 = reach + 1.6 * F * h * P;
    const cellsIn = (Pp: number) => {
      const cs = F * h * Pp;
      return span(c.x - R0 - g.ox, c.x + R0 - g.ox, Math.ceil(conn.nx / Pp), cs) * span(c.y - R0 - g.oy, c.y + R0 - g.oy, Math.ceil(conn.ny / Pp), cs) * span(c.z - R0 - g.oz, c.z + R0 - g.oz, Math.ceil(conn.nz / Pp), cs);
    };
    const count = cellsIn(P);
    if (count > MAX_BLAST_PATCHES) P = Math.ceil(P * Math.cbrt(count / MAX_BLAST_PATCHES));
    const cellSize = F * h * P;
    const nx = Math.ceil(conn.nx / P), ny = Math.ceil(conn.ny / P), nz = Math.ceil(conn.nz / P);
    // Patches whose centre can lie within reach of the charge (the facing surface point is found
    // within ~1.5 patch sizes of the centre).
    const Rm = reach + 1.6 * cellSize;
    const Rm2 = Rm * Rm;
    const cell = (v: number, o: number) => (v - o) / cellSize - 0.5;
    const I0 = Math.max(0, Math.floor(cell(c.x - Rm, g.ox))), I1 = Math.min(nx - 1, Math.ceil(cell(c.x + Rm, g.ox)));
    const J0 = Math.max(0, Math.floor(cell(c.y - Rm, g.oy))), J1 = Math.min(ny - 1, Math.ceil(cell(c.y + Rm, g.oy)));
    const K0 = Math.max(0, Math.floor(cell(c.z - Rm, g.oz))), K1 = Math.min(nz - 1, Math.ceil(cell(c.z + Rm, g.oz)));
    const wp = new THREE.Vector3(), wn = new THREE.Vector3(), n = new THREE.Vector3(), pc = new THREE.Vector3();
    let tSum = 0, tN = 0;
    const breaches: { p: THREE.Vector3; a: THREE.Vector3; t: number; r: number; v: number }[] = [];
    // Patches at damage ≥ 2 (local surface point, inward axis, thickness) for the flexural check.
    const severe: number[] = [];
    // Damage splats (x, y, z, R, peak), applied together after the scan.
    const splats: number[] = [];
    for (let K = K0; K <= K1; K++)
      for (let J = J0; J <= J1; J++)
        for (let I = I0; I <= I1; I++) {
          // Patch centre sample.
          const si = Math.min(g.nx - 1, Math.round((I + 0.5) * P * F)), sj = Math.min(g.ny - 1, Math.round((J + 0.5) * P * F)), sk = Math.min(g.nz - 1, Math.round((K + 0.5) * P * F));
          pc.set(g.lx(si), g.ly(sj), g.lz(sk));
          // Is there a surface in this patch? Look for a solid sample with an air neighbour towards the charge.
          const toC = _v.copy(c).sub(pc);
          const d2 = toC.lengthSq();
          if (d2 > Rm2) continue;
          const dist = Math.sqrt(d2);
          if (dist < 1e-6) continue;
          toC.divideScalar(dist);
          // Trace from the charge side to the patch to find its facing surface.
          const start = _v2.copy(pc).addScaledVector(toC, cellSize);
          if (g.densityAt(g.gx(start.x), g.gy(start.y), g.gz(start.z)) >= ISO) continue;
          if (!traceRay(g, this.sampleBox, null, start.x, start.y, start.z, -toC.x, -toC.y, -toC.z, cellSize * 1.5, _hit)) continue;
          n.set(_hit.nx, _hit.ny, _hit.nz);
          if (n.dot(toC) < 0.1) continue;
          const sp = new THREE.Vector3(_hit.x, _hit.y, _hit.z);
          this.toWorld(sp.x, sp.y, sp.z, wp);
          this.toWorldDir(n.x, n.y, n.z, wn);
          if (load.overpressureAt(wp) < 15e3) continue;
          _runs.length = 0;
          probeRun(g, null, sp.x, sp.y, sp.z, -n.x, -n.y, -n.z, 3, _runs);
          const t = _runs.length ? Math.max(h, _runs[_runs.length - 1]!.end) : this.shape.thickness;
          tSum += t;
          tN++;
          // P–I damage number (contract: < 1 none, 1 onset of cracking, ≥ 2 severe / breach).
          const dmg = load.damageAt(wp, wn, this.material, t, member);
          if (dmg < 1) continue;
          const r = cellSize * 0.75;
          const s2 = seed + (I * 7 + J * 13 + K * 17) * 0.01;
          // Flexural cracking through the section, growing from the onset at 1.
          const dPeak = Math.min(0.85, 0.2 + 0.45 * (dmg - 1));
          splats.push(sp.x - n.x * 0.5 * t, sp.y - n.y * 0.5 * t, sp.z - n.z * 0.5 * t, Math.max(r * 1.6, 0.6 * t), dPeak);
          if (dmg >= 1.5 && dmg < 2) {
            // Approaching breach: the rear face scabs (tension spall) in patches that grow and
            // join towards the breach threshold, and the front surface flakes. Scabs thinner than
            // a voxel stay as damage (shading) only.
            const f = (dmg - 1.5) / 0.5;
            const rearD = 0.3 * t * f, frontD = 0.08 * t * f;
            if (rearD >= 0.75 * h && this.ctx.rng.range(0, 1) < 0.35 + 0.65 * f) {
              const rx = sp.x - n.x * t, ry = sp.y - n.y * t, rz = sp.z - n.z * t;
              this.carver.cone(rx, ry, rz, n.x, n.y, n.z, r * 1.2, rearD, { lobe: 0.3 * r, lobeScale: 0.6 * r, grain: 0.8 * h, seed: s2 + 1 });
            }
            if (frontD >= 0.75 * h) this.carver.cone(sp.x, sp.y, sp.z, -n.x, -n.y, -n.z, r, frontD, { lobe: 0.3 * r, lobeScale: 0.6 * r, grain: 0.6 * h, seed: s2 });
          }
          if (dmg >= 2) {
            // Rigid-plastic plug velocity from the reflected impulse: v = i_r / (ρ t).
            const ir = load.reflectedImpulseAt(wp, wn);
            const v = Math.min(80, ir / (this.material.density * t));
            breaches.push({ p: sp, a: n.clone().negate(), t, r, v });
            severe.push(sp.x, sp.y, sp.z, -n.x, -n.y, -n.z, t);
          }
        }
    // Flexural cracking of the whole loaded face in one pass; a repeated blast of similar strength
    // extends the existing crack field only a little (see Carver.damage).
    this.carver.damageBatch(splats, splats.length / 5, seed, BLAST_DAMAGE_ACCUMULATION);
    // Global flexural failure: when the severe patches cover most of the panel (or a region at
    // least half a span across), the member does not punch out in 10 cm plugs — it fails along
    // yield lines as a whole and is thrown off in large slabs (see panelFailure).
    const severeArea = (severe.length / 7) * cellSize * cellSize;
    const [e0, e1] = this.panelExtents();
    const faceArea = e0 * e1;
    const whole = severeArea >= PANEL_FAILURE_SHARE * faceArea;
    if (whole || severeArea >= PANEL_REGION_SPANS * (member.span ?? 3) ** 2) {
      const st0 = this.carver.stats;
      if (!st0.empty) this.carver.crumble(st0.i0, st0.j0, st0.k0, st0.i1, st0.j1, st0.k1);
      this.panelFailure(load, c, severe, cellSize, whole, seed);
      breaches.length = 0;
    }
    // Breached patches: throw a few plugs as pieces, pulverise the rest.
    breaches.sort((x, y) => y.v - x.v);
    for (let q = 0; q < breaches.length; q++) {
      const b = breaches[q]!;
      if (q < 8) {
        const sel = this.cylinderSelection(b.p.x - b.a.x * 0.02, b.p.y - b.a.y * 0.02, b.p.z - b.a.z * 0.02, b.a, b.t + 0.04, b.r, 0.25 * b.r, seed + q);
        this.throwSelection(sel, Math.PI * b.r * b.r * b.t, b.a, b.v, c, seed + q);
      }
      this.carver.cylinder(b.p.x - b.a.x * 0.02, b.p.y - b.a.y * 0.02, b.p.z - b.a.z * 0.02, b.a.x, b.a.y, b.a.z, b.t + 0.06, b.r * 1.05, { lobe: 0.3 * b.r, lobeScale: 0.5 * b.r, grain: h, seed: seed + q + 0.5 });
    }
    const st = this.carver.stats;
    if (!st.empty) {
      this.carver.crumble(st.i0, st.j0, st.k0, st.i1, st.j1, st.k1);
      this.cleanCarved();
    }
    if (st.removed > 0) {
      const cw = this.toWorld(this.lastImpact.x, this.lastImpact.y, this.lastImpact.z, new THREE.Vector3());
      this.ctx.fx.dust({ position: cw, radius: 0.6, amount: Math.min(5, st.removed * 30), color: this.material.dustColor });
    }
    return tN ? tSum / tN : this.shape.thickness;
  }

  /**
   * Coarse whole-panel test for box members: 12 × 12 points on the face turned to the charge
   * (just inside it, so holes already shot through do not count as loaded material). True when
   * at least PANEL_FAILURE_SHARE of the face is still there and loaded to damage ≥ 2.
   */
  private wholePanelLoaded(load: BlastLoad, c: THREE.Vector3, member: MemberInfo): boolean {
    if (!(this.shape instanceof BoxShape)) return false;
    const g = this.grid, half = this.shape.half, ta = this.thicknessAxis();
    const a = (ta + 1) % 3, b = (ta + 2) % 3;
    const side = c.getComponent(ta) >= 0 ? 1 : -1;
    const N = 12;
    const p = new THREE.Vector3(), wp = new THREE.Vector3(), wn = new THREE.Vector3();
    p.set(0, 0, 0).setComponent(ta, side);
    this.toWorldDir(p.x, p.y, p.z, wn);
    let sev = 0;
    for (let u = 0; u < N; u++)
      for (let v = 0; v < N; v++) {
        p.setComponent(a, -half[a]! + ((u + 0.5) / N) * 2 * half[a]!);
        p.setComponent(b, -half[b]! + ((v + 0.5) / N) * 2 * half[b]!);
        p.setComponent(ta, side * (half[ta]! - 0.75 * g.h));
        if (g.densityAt(g.gx(p.x), g.gy(p.y), g.gz(p.z)) < ISO) continue;
        p.setComponent(ta, side * half[ta]!);
        this.toWorld(p.x, p.y, p.z, wp);
        if (load.damageAt(wp, wn, this.material, this.shape.thickness, member) >= 2) sev++;
      }
    return sev >= PANEL_FAILURE_SHARE * N * N;
  }

  /** Nearest point of the element's (oriented) material box to local point c, in world space. */
  private nearestBoxPoint(c: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const g = this.grid, b = this.sampleBox, e = 0.5 * g.h;
    const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    return this.toWorld(cl(c.x, g.lx(b[0]) - e, g.lx(b[3]) + e), cl(c.y, g.ly(b[1]) - e, g.ly(b[4]) + e), cl(c.z, g.lz(b[2]) - e, g.lz(b[5]) + e), out);
  }

  /** Local axis through the member's thickness (the smallest extent). */
  private thicknessAxis(): number {
    const [hx, hy, hz] = this.shape.half;
    return hx <= hy && hx <= hz ? 0 : hy <= hz ? 1 : 2;
  }

  /** The two in-plane extents of the member (across its thickness axis), m. */
  private panelExtents(): [number, number] {
    const ta = this.thicknessAxis(), half = this.shape.half;
    const a = (ta + 1) % 3, b = (ta + 2) % 3;
    return [2 * half[a]!, 2 * half[b]!];
  }

  /**
   * Local axis along which the member spans: walls and columns (thickness axis horizontal) bend
   * over their height, slabs (thickness axis vertical) over their shorter plan dimension.
   */
  private spanAxis(): number {
    const ta = this.thicknessAxis(), half = this.shape.half;
    const a = (ta + 1) % 3, b = (ta + 2) % 3;
    const up = _v.copy(UP).applyQuaternion(this.invQ);
    const u = [Math.abs(up.x), Math.abs(up.y), Math.abs(up.z)];
    if (u[ta]! > 0.7) return half[a]! <= half[b]! ? a : b;
    return u[a]! >= u[b]! ? a : b;
  }

  /**
   * The loaded member for the P–I damage number (BlastLoad.damageAt): reinforcement ratio per
   * face ρ = A_s / (b·d) of its RebarSpec (A_s = π d_b²/4 per bar spacing s, effective depth
   * d = t − cover − d_b/2; a central mesh works at d = t/2 — EN 1992-1-1 notation) and the span
   * it bends over. Unreinforced elements report ρ = 0.
   */
  private memberInfo(): MemberInfo {
    const t = this.shape.thickness;
    const r = this.spec.rebar;
    let rho = 0;
    if (r) {
      const d = r.layout === 'center' ? 0.5 * t : Math.max(0.5 * t, t - r.cover - 0.5 * r.diameter);
      rho = (Math.PI * r.diameter * r.diameter) / 4 / (r.spacing * d);
    }
    return { reinforcementRatio: rho, span: 2 * this.shape.half[this.spanAxis()]! };
  }

  /**
   * Global flexural failure of a blast-loaded panel (damage ≥ 2 over most of its face, or over a
   * region at least half a span across): the loaded region breaks along yield lines into large
   * Voronoi slabs that go through the whole thickness, each thrown away from the charge at the
   * rigid-plastic velocity of the impulsively loaded plate, v = i_r / (ρ t) (momentum balance,
   * resistance neglected — an upper bound, cf. Baker et al. 1983, "Explosion Hazards and
   * Evaluation", ch. 6 on fragments of frangible walls), shaped by the transverse velocity field
   * of a rigid-plastic mechanism hinged at the held edges (Jones, "Structural Impact", 1989,
   * ch. 3): slow at a support, fastest mid-span or at a free edge. `severe` holds the damage ≥ 2
   * patches (local surface point, inward axis, thickness) of blastPatches.
   */
  private panelFailure(load: BlastLoad, c: THREE.Vector3, severe: number[], cellSize: number, whole: boolean, seed: number): void {
    const t0 = performance.now();
    const g = this.grid, conn = this.conn, F = conn.F, h = g.h;
    this.refreshOccupancy();
    const mask = new Uint8Array(conn.n);
    if (whole) {
      for (let q = 0; q < conn.n; q++) if (conn.count[q]) mask[q] = 1;
    } else {
      // Through the thickness under every severe patch, widened by a patch: the yield lines run
      // just outside the loaded region.
      const step = 0.5 * F * h, r = cellSize;
      for (let s = 0; s < severe.length; s += 7) {
        const px = severe[s]!, py = severe[s + 1]!, pz = severe[s + 2]!, ax = severe[s + 3]!, ay = severe[s + 4]!, az = severe[s + 5]!, t = severe[s + 6]!;
        for (let d = 0; d <= t + step; d += step) {
          const x = px + ax * d, y = py + ay * d, z = pz + az * d;
          conn.markBox(g, x - r, y - r, z - r, x + r, y + r, z + r, mask);
        }
      }
    }
    const cells: number[] = [];
    let samples = 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-1, -1, -1];
    for (let q = 0; q < conn.n; q++) {
      if (!mask[q]) continue;
      if (!conn.count[q]) { mask[q] = 0; continue; }
      cells.push(q);
      samples += conn.count[q]!;
      const I = q % conn.nx, J = Math.floor(q / conn.nx) % conn.ny, K = Math.floor(q / (conn.nx * conn.ny));
      if (I < min[0]) min[0] = I; if (J < min[1]) min[1] = J; if (K < min[2]) min[2] = K;
      if (I > max[0]) max[0] = I; if (J > max[1]) max[1] = J; if (K > max[2]) max[2] = K;
    }
    if (!cells.length) return;
    const vol = samples * h * h * h;
    const tk = this.shape.thickness;
    const area = vol / Math.max(tk, h);
    const budget = Math.max(1, Math.floor(this.ctx.physics.maxDynamicBodies * 0.85 - this.ctx.physics.dynamicCount));
    const n = Math.max(1, Math.min(budget, Math.min(PANEL_MAX_PIECES, Math.max(2, Math.round(area / PANEL_PIECE_AREA)))));
    const cellLen = Math.sqrt(area / n);
    const cand = new Float64Array(cells.length * 3);
    cells.forEach((cell, q) => {
      const I = cell % conn.nx, J = Math.floor(cell / conn.nx) % conn.ny, K = Math.floor(cell / (conn.nx * conn.ny));
      cand[q * 3] = g.lx((I + 0.5) * F); cand[q * 3 + 1] = g.ly((J + 0.5) * F); cand[q * 3 + 2] = g.lz((K + 0.5) * F);
    });
    const seeds = pickSeeds(cand, cells.length, n, null, 0.6 * cellLen, this.ctx.rng);
    // Yield-line slabs run through the whole thickness: seeds on the mid-plane of the box, so the
    // bisector planes cut across it and never split it into layers.
    const ta = this.thicknessAxis();
    if (this.shape instanceof BoxShape) for (let q = ta; q < seeds.length; q += 3) seeds[q] = 0;
    // Soot of the fireball on the loaded face before it leaves (applyBlast adds it to the rest).
    this.carver.sootSplat(c.x, c.y, c.z, Math.cbrt(Math.max(1e-3, load.tntKg)), 0.95, seed);
    const barOwner = this.rebar ? this.assignBars(mask, seeds) : null;
    const sel: Selection = {
      box: [min[0] * F, min[1] * F, min[2] * F, max[0] * F + F - 1, max[1] * F + F - 1, max[2] * F + F - 1],
      sdf: false,
      cells: { mask, F, nx: conn.nx, ny: conn.ny },
      test: () => 1,
    };
    const pieces = splitSelection(g, sel, seeds, 0.5 * h, 0.12 * cellLen, this.eventSeed++);
    this.refreshOccupancy();
    // Velocity profile of the mechanism along the span: held edges from the anchors.
    const sa = this.spanAxis();
    const hs = this.shape.half[sa]!;
    let lowHeld = false, highHeld = false;
    for (const b of this.anchors.values()) {
      if (b.min.getComponent(sa) < -hs + 0.25 * 2 * hs) lowHeld = true;
      if (b.max.getComponent(sa) > hs - 0.25 * 2 * hs) highHeld = true;
    }
    const profile = (s: number) => {
      const u = Math.min(1, Math.max(0, (s + hs) / (2 * hs)));
      const f = lowHeld && highHeld ? Math.sin(Math.PI * u) : lowHeld ? Math.sin(0.5 * Math.PI * u) : highHeld ? Math.sin(0.5 * Math.PI * (1 - u)) : 1;
      return 0.3 + 0.7 * f;
    };
    const nl = new THREE.Vector3(), wn = new THREE.Vector3(), wp = new THREE.Vector3();
    const rho = this.material.density;
    let vMax = 0;
    const made = this.spawnPieces(pieces, (p, out) => {
      nl.set(0, 0, 0).setComponent(ta, c.getComponent(ta) >= p.seed[ta] ? 1 : -1);
      this.toWorld(p.seed[0], p.seed[1], p.seed[2], wp);
      this.toWorldDir(nl.x, nl.y, nl.z, wn);
      const v = Math.min(PANEL_MAX_SPEED, load.reflectedImpulseAt(wp, wn) / (rho * tk)) * profile(p.seed[sa]);
      vMax = Math.max(vMax, v);
      // Away from the loaded face, fanning a little along the rays from the charge.
      out.copy(wp).sub(load.center).normalize().multiplyScalar(0.2).sub(wn).normalize().multiplyScalar(v);
    }, barOwner, 0.3);
    this.afterCut();
    this.panelReleased = true;
    this.stats.lastReleaseMs = performance.now() - t0;
    const wc = this.toWorld(g.lx(((min[0] + max[0] + 1) * F) / 2), g.ly(((min[1] + max[1] + 1) * F) / 2), g.lz(((min[2] + max[2] + 1) * F) / 2), new THREE.Vector3());
    this.toWorldDir(ta === 0 ? 1 : 0, ta === 1 ? 1 : 0, ta === 2 ? 1 : 0, wn);
    if (wn.dot(_v.copy(load.center).sub(wc)) > 0) wn.negate();
    this.ctx.events.emit('fracture', { time: this.ctx.time.now, position: wc, volume: vol, pieces: made, material: this.material, direction: wn.clone() });
    this.ctx.fx.dust({ position: wc, velocity: wn.clone().multiplyScalar(Math.min(10, 0.5 * vMax)), radius: Math.max(1, Math.sqrt(area) * 0.6), amount: 5, color: this.material.dustColor });
  }

  private cylinderSelection(px: number, py: number, pz: number, a: THREE.Vector3, len: number, rad: number, lobe: number, seed: number): Selection {
    const g = this.grid;
    const ex = px + a.x * len, ey = py + a.y * len, ez = pz + a.z * len;
    const m = rad + lobe + g.h;
    const box: Selection['box'] = [
      Math.floor(g.gx(Math.min(px, ex) - m)), Math.floor(g.gy(Math.min(py, ey) - m)), Math.floor(g.gz(Math.min(pz, ez) - m)),
      Math.ceil(g.gx(Math.max(px, ex) + m)), Math.ceil(g.gy(Math.max(py, ey) + m)), Math.ceil(g.gz(Math.max(pz, ez) + m)),
    ];
    const f = 1 / Math.max(0.02, 0.5 * rad);
    const so = seed * 3.7;
    return {
      box,
      sdf: true,
      test: (_i, _j, _k, x, y, z) => {
        const vx = x - px, vy = y - py, vz = z - pz;
        const t = vx * a.x + vy * a.y + vz * a.z;
        const qx = vx - t * a.x, qy = vy - t * a.y, qz = vz - t * a.z;
        // Lobes vary around the axis only: the plug is a prism that can leave its hole along a.
        const radial = Math.sqrt(qx * qx + qy * qy + qz * qz) - rad - lobe * lobeNoise((px + qx) * f + so, (py + qy) * f, (pz + qz) * f - so);
        return Math.max(radial, -t, t - len);
      },
    };
  }

  private coneSelection(base: THREE.Vector3, axis: THREE.Vector3, R: number, D: number, seed: number): Selection {
    const g = this.grid;
    const m = R + g.h * 2;
    const tip = base.clone().addScaledVector(axis, D);
    const box: Selection['box'] = [
      Math.floor(g.gx(Math.min(base.x, tip.x) - m)), Math.floor(g.gy(Math.min(base.y, tip.y) - m)), Math.floor(g.gz(Math.min(base.z, tip.z) - m)),
      Math.ceil(g.gx(Math.max(base.x, tip.x) + m)), Math.ceil(g.gy(Math.max(base.y, tip.y) + m)), Math.ceil(g.gz(Math.max(base.z, tip.z) + m)),
    ];
    const cosA = D / Math.hypot(D, R);
    const f = 1 / Math.max(0.02, 0.5 * R);
    const so = seed * 2.3;
    return {
      box,
      sdf: true,
      test: (_i, _j, _k, x, y, z) => {
        const vx = x - base.x, vy = y - base.y, vz = z - base.z;
        const t = vx * axis.x + vy * axis.y + vz * axis.z;
        const rx = vx - t * axis.x, ry = vy - t * axis.y, rz = vz - t * axis.z;
        const rho = Math.sqrt(rx * rx + ry * ry + rz * rz);
        // Lobes vary around the axis only, so the scab can leave along it (see cylinderSelection).
        const side = (rho - R * (1 - t / D) - 0.25 * R * lobeNoise((base.x + rx) * f + so, (base.y + ry) * f - so, (base.z + rz) * f)) * cosA;
        return Math.max(side, t - D, -t - 0.05);
      },
    };
  }

  /**
   * Cut the selected material out as flying debris: a few Voronoi chunks (the rest pulverised
   * into chips and dust) thrown at about v. The plug leaves its hole along the throw axis `dir`
   * and fans out slightly along the rays from the charge at local `origin` (≤ ~15°): random
   * directions per piece sent neighbours into each other, and wide divergence ground the rim
   * pieces along the wall of the hole, costing the plug most of its speed in a few steps.
   */
  private throwSelection(sel: Selection, approxVolume: number, dir: THREE.Vector3, v: number, origin: THREE.Vector3, seed: number): void {
    const g = this.grid;
    const n = Math.max(1, Math.min(10, Math.round(approxVolume / 0.012)));
    const cand = new Float64Array(64 * 3);
    let cc = 0;
    const [i0, j0, k0, i1, j1, k1] = sel.box;
    for (let tries = 0; tries < 400 && cc < 64; tries++) {
      const i = Math.round(this.ctx.rng.range(i0, i1)), j = Math.round(this.ctx.rng.range(j0, j1)), k = Math.round(this.ctx.rng.range(k0, k1));
      if (g.density(i, j, k) < ISO) continue;
      if (sel.test(i, j, k, g.lx(i), g.ly(j), g.lz(k)) > 0) continue;
      cand[cc * 3] = g.lx(i); cand[cc * 3 + 1] = g.ly(j); cand[cc * 3 + 2] = g.lz(k);
      cc++;
    }
    if (!cc) return;
    const seeds = pickSeeds(cand, cc, n, null, 0.5 * Math.cbrt(approxVolume / n), this.ctx.rng);
    const pieces = splitSelection(g, sel, seeds, 0.6 * g.h, 0.3 * Math.cbrt(approxVolume / n), seed);
    // The static collider must lose this material before the pieces appear inside it.
    this.refreshOccupancy();
    const wdir = this.toWorldDir(dir.x, dir.y, dir.z, new THREE.Vector3());
    const ray = new THREE.Vector3();
    // Scabbing: the layer next to the free face leaves fastest, material near the charge slowest
    // (Rinehart, "Stress Transients in Solids", 1975, ch. 5), so no piece overtakes the one in
    // front of it.
    const along = (p: Piece) => (p.seed[0] - origin.x) * dir.x + (p.seed[1] - origin.y) * dir.y + (p.seed[2] - origin.z) * dir.z;
    let a0 = Infinity, a1 = -Infinity;
    for (const p of pieces) { const a = along(p); a0 = Math.min(a0, a); a1 = Math.max(a1, a); }
    const made = this.spawnPieces(pieces, (p, out) => {
      ray.set(p.seed[0] - origin.x, p.seed[1] - origin.y, p.seed[2] - origin.z);
      if (ray.lengthSq() > 1e-8) ray.normalize();
      ray.multiplyScalar(0.25).add(dir).normalize();
      this.toWorldDir(ray.x, ray.y, ray.z, ray);
      const f = a1 > a0 ? (along(p) - a0) / (a1 - a0) : 1;
      this.ctx.rng.inCone(ray, 0.04, out).multiplyScalar(v * (0.75 + 0.3 * f));
    }, null, 0.5);
    if (!pieces.length) return;
    let vol = 0;
    const c = new THREE.Vector3();
    for (const p of pieces) {
      vol += p.volume;
      c.x += p.seed[0] * p.volume; c.y += p.seed[1] * p.volume; c.z += p.seed[2] * p.volume;
    }
    c.divideScalar(Math.max(vol, 1e-9));
    this.ctx.events.emit('fracture', {
      time: this.ctx.time.now, position: this.toWorld(c.x, c.y, c.z, new THREE.Vector3()), volume: vol, pieces: made,
      material: this.material, direction: wdir.clone(),
    });
  }

  /**
   * Plastic bending of exposed bar spans by the reflected blast impulse. Energy balance of a
   * rigid-plastic clamped beam with membrane action (Jones, "Structural Impact", 1989, ch. 3 & 7):
   *   KE = I'² L / (2 m'),   I' = i_r·d,   m' = ρ A
   *   KE = 8 M_p δ / L + 2 N_p δ² / L,   M_p = f_y d³ / 6,   N_p = f_y A
   * Free (cut) ends rotate about their embedment by θ = KE / M_p. A span whose membrane strain
   * π²δ²/(4L²) exceeds the fracture strain snaps.
   */
  private bendBars(load: BlastLoad, c: THREE.Vector3): boolean {
    const rb = this.rebar!;
    const g = this.grid;
    const n = rb.nodes;
    const fy = REBAR.yieldStrength ?? 500e6;
    const eps = REBAR.fractureStrain ?? 0.08;
    const free = (node: number) => g.densityAt(g.gx(n[node * 3]!), g.gy(n[node * 3 + 1]!), g.gz(n[node * 3 + 2]!)) < ISO;
    let changed = false;
    // Walk bars as chains of consecutive segments.
    let s = 0;
    while (s < rb.segCount) {
      let e = s;
      while (e + 1 < rb.segCount && rb.segB[e] === rb.segA[e + 1]) e++;
      // Nodes of the chain s..e
      const chain: number[] = [rb.segA[s]!];
      for (let q = s; q <= e; q++) chain.push(rb.segB[q]!);
      const closed = chain[0] === chain[chain.length - 1];
      if (closed) chain.pop();
      const alive = (q: number) => q >= 0 && q < chain.length - 1 && rb.alive(s + q);
      let q = 0;
      while (q < chain.length) {
        if (!free(chain[q]!) || rb.segGone[Math.min(e, s + q)]) { q++; continue; }
        let q1 = q;
        while (q1 + 1 < chain.length && free(chain[q1 + 1]!) && alive(q1)) q1++;
        const leftAnchor = q > 0 && alive(q - 1) ? chain[q - 1]! : -1;
        const rightAnchor = q1 < chain.length - 1 && alive(q1) ? chain[q1 + 1]! : -1;
        if (leftAnchor >= 0 || rightAnchor >= 0) {
          const nodesRun = chain.slice(q, q1 + 1);
          changed = this.bendRun(load, c, rb, nodesRun, leftAnchor, rightAnchor, s + Math.max(0, q - 1), fy, eps) || changed;
        }
        q = q1 + 1;
      }
      s = e + 1;
    }
    if (changed) {
      rb.version++;
      rb.register(g);
    }
    return changed;
  }

  /**
   * Cheap bound before walking every bar: the most a blast can turn an exposed free bar end,
   * from the same energy balance as bendRun (KE = I'²L/(2m'), θ = KE/M_p, Jones 1989), for the
   * thinnest bar, a free length as long as the element and the reflected impulse at the
   * element's nearest point: θ = 12 i_r² L / (π ρ f_y d³). Clamped spans deflect less than a
   * free end turns, so below 0.01 rad nothing can move.
   */
  private barsMayBend(load: BlastLoad): boolean {
    const rb = this.rebar!;
    let r = Infinity;
    for (let s = 0; s < rb.segCount; s++) if (rb.alive(s)) r = Math.min(r, rb.radius(s));
    if (!Number.isFinite(r)) return false;
    this.bounds.clampPoint(load.center, _v);
    const n = _v2.copy(load.center).sub(_v);
    if (n.lengthSq() < 1e-8) return true;
    n.normalize();
    const ir = load.reflectedImpulseAt(_v, n);
    const L = 2 * Math.max(...this.shape.half);
    const d = 2 * r;
    const theta = (12 * ir * ir * L) / (Math.PI * REBAR.density * (REBAR.yieldStrength ?? 500e6) * d * d * d);
    return theta >= 0.01;
  }

  private bendRun(load: BlastLoad, c: THREE.Vector3, rb: RebarSet, run: number[], la: number, ra: number, firstSeg: number, fy: number, eps: number): boolean {
    const n = rb.nodes;
    const P = (i: number) => new THREE.Vector3(n[i * 3]!, n[i * 3 + 1]!, n[i * 3 + 2]!);
    const A0 = la >= 0 ? P(la) : P(run[0]!);
    const B0 = ra >= 0 ? P(ra) : P(run[run.length - 1]!);
    const L = A0.distanceTo(B0);
    if (L < 0.05) return false;
    const mid = A0.clone().add(B0).multiplyScalar(0.5);
    const wMid = this.toWorld(mid.x, mid.y, mid.z, new THREE.Vector3());
    const toC = this.toWorld(c.x, c.y, c.z, new THREE.Vector3()).sub(wMid);
    if (toC.lengthSq() < 1e-8) return false;
    const ir = load.reflectedImpulseAt(wMid, toC.clone().normalize());
    const r = rb.radius(firstSeg);
    const d = 2 * r;
    const A = Math.PI * r * r;
    const mPrime = REBAR.density * A;
    const Ip = ir * d;
    const KE = (Ip * Ip * L) / (2 * mPrime);
    const Mp = (fy * d * d * d) / 6;
    const Np = fy * A;
    // Push direction: away from the charge, perpendicular to the bar. Under a contact charge the
    // load drives through the thickness (along the charge normal), with a smaller radial part.
    const tan = B0.clone().sub(A0).normalize();
    const away = mid.clone().sub(c);
    if (this.blastAxis) {
      const radial = away.clone().addScaledVector(this.blastAxis, -away.dot(this.blastAxis));
      away.copy(this.blastAxis).addScaledVector(radial.normalize(), 0.35);
    }
    const flow = away.clone().normalize();
    away.addScaledVector(tan, -away.dot(tan));
    if (away.lengthSq() < 1e-8) return false;
    away.normalize();
    if (la >= 0 && ra >= 0) {
      const a2 = (2 * Np) / L, b2 = (8 * Mp) / L;
      let delta = (-b2 + Math.sqrt(b2 * b2 + 4 * a2 * KE)) / (2 * a2);
      if (!(delta > 0.002)) return false;
      // Membrane strain of a half-sine deflection: ε = π²δ²/(4L²). Past the fracture strain the
      // bar snaps near mid-span at that deflection.
      const dMax = (2 * L * Math.sqrt(eps)) / Math.PI;
      const snaps = delta > dMax;
      delta = Math.min(delta, dMax, 0.5);
      for (const node of run) {
        const p = P(node);
        const sArc = Math.min(1, Math.max(0, p.clone().sub(A0).dot(tan) / L));
        const k = delta * Math.sin(Math.PI * sArc);
        n[node * 3] += away.x * k; n[node * 3 + 1] += away.y * k; n[node * 3 + 2] += away.z * k;
      }
      if (snaps) {
        const midSeg = firstSeg + Math.floor(run.length / 2);
        if (midSeg < rb.segCount) rb.cut(midSeg, this.ctx.rng.range(-1, 1));
      }
      return true;
    }
    // Free (cut) end: plastic work at the hinges absorbs the kinetic energy, M_p·θ = KE, with θ the
    // total turn of the bar. Under an impulsive load the hinge travels from the tip towards the
    // root (Parkes 1955; Jones, "Structural Impact", §3.6), so the turn is spread along the free
    // length and the bar curls into an arc instead of swinging out as a straight lever.
    // The flow stops loading the bar once it points downstream, so the rotation cannot carry it
    // past the direction away from the charge (repeated blasts cannot wind it round).
    const anchor = la >= 0 ? la : ra;
    const dir = la >= 0 ? tan : tan.clone().negate();
    // Nodes from the embedment outwards; each segment turns a further θ/m relative to the last.
    const chain = la >= 0 ? [anchor, ...run] : [anchor, ...run.slice().reverse()];
    const m = chain.length - 1;
    // The cap is measured at the tip (an arc's chord lags its tip by θ/2, and repeated blasts
    // would otherwise keep curling a bar that already points downstream).
    const tip = P(chain[m]!).sub(P(chain[m - 1]!)).normalize();
    const align = Math.acos(Math.min(1, Math.max(-1, tip.dot(flow))));
    const theta = Math.min(1.2, KE / Mp, align);
    if (theta < 0.01) return false;
    const axis = new THREE.Vector3().crossVectors(dir, away).normalize();
    if (axis.lengthSq() < 0.5) return false;
    const q = new THREE.Quaternion();
    const prevOld = P(chain[0]!), prevNew = prevOld.clone(), seg = new THREE.Vector3();
    for (let k = 1; k <= m; k++) {
      const node = chain[k]!;
      const cur = P(node);
      seg.subVectors(cur, prevOld);
      prevOld.copy(cur);
      q.setFromAxisAngle(axis, (theta * (k - 0.5)) / m);
      prevNew.add(seg.applyQuaternion(q));
      n[node * 3] = prevNew.x; n[node * 3 + 1] = prevNew.y; n[node * 3 + 2] = prevNew.z;
    }
    return true;
  }

  // ── Structural bookkeeping ────────────────────────────────────────────────────────────────

  private afterMaterialLoss(changed: boolean, delay = CHECK_DELAY): void {
    if (!changed) return;
    this.flushDirty();
    const now = this.ctx.time.now;
    if (this.checkAt < 0) this.checkAt = now + delay;
    else this.checkAt = Math.min(this.checkAt, now + delay);
    this.ctx.structure.touch(this);
  }

  /** Recount coarse occupancy and collider cells for chunks whose samples changed. */
  private refreshOccupancy(): void {
    const g = this.grid;
    if (!g.occDirtyList.length) return;
    const list = g.occDirtyList.slice();
    for (const ci of list) g.occDirty[ci] = 0;
    g.occDirtyList.length = 0;
    this.conn.update(g, list);
    this.syncCollider(list);
  }

  private runStructuralCheck(): void {
    this.checkAt = -1;
    const t0 = performance.now();
    this.refreshOccupancy();
    const g = this.grid;
    if (g.totalSolid === 0) {
      this.fail('support-lost');
      return;
    }
    const anchored = this.everAnchored && !this.dynamic;
    const islands = this.conn.analyze(g, {
      anchors: anchored ? this.anchorMasks : null,
      rebar: this.rebar,
      horizontal: this.horizontal,
      cantilever: CANTILEVER_FACTOR * this.shape.thickness,
      span: SPAN_FACTOR * this.shape.thickness,
    });
    this.stats.lastCheckMs = performance.now() - t0;
    if (islands.length) this.release(islands);
    if (!this.disposed && anchored && !this.checkCrushing()) this.checkOverturning();
  }

  /**
   * Cut unsupported islands out into rigid-body pieces. Islands above ~0.05 m³ are split into
   * Voronoi chunks first (≈ one per 0.05 m³, at most 24 per event, seeds biased to the last hit).
   */
  private release(islands: Island[]): void {
    const t0 = performance.now();
    const g = this.grid, conn = this.conn, F = conn.F;
    const h3 = g.h * g.h * g.h;
    let totalVol = 0, totalPieces = 0;
    const budget = () => Math.max(0, this.ctx.physics.maxDynamicBodies * 0.85 - this.ctx.physics.dynamicCount);
    const mask = new Uint8Array(conn.n);
    for (const island of islands) {
      const vol = island.samples * h3;
      if (!vol) continue;
      mask.fill(0);
      for (const cell of island.cells) mask[cell] = 1;
      const box: Selection['box'] = [
        island.min[0] * F, island.min[1] * F, island.min[2] * F,
        island.max[0] * F + F - 1, island.max[1] * F + F - 1, island.max[2] * F + F - 1,
      ];
      const sel: Selection = {
        box,
        sdf: false,
        cells: { mask, F, nx: conn.nx, ny: conn.ny },
        test: () => 1,
      };
      let n = vol > VOLUME_PER_PIECE * 1.5 ? Math.min(MAX_PIECES_PER_EVENT, Math.round(vol / VOLUME_PER_PIECE)) : 1;
      n = Math.max(1, Math.min(n, Math.floor(budget())));
      const cand = new Float64Array(island.cells.length * 3);
      island.cells.forEach((cell, q) => {
        const I = cell % conn.nx, J = Math.floor(cell / conn.nx) % conn.ny, K = Math.floor(cell / (conn.nx * conn.ny));
        cand[q * 3] = g.lx((I + 0.5) * F); cand[q * 3 + 1] = g.ly((J + 0.5) * F); cand[q * 3 + 2] = g.lz((K + 0.5) * F);
      });
      const cellLen = Math.cbrt(vol / n);
      const seeds = n > 1 ? pickSeeds(cand, island.cells.length, n, [this.lastImpact.x, this.lastImpact.y, this.lastImpact.z], 0.55 * cellLen, this.ctx.rng) : [cand[0]!, cand[1]!, cand[2]!];
      // Rebar inside the island goes with the pieces.
      const barOwner = this.rebar ? this.assignBars(mask, seeds) : null;
      const pieces = splitSelection(g, sel, seeds, n > 1 ? 0.5 * g.h : 0, n > 1 ? 0.25 * cellLen : 0, this.eventSeed++);
      this.refreshOccupancy();
      totalVol += vol;
      const blast = this.pendingBlast && this.ctx.time.now <= this.pendingBlast.until ? this.pendingBlast : null;
      totalPieces += this.spawnPieces(pieces, (p, out) => {
        out.set(0, 0, 0);
        if (!blast) return;
        // Rigid-plastic launch speed of loosened material: v = i_r / (ρ t).
        this.toWorld(p.seed[0], p.seed[1], p.seed[2], _v);
        const away = _v2.copy(_v).sub(blast.load.center);
        const dist = away.length();
        if (dist < 1e-6) return;
        away.divideScalar(dist);
        const ir = blast.load.reflectedImpulseAt(_v, _s.copy(away).negate());
        out.copy(away).multiplyScalar(Math.min(60, ir / (this.material.density * Math.max(0.05, blast.thickness))));
      }, barOwner, 0.4, blast ? MIN_PIECE_SIZE * 0.6 : RUBBLE_MIN_SIZE);
    }
    this.afterCut();
    this.stats.lastReleaseMs = performance.now() - t0;
    if (totalVol > 0) {
      const wc = this.bounds.getCenter(new THREE.Vector3());
      this.ctx.events.emit('fracture', { time: this.ctx.time.now, position: wc, volume: totalVol, pieces: totalPieces, material: this.material });
    }
    if (g.totalSolid === 0) this.fail('support-lost');
    else if (this.dynamic) this.rebuildHull();
  }

  /** Housekeeping after material was cut out into pieces: chunks, meshes, occupancy, bars, bounds. */
  private afterCut(): void {
    const g = this.grid;
    for (let ci = 0; ci < g.chunkCount; ci++) if (g.state[ci] === 2 && g.solid[ci] === 0) g.compact(ci);
    this.flushDirty();
    this.refreshOccupancy();
    // Bar fragments left hanging in the air (their concrete went with the pieces) fall away.
    if (this.rebar) {
      const conn = this.conn;
      const dropped = this.rebar.pruneFloating((x, y, z) => {
        const c = conn.cellOf(g, x, y, z);
        return c >= 0 && conn.count[c]! > 0;
      });
      if (dropped) this.rebar.register(g);
    }
    this.sampleBox = g.solidSampleBounds() ?? [0, 0, 0, 0, 0, 0];
    if (!this.dynamic) this.updateBounds();
  }

  /** Map bar segments inside the island mask to the nearest seed (piece index), −1 otherwise. */
  private assignBars(mask: Uint8Array, seeds: number[]): Int32Array {
    const rb = this.rebar!, conn = this.conn;
    const owner = new Int32Array(rb.segCount).fill(-1);
    const n = rb.nodes;
    for (let s = 0; s < rb.segCount; s++) {
      if (rb.segGone[s]) continue;
      const a = rb.segA[s]! * 3, b = rb.segB[s]! * 3;
      const mx = (n[a]! + n[b]!) / 2, my = (n[a + 1]! + n[b + 1]!) / 2, mz = (n[a + 2]! + n[b + 2]!) / 2;
      const cell = conn.cellOf(this.grid, mx, my, mz);
      if (cell < 0 || !mask[cell]) continue;
      let best = 0, bd = Infinity;
      for (let q = 0; q < seeds.length / 3; q++) {
        const d = (seeds[q * 3]! - mx) ** 2 + (seeds[q * 3 + 1]! - my) ** 2 + (seeds[q * 3 + 2]! - mz) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      owner[s] = best;
    }
    return owner;
  }

  /**
   * Turn piece grids into rigid-body elements (or chips when small / over the body budget).
   * `velocity` gives each piece's initial world velocity. Returns the number of bodies made.
   */
  private spawnPieces(pieces: Piece[], velocity: (p: Piece, out: THREE.Vector3) => void, barOwner: Int32Array | null, spin: number, minSize = MIN_PIECE_SIZE * 0.6): number {
    let made = 0;
    const fx = this.ctx.fx;
    const phys = this.ctx.physics;
    const inherit = new THREE.Vector3(), inheritW = new THREE.Vector3();
    if (this.body) {
      const lv = this.body.linvel(), av = this.body.angvel();
      inherit.set(lv.x, lv.y, lv.z);
      inheritW.set(av.x, av.y, av.z);
    }
    const group = ++spawnEvents;
    for (const p of pieces) {
      const size = Math.cbrt(p.volume);
      const v = new THREE.Vector3();
      velocity(p, v);
      v.add(inherit);
      const wp = this.toWorld(p.seed[0], p.seed[1], p.seed[2], new THREE.Vector3());
      const overBudget = phys.dynamicCount >= phys.maxDynamicBodies * 0.9;
      if (p.volume < CHIP_VOLUME || size < minSize || overBudget) {
        // Bar bits inside pulverised material go with it.
        if (barOwner && this.rebar) {
          const rb = this.rebar;
          for (let s = 0; s < rb.segCount; s++) if (barOwner[s] === p.seedIndex && !rb.segGone[s]) rb.segGone[s] = 1;
          rb.version++;
        }
        fx.chips({ position: wp, direction: v.lengthSq() > 1e-6 ? v.clone().normalize() : UP, spread: 1.2, speed: Math.max(2, v.length()), count: Math.max(2, Math.min(20, Math.round(p.volume / 2e-5))), size: Math.min(0.05, Math.max(0.01, size * 0.5)), color: this.material.color, kind: 'stone' });
        fx.dust({ position: wp, radius: Math.max(0.1, size * 2), amount: Math.min(2, p.volume * 200), color: this.material.dustColor });
        continue;
      }
      let rebar: RebarSet | null = null;
      if (barOwner && this.rebar) {
        const own = barOwner;
        rebar = this.rebar.split((s) => own[s] === p.seedIndex);
      }
      const w = new THREE.Vector3(this.ctx.rng.gaussian(0, spin), this.ctx.rng.gaussian(0, spin), this.ctx.rng.gaussian(0, spin)).add(inheritW);
      // A parent left without material loses its whole collider (refreshOccupancy) anyway.
      const parentLeft = this.grid.totalSolid > 0;
      if (parentLeft) this.clearColliderUnder(p.grid);
      const piece = new VoxelElement(this.ctx, { ...this.spec, dynamic: true, name: `${this.name}·piece` }, { parent: this, grid: p.grid, rebar, linvel: v, angvel: w, group, cell: p.seeds.length > 3 ? { seeds: p.seeds, index: p.seedIndex } : null });
      if (parentLeft) this.clearColliderUnderHull(piece);
      this.ctx.addDestructible(piece);
      this.stats.pieces++;
      made++;
    }
    return made;
  }

  private rebuildHull(): void {
    if (!this.body || this.disposed) return;
    const vol = this.grid.solidVolume();
    if (vol > this.hullVolume * 0.85) return;
    const p = this.ctx.physics;
    const lv = this.body.linvel(), av = this.body.angvel();
    try {
      p.removeBody(this.body);
    } catch {
      /* ignore */
    }
    this.body = null;
    this.makeDynamicBody(new THREE.Vector3(lv.x, lv.y, lv.z), new THREE.Vector3(av.x, av.y, av.z));
  }

  /** Split this whole (dynamic) piece into 2–4 fragments after a hard landing. */
  private secondaryFracture(point: THREE.Vector3): void {
    const g = this.grid, conn = this.conn;
    this.refreshOccupancy();
    const cells: number[] = [];
    for (let c = 0; c < conn.n; c++) if (conn.count[c]) cells.push(c);
    if (!cells.length) return;
    const vol = g.solidVolume();
    const n = Math.max(2, Math.min(4, Math.round(vol / (MIN_PIECE_SIZE ** 3 * 4))));
    this.toLocal(point, this.lastImpact);
    let min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-1, -1, -1];
    let samples = 0;
    for (const c of cells) {
      const I = c % conn.nx, J = Math.floor(c / conn.nx) % conn.ny, K = Math.floor(c / (conn.nx * conn.ny));
      min = [Math.min(min[0], I), Math.min(min[1], J), Math.min(min[2], K)];
      max = [Math.max(max[0], I), Math.max(max[1], J), Math.max(max[2], K)];
      samples += conn.count[c]!;
    }
    this.releaseWhole({ cells, samples, min, max }, n);
  }

  private releaseWhole(island: Island, n: number): void {
    const g = this.grid, conn = this.conn, F = conn.F;
    const mask = new Uint8Array(conn.n);
    for (const c of island.cells) mask[c] = 1;
    const sel: Selection = {
      box: [island.min[0] * F, island.min[1] * F, island.min[2] * F, island.max[0] * F + F - 1, island.max[1] * F + F - 1, island.max[2] * F + F - 1],
      sdf: false,
      cells: { mask, F, nx: conn.nx, ny: conn.ny },
      test: () => 1,
    };
    const cand = new Float64Array(island.cells.length * 3);
    island.cells.forEach((cell, q) => {
      const I = cell % conn.nx, J = Math.floor(cell / conn.nx) % conn.ny, K = Math.floor(cell / (conn.nx * conn.ny));
      cand[q * 3] = g.lx((I + 0.5) * F); cand[q * 3 + 1] = g.ly((J + 0.5) * F); cand[q * 3 + 2] = g.lz((K + 0.5) * F);
    });
    const vol = island.samples * g.h ** 3;
    const cellLen = Math.cbrt(vol / n);
    const seeds = pickSeeds(cand, island.cells.length, n, [this.lastImpact.x, this.lastImpact.y, this.lastImpact.z], 0.5 * cellLen, this.ctx.rng);
    const barOwner = this.rebar ? this.assignBars(mask, seeds) : null;
    const pieces = splitSelection(g, sel, seeds, 0.5 * g.h, 0.25 * cellLen, this.eventSeed++);
    const made = this.spawnPieces(pieces, (_p, out) => out.set(0, 0, 0), barOwner, 0.8, RUBBLE_MIN_SIZE);
    this.ctx.events.emit('fracture', { time: this.ctx.time.now, position: this.bounds.getCenter(new THREE.Vector3()), volume: vol, pieces: made, material: this.material });
    this.fail('severed');
  }

  /**
   * Column crushing (local Y vertical): slice j fails when N_above > A_j · f_c, with A_j the
   * remaining solid area of the slice and N_above the imposed load plus the weight of the
   * material above (EN 1992-1-1 squash load of the concrete section, reinforcement neglected).
   * The crushed zone (half a section deep) turns to rubble and the part above falls.
   */
  private checkCrushing(): boolean {
    const g = this.grid;
    _v.copy(UP).applyQuaternion(this.invQ);
    if (Math.abs(_v.y) < 0.85) return false;
    const fc = this.material.compressiveStrength;
    const h = g.h;
    const w = this.material.density * G * h * h * h;
    const topDown = _v.y > 0;
    let above = this.imposedLoad;
    for (let q = 0; q < g.ny; q++) {
      const j = topDown ? g.ny - 1 - q : q;
      const count = g.rowSolid[j]!;
      if (count > 0 && above > count * h * h * fc) {
        this.crush(j, above, 'crushing', Math.max(2 * g.h, 0.25 * this.shape.thickness));
        return true;
      }
      above += count * w;
    }
    return false;
  }

  /**
   * Overturning of a vertical element (rigid-block statics): the material above each horizontal
   * section, plus the imposed load at its top, must have its centre of gravity over that section's
   * footprint, or the part above tips off it. A narrow stub left at one end of a blown-out wall
   * base passes the crushing check with ease but would have to resist the moment W·e; a
   * reinforced section resists only M_Rd ≈ A_s·f_y·z (EN 1992-1-1 §6.1), small next to that and
   * neglected here beyond a one-voxel margin. Returns true if a section failed.
   */
  private checkOverturning(): boolean {
    const g = this.grid;
    _v.copy(UP).applyQuaternion(this.invQ);
    if (_v.y < 0.85) return false;
    const ny = g.ny;
    const cnt = new Float64Array(ny), sx = new Float64Array(ny), sz = new Float64Array(ny);
    const x0 = new Int32Array(ny).fill(0x7fffffff), x1 = new Int32Array(ny).fill(-1);
    const z0 = new Int32Array(ny).fill(0x7fffffff), z1 = new Int32Array(ny).fill(-1);
    for (let c = 0; c < g.cz; c++)
      for (let b = 0; b < g.cy; b++)
        for (let a = 0; a < g.cx; a++) {
          const ci = a + g.cx * (b + g.cy * c);
          const st = g.state[ci];
          if (st === EMPTY) continue;
          const i0 = a * CHUNK, j0 = b * CHUNK, k0 = c * CHUNK;
          const i1 = Math.min(g.nx, i0 + CHUNK) - 1, j1 = Math.min(g.ny, j0 + CHUNK) - 1, k1 = Math.min(g.nz, k0 + CHUNK) - 1;
          if (st === FULL) {
            const ni = i1 - i0 + 1, nk = k1 - k0 + 1;
            for (let j = j0; j <= j1; j++) {
              cnt[j] += ni * nk;
              sx[j] += ((i0 + i1) * ni * nk) / 2;
              sz[j] += ((k0 + k1) * nk * ni) / 2;
              if (i0 < x0[j]!) x0[j] = i0;
              if (i1 > x1[j]!) x1[j] = i1;
              if (k0 < z0[j]!) z0[j] = k0;
              if (k1 > z1[j]!) z1[j] = k1;
            }
            continue;
          }
          const d = g.dens[ci]!;
          for (let k = k0; k <= k1; k++)
            for (let j = j0; j <= j1; j++)
              for (let i = i0; i <= i1; i++) {
                if (d[(i & 15) | ((j & 15) << 4) | ((k & 15) << 8)]! < ISO) continue;
                cnt[j]++;
                sx[j] += i;
                sz[j] += k;
                if (i < x0[j]!) x0[j] = i;
                if (i > x1[j]!) x1[j] = i;
                if (k < z0[j]!) z0[j] = k;
                if (k > z1[j]!) z1[j] = k;
              }
        }
    // Sections inside a support region are held by it.
    let jFix = -1;
    for (const box of this.anchors.values()) jFix = Math.max(jFix, Math.ceil(g.gy(box.max.y)));
    let jTop = ny - 1;
    while (jTop > 0 && cnt[jTop] === 0) jTop--;
    if (cnt[jTop] === 0) return false;
    const w = this.material.density * G * g.h ** 3;
    let n = this.imposedLoad / w, mx = (n * sx[jTop]!) / cnt[jTop]!, mz = (n * sz[jTop]!) / cnt[jTop]!;
    for (let j = jTop; j > jFix; j--) {
      if (cnt[j]! > 0 && n > 0) {
        const cx = mx / n, cz = mz / n;
        if (cx < x0[j]! - 1 || cx > x1[j]! + 1 || cz < z0[j]! - 1 || cz > z1[j]! + 1) {
          this.crush(j, n * w, 'overload', 1.5 * g.h);
          return true;
        }
      }
      n += cnt[j]!;
      mx += sx[j]!;
      mz += sz[j]!;
    }
    return false;
  }

  /** The section at row j fails: it turns to rubble and whatever it carried is released. */
  private crush(j: number, load: number, cause: 'crushing' | 'overload', halfZone: number): void {
    const g = this.grid, h = g.h;
    const y = g.ly(j);
    const seed = this.eventSeed++;
    this.carver.stats.reset();
    this.carver.carve(g.ox, y - halfZone, g.oz, g.ox + g.nx * h, y + halfZone, g.oz + g.nz * h, (_x, yy) => Math.abs(yy - y) - halfZone, { lobe: 0.4 * halfZone, lobeScale: halfZone, grain: h, seed });
    const wp = this.toWorld(0, y, 0, new THREE.Vector3());
    this.ctx.fx.dust({ position: wp, radius: this.shape.thickness * 1.5, amount: 4, color: this.material.dustColor });
    this.ctx.fx.chips({ position: wp, direction: UP, spread: 1.4, speed: 4, count: 60, size: 0.03, color: this.material.color, kind: 'stone' });
    this.ctx.events.emit('structuralFailure', { time: this.ctx.time.now, position: wp, label: this.name, mass: load / G, cause });
    this.flushDirty();
    this.runStructuralCheck();
  }

  private fail(_cause: 'support-lost' | 'severed'): void {
    if (this.failed) return;
    this.failed = true;
    try {
      this.ctx.structure.remove(this);
    } catch {
      /* ignore */
    }
    this.dispose();
  }

  // ── Structural interface ──────────────────────────────────────────────────────────────────

  weight(): number {
    return (this.grid.solidVolume() * this.material.density + (this.rebar?.mass() ?? 0)) * G;
  }

  private localBox(regionWorld: THREE.Box3): THREE.Box3 {
    const out = new THREE.Box3();
    const { min, max } = regionWorld;
    for (let c = 0; c < 8; c++) {
      _v.set(c & 1 ? max.x : min.x, c & 2 ? max.y : min.y, c & 4 ? max.z : min.z);
      out.expandByPoint(this.toLocal(_v, _v2));
    }
    return out;
  }

  addAnchor(anchorId: string, regionWorld: THREE.Box3): void {
    const lb = this.localBox(regionWorld);
    this.anchors.set(anchorId, lb);
    this.everAnchored = true;
    this.rebuildAnchorMask();
  }

  releaseAnchor(anchorId: string): void {
    if (!this.anchors.delete(anchorId)) return;
    this.rebuildAnchorMask();
    // Re-check right away (next fixed step).
    this.checkAt = this.ctx.time.now;
  }

  /** One coarse-cell mask per support (supports are independent for the span rule). */
  private rebuildAnchorMask(): void {
    const g = this.grid;
    this.anchorMasks = [];
    for (const b of this.anchors.values()) {
      const mask = new Uint8Array(this.conn.n);
      this.conn.markBox(g, b.min.x - 0.5 * g.h, b.min.y - 0.5 * g.h, b.min.z - 0.5 * g.h, b.max.x + 0.5 * g.h, b.max.y + 0.5 * g.h, b.max.z + 0.5 * g.h, mask);
      this.anchorMasks.push(mask);
    }
  }

  supportPresence(regionWorld: THREE.Box3): number {
    if (this.failed || this.disposed) return 0;
    const lb = this.localBox(regionWorld);
    const g = this.grid;
    const i0 = Math.max(0, Math.ceil(g.gx(lb.min.x))), i1 = Math.min(g.nx - 1, Math.floor(g.gx(lb.max.x)));
    const j0 = Math.max(0, Math.ceil(g.gy(lb.min.y))), j1 = Math.min(g.ny - 1, Math.floor(g.gy(lb.max.y)));
    const k0 = Math.max(0, Math.ceil(g.gz(lb.min.z))), k1 = Math.min(g.nz - 1, Math.floor(g.gz(lb.max.z)));
    if (i1 < i0 || j1 < j0 || k1 < k0) return 0;
    const key = `${i0},${j0},${k0},${i1},${j1},${k1}`;
    let initial = this.initialCounts.get(key);
    let now = 0;
    const computeInitial = initial === undefined;
    let init = 0;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          if (g.density(i, j, k) >= ISO) now++;
          if (computeInitial && densityFromSdf(this.shape.sdf(g.lx(i), g.ly(j), g.lz(k)), g.h) >= ISO) init++;
        }
    if (computeInitial) {
      initial = init;
      this.initialCounts.set(key, init);
    }
    return initial! > 0 ? Math.min(1, now / initial!) : 0;
  }

  setImposedLoad(newtons: number): void {
    const changed = Math.abs(newtons - this.imposedLoad) > 1;
    this.imposedLoad = Math.max(0, newtons);
    if (changed && this.everAnchored && !this.dynamic && !this.checkCrushing()) this.checkOverturning();
  }

  hasFailed(): boolean {
    return this.failed;
  }

  // ── Loop ──────────────────────────────────────────────────────────────────────────────────

  fixedUpdate(dt: number): void {
    if (this.disposed) return;
    if (this.dynamic) {
      this.syncFromBody();
      if (this.body) {
        if (this.siblingSolverUntil >= 0 && this.ctx.time.now >= this.siblingSolverUntil) this.restoreSolverGroups();
        this.limitContactGain(dt);
        this.airDrag(dt);
        const v = this.body.linvel(), w = this.body.angvel();
        this.prevLin.set(v.x, v.y, v.z);
        this.prevAng.set(w.x, w.y, w.z);
      }
      if (this.root.position.y < -60) {
        this.dispose();
        return;
      }
      if (this.pendingSplit) {
        const pt = this.pendingSplit.point;
        this.pendingSplit = null;
        this.secondaryFracture(pt);
        return;
      }
    }
    if (this.checkAt >= 0 && this.ctx.time.now >= this.checkAt) this.runStructuralCheck();
  }

  frameUpdate(_dt: number): void {
    if (this.disposed) return;
    this.scheduler.tick(this);
    if (this.rebar) this.updateRebarInstances();
    // After the shared remesh budget ran (the first element of the frame spends it), so a new
    // piece shows the same frame its parent loses the material.
    if (this.dynamic) this.look.batches.flushClient(this);
  }

  /**
   * Quadratic air drag on flying debris, F = ½ ρ C_d A v² with C_d ≈ 1 for a tumbling block and
   * A ≈ V^⅔ (Hoerner, "Fluid-Dynamic Drag", 1965, ch. 3); Rapier only offers linear damping. The
   * velocity change is applied implicitly (v / (1 + k v dt)) so it cannot overshoot at any dt.
   */
  private airDrag(dt: number): void {
    const b = this.body!;
    if (b.isSleeping() || this.mass <= 0) return;
    const v = b.linvel();
    const sp2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (sp2 < 25) return;
    const sp = Math.sqrt(sp2);
    const k = (0.5 * AIR_DENSITY * 1.0 * Math.pow(this.grid.solidVolume(), 2 / 3)) / this.mass;
    const f = 1 / (1 + k * sp * dt);
    b.setLinvel({ x: v.x * f, y: v.y * f, z: v.z * f }, true);
  }

  /** Remesh every pending chunk of this element now (tests, screenshots). */
  flushMeshes(): void {
    this.flushDirty();
    for (let ci = 0; ci < this.grid.chunkCount; ci++) if (this.grid.dirty[ci]) this.remesh(ci);
    this.updateRebarInstances();
    this.look.batches.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.parent?.remove(this.root);
    this.chunkBatch?.dispose();
    this.chunkBatch = null;
    this.chunkSlots.fill(null);
    this.look.batches.forget(this);
    if (this.solidSlot) this.solidBatch!.remove(this.solidSlot);
    if (this.barSlot) this.barBatch!.remove(this.barSlot);
    this.solidSlot = this.barSlot = null;
    if (this.baseMesh) this.baseMesh.geometry.dispose();
    this.baseMaterial?.dispose();
    this.depthMats?.depth.dispose();
    this.depthMats?.distance.dispose();
    this.maskTex?.dispose();
    if (this.rebarMesh) {
      this.rebarMesh.geometry.dispose();
      this.rebarMesh.dispose();
    }
    this.look.release();
    const p = this.ctx.physics;
    for (const b of [this.body, this.fixedBody]) {
      if (!b) continue;
      try {
        p.removeBody(b);
      } catch {
        /* the world was replaced by a scene load */
      }
    }
    this.body = this.fixedBody = null;
    this.voxelCollider = null;
    this.scheduler.forget(this);
  }
}

/** Radial lobe noise in [-1, 1] for selections (cheap sin-hash blend, deterministic). */
function lobeNoise(x: number, y: number, z: number): number {
  return Math.sin(x * 1.7 + Math.sin(y * 2.3 + z * 0.7) * 1.9) * 0.6 + Math.sin(y * 3.1 - x * 1.3 + Math.sin(z * 2.9) * 1.4) * 0.4;
}

/** The attribute set of Surface Nets geometry (every solid batch carries exactly these). */
function solidAttributes(pos: Float32Array, nrm: Float32Array, dmg: Float32Array, dep: Float32Array, soot: Float32Array): Record<string, THREE.BufferAttribute> {
  return {
    position: new THREE.BufferAttribute(pos, 3),
    normal: new THREE.BufferAttribute(nrm, 3),
    aDamage: new THREE.BufferAttribute(dmg, 1),
    aDepth: new THREE.BufferAttribute(dep, 1),
    aSoot: new THREE.BufferAttribute(soot, 1),
  };
}

/**
 * Largest distance r ≤ 400 m from the charge along `dir` at which `loaded(point)` still holds,
 * for a predicate that holds near the charge and fails beyond some range (bisection, 24 steps).
 * `known` is a distance where it is known to hold.
 */
function blastReach(load: BlastLoad, dir: THREE.Vector3, loaded: (p: THREE.Vector3) => boolean, known: number): number {
  const q = new THREE.Vector3();
  const at = (r: number) => loaded(q.copy(load.center).addScaledVector(dir, r));
  let lo = known, hi = Math.max(2 * known, 1);
  while (hi < 400 && at(hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi >= 400) return 400;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    if (at(mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Recent detonations per simulation (for the contact-gain limit's blast exemption). */
const blastMarks = new WeakMap<SimContext, { x: number; y: number; z: number; r: number; t: number }[]>();

/**
 * True while a detonation's pushes may still be arriving at world point p: within its reach
 * (Z = 25 m/kg^⅓, where the Kingery–Bulmash incident overpressure is down to ~3 kPa and body
 * pushes are negligible) until its front has passed plus PUSH_GRACE (fronts outrun sound).
 */
function recentBlastNear(ctx: SimContext, p: THREE.Vector3, now: number): boolean {
  for (const m of watchBlasts(ctx)) {
    const d = Math.hypot(p.x - m.x, p.y - m.y, p.z - m.z);
    if (d < m.r && now >= m.t - 1e-6 && now - m.t <= d / 340 + PUSH_GRACE) return true;
  }
  return false;
}

/** The recent-detonation list of a simulation; the first call subscribes to its 'blast' events. */
function watchBlasts(ctx: SimContext): { x: number; y: number; z: number; r: number; t: number }[] {
  let list = blastMarks.get(ctx);
  if (!list) {
    const l: { x: number; y: number; z: number; r: number; t: number }[] = [];
    blastMarks.set(ctx, l);
    ctx.events.on('blast', (e) => {
      const t = e.time;
      for (let i = l.length - 1; i >= 0; i--) if (t - l[i]!.t > 2) l.splice(i, 1);
      l.push({ x: e.center.x, y: e.center.y, z: e.center.z, r: 25 * Math.cbrt(Math.max(1e-3, e.tntKg)), t });
    });
    list = l;
  }
  return list;
}
