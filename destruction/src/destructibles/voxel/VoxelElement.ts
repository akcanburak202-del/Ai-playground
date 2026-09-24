import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SimContext, VoxelElementSpec } from '../../app/contracts.ts';
import { AIR_DENSITY, G } from '../../core/units.ts';
import { MATERIALS, type MaterialProps } from '../../physics/materials.ts';
import type { PhysicsOwner, ContactForceInfo } from '../../physics/PhysicsWorld.ts';
import type { BlastLoad, ContactDamage, ImpactEvent, ProbeSegment, ThicknessProbe } from '../../physics/ballistics/types.ts';
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
/** Debris smaller than this (m³, ≈ a 10 cm cube) casts no shadow */
const SHADOW_MIN_VOLUME = 1e-3;
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
const _vSnap = new THREE.Vector3();
const _runs: RunSegment[] = [];

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

export class VoxelElement implements Destructible, Structural, RemeshClient {
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
  private readonly chunkMeshes: (THREE.Mesh | null)[];
  /** Pieces: per-chunk mesh data merged into chunkMeshes[0] */
  private pieceParts: (MeshData | null)[] | null = null;
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
  private eventSeed = 1;
  private invQ = new THREE.Quaternion();
  /** Spawn event id shared with sibling pieces (0 for original elements) */
  private spawnGroup = 0;
  private bornAt = 0;
  private hullCell: { seeds: number[]; index: number } | null = null;
  /** Body velocity at the end of the previous fixed step (contact energy bookkeeping) */
  private readonly prevLin = new THREE.Vector3();

  constructor(ctx: SimContext, spec: VoxelElementSpec, piece?: PieceInit) {
    this.ctx = ctx;
    this.spec = spec;
    this.material = MATERIALS[spec.material];
    this.scheduler = schedulerFor(ctx);
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
    this.chunkMeshes = new Array(this.grid.chunkCount).fill(null);
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
    for (let ci = 0; ci < g.chunkCount; ci++) {
      const a = ci % g.cx, b = Math.floor(ci / g.cx) % g.cy, c = Math.floor(ci / (g.cx * g.cy));
      if (chunkMayHaveSurface(g, a, b, c)) {
        g.dirty[ci] = 1;
        this.scheduler.request(this, ci, prio);
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
    const old = this.chunkMeshes[ci];
    if (old) this.stats.triangles -= (old.geometry.index?.count ?? 0) / 3;
    if (!m) {
      if (old) {
        old.geometry.dispose();
        this.root.remove(old);
        this.chunkMeshes[ci] = null;
      }
      return;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    geom.setAttribute('aDamage', new THREE.BufferAttribute(m.damage, 1));
    geom.setAttribute('aDepth', new THREE.BufferAttribute(m.depth, 1));
    geom.setAttribute('aSoot', new THREE.BufferAttribute(m.soot, 1));
    geom.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geom.computeBoundingSphere();
    this.stats.triangles += m.indexCount / 3;
    if (old) {
      old.geometry.dispose();
      old.geometry = geom;
      return;
    }
    const mesh = new THREE.Mesh(geom, this.look.chunkMaterial);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `${this.name}:chunk${ci}`;
    this.chunkMeshes[ci] = mesh;
    this.root.add(mesh);
  }

  /**
   * Debris pieces span only a few chunks: their chunk meshes are merged into one geometry so a
   * rubble field costs one draw call per piece (and small pieces cast no shadow).
   */
  private setPiecePart(ci: number, m: MeshData | null): void {
    const parts = (this.pieceParts ??= new Array(this.grid.chunkCount).fill(null));
    const old = parts[ci];
    if (old) this.stats.triangles -= old.indexCount / 3;
    parts[ci] = m;
    if (m) this.stats.triangles += m.indexCount / 3;
    let nv = 0, ni = 0;
    for (const q of parts) if (q) { nv += q.vertexCount; ni += q.indexCount; }
    const mesh = this.chunkMeshes[0];
    if (nv === 0) {
      if (mesh) {
        mesh.geometry.dispose();
        this.root.remove(mesh);
        this.chunkMeshes[0] = null;
      }
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
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute('aDamage', new THREE.BufferAttribute(dmg, 1));
    geom.setAttribute('aDepth', new THREE.BufferAttribute(dep, 1));
    geom.setAttribute('aSoot', new THREE.BufferAttribute(soot, 1));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.computeBoundingSphere();
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geom;
    } else {
      const mm = new THREE.Mesh(geom, this.look.debrisMaterial);
      mm.receiveShadow = true;
      mm.name = `${this.name}:chunks`;
      this.chunkMeshes[0] = mm;
      this.root.add(mm);
    }
    this.chunkMeshes[0]!.castShadow = this.grid.solidVolume() >= SHADOW_MIN_VOLUME;
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
    if (!this.rebar) return;
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    this.rebarLen = new THREE.InstancedBufferAttribute(new Float32Array(this.rebar.segCount), 1);
    geo.setAttribute('aLen', this.rebarLen);
    this.rebarMesh = new THREE.InstancedMesh(geo, this.look.rebarMaterial, this.rebar.segCount);
    this.rebarMesh.count = 0;
    // Bars in debris are too thin for their shadows to matter.
    this.rebarMesh.castShadow = !this.dynamic;
    this.rebarMesh.receiveShadow = true;
    this.rebarMesh.frustumCulled = false;
    this.rebarMesh.name = `${this.name}:rebar`;
    this.root.add(this.rebarMesh);
  }

  /** Instance the bar segments that lie in re-meshed chunks (the rest are hidden in concrete). */
  private updateRebarInstances(): void {
    const rb = this.rebar, mesh = this.rebarMesh;
    if (!rb || !mesh || !this.rebarLen) return;
    if (!this.rebarDirty && this.rebarSeen === rb.version) return;
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
    if (this.dynamic) {
      for (let s = 0; s < rb.segCount; s++) place(s);
    } else {
      for (const [ci, list] of rb.chunkSegs) if (this.meshed[ci]) for (const s of list) place(s);
    }
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
    for (let k = b[2]; k <= b[5]; k++)
      for (let j = b[1]; j <= b[4]; j++)
        for (let i = b[0]; i <= b[3]; i++) {
          if (g.density(i, j, k) < ISO) continue;
          if (
            g.density(i - 1, j, k) < ISO || g.density(i + 1, j, k) < ISO || g.density(i, j - 1, k) < ISO ||
            g.density(i, j + 1, k) < ISO || g.density(i, j, k - 1) < ISO || g.density(i, j, k + 1) < ISO
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
    this.mass = this.grid.solidVolume() * this.material.density + (this.rebar?.mass() ?? 0);
    const size = Math.cbrt(this.grid.solidVolume());
    let desc = p.R.ColliderDesc.convexHull(pts);
    if (!desc) {
      const b = this.sampleBox, g = this.grid;
      desc = p.R.ColliderDesc.cuboid(((b[3] - b[0] + 1) * g.h) / 2, ((b[4] - b[1] + 1) * g.h) / 2, ((b[5] - b[2] + 1) * g.h) / 2)
        .setTranslation(g.lx((b[0] + b[3]) / 2), g.ly((b[1] + b[4]) / 2), g.lz((b[2] + b[5]) / 2));
    }
    desc.setMass(Math.max(0.05, this.mass)).setFriction(0.85).setRestitution(0.08);
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
    if (sleeping) this.body.sleep();
  }

  private syncFromBody(): void {
    const b = this.body;
    if (!b) return;
    const t = b.translation(), r = b.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    this.invQ.copy(this.root.quaternion).invert();
    this.updateBounds();
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
    if (dE > 25 * Gf * size * size && this.ctx.physics.dynamicCount < this.ctx.physics.maxDynamicBodies * 0.8) {
      this.pendingSplit = { point: (info.point ?? this.root.position).clone() };
    }
  }

  // ── Destructible: queries ─────────────────────────────────────────────────────────────────

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    if (this.disposed || this.grid.totalSolid === 0) return null;
    this.toLocal(origin, _v);
    this.toLocalDir(dir, _v2);
    if (!traceRay(this.grid, this.sampleBox, this.rebar, _v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z, maxDist, _hit)) return null;
    const bar = _hit.bar >= 0;
    return {
      target: this,
      point: this.toWorld(_hit.x, _hit.y, _hit.z, new THREE.Vector3()),
      normal: this.toWorldDir(_hit.nx, _hit.ny, _hit.nz, new THREE.Vector3()),
      distance: _hit.t,
      material: bar ? REBAR : this.material,
      part: bar ? _hit.bar : undefined,
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
    const eff = k === 'ball' ? (e.ammo.deformable ? 0.15 : 0.35) : k === 'ap' ? 0.6 : 1.0;
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
      const frac = Math.min(1, vol / width / area0);
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
    const barsMoved = this.rebar ? this.bendBars(load, c) : false;
    this.blastAxis = null;
    this.pendingBlast = { load, thickness, until: this.ctx.time.now + 0.5 };
    this.stats.lastCarveMs = performance.now() - t0;
    // Supports only need re-checking when material or bars actually moved; cracking and soot
    // alone just remesh. The static collider must lose the blown-out material now: the thrown
    // plug is flying through it this very step.
    if (this.carver.stats.removed > 0 || barsMoved) {
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
    // element within tens of metres).
    this.bounds.clampPoint(load.center, _v);
    const toC = _v2.copy(load.center).sub(_v);
    if (toC.lengthSq() > 1e-6) {
      toC.normalize();
      if (load.overpressureAt(_v) < 15e3 || load.damageAt(_v, toC, this.material, 0.5 * this.shape.thickness) < 1) return this.shape.thickness;
    }
    const g = this.grid, h = g.h, conn = this.conn;
    const F = conn.F;
    // Coarse surface patches (~10 cm) facing the charge.
    const P = Math.max(1, Math.round(0.1 / (F * h)));
    const cellSize = F * h * P;
    const nx = Math.ceil(conn.nx / P), ny = Math.ceil(conn.ny / P), nz = Math.ceil(conn.nz / P);
    const wp = new THREE.Vector3(), wn = new THREE.Vector3(), n = new THREE.Vector3(), pc = new THREE.Vector3();
    let tSum = 0, tN = 0;
    const breaches: { p: THREE.Vector3; a: THREE.Vector3; t: number; r: number; v: number }[] = [];
    // Damage splats (x, y, z, R, peak), applied together after the scan.
    const splats: number[] = [];
    for (let K = 0; K < nz; K++)
      for (let J = 0; J < ny; J++)
        for (let I = 0; I < nx; I++) {
          // Patch centre sample.
          const si = Math.min(g.nx - 1, Math.round((I + 0.5) * P * F)), sj = Math.min(g.ny - 1, Math.round((J + 0.5) * P * F)), sk = Math.min(g.nz - 1, Math.round((K + 0.5) * P * F));
          pc.set(g.lx(si), g.ly(sj), g.lz(sk));
          // Too far from the charge to matter (checked at the patch centre, with some margin)?
          if (load.overpressureAt(this.toWorld(pc.x, pc.y, pc.z, wp)) < 12e3) continue;
          // Is there a surface in this patch? Look for a solid sample with an air neighbour towards the charge.
          const toC = _v.copy(c).sub(pc);
          const dist = toC.length();
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
          const dmg = load.damageAt(wp, wn, this.material, t);
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
          }
        }
    // Flexural cracking of the whole loaded face in one pass; a repeated blast of similar strength
    // extends the existing crack field only a little (see Carver.damage).
    this.carver.damageBatch(splats, splats.length / 5, seed, BLAST_DAMAGE_ACCUMULATION);
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
      }, barOwner, 0.4);
    }
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
    this.stats.lastReleaseMs = performance.now() - t0;
    if (totalVol > 0) {
      const wc = this.bounds.getCenter(new THREE.Vector3());
      this.ctx.events.emit('fracture', { time: this.ctx.time.now, position: wc, volume: totalVol, pieces: totalPieces, material: this.material });
    }
    if (g.totalSolid === 0) this.fail('support-lost');
    else if (this.dynamic) this.rebuildHull();
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
  private spawnPieces(pieces: Piece[], velocity: (p: Piece, out: THREE.Vector3) => void, barOwner: Int32Array | null, spin: number): number {
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
      if (p.volume < CHIP_VOLUME || size < MIN_PIECE_SIZE * 0.6 || overBudget) {
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
      this.clearColliderUnder(p.grid);
      const piece = new VoxelElement(this.ctx, { ...this.spec, dynamic: true, name: `${this.name}·piece` }, { parent: this, grid: p.grid, rebar, linvel: v, angvel: w, group, cell: p.seeds.length > 3 ? { seeds: p.seeds, index: p.seedIndex } : null });
      this.clearColliderUnderHull(piece);
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
    const made = this.spawnPieces(pieces, (_p, out) => out.set(0, 0, 0), barOwner, 0.8);
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
        this.airDrag(dt);
        const v = this.body.linvel();
        this.prevLin.set(v.x, v.y, v.z);
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.parent?.remove(this.root);
    for (let ci = 0; ci < this.chunkMeshes.length; ci++) {
      const m = this.chunkMeshes[ci];
      if (m) m.geometry.dispose();
      this.chunkMeshes[ci] = null;
    }
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

