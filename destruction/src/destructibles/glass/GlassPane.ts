import * as THREE from 'three';
import type { GlassPaneSpec, SimContext, Vec3Like } from '../../app/contracts.ts';
import { allocateDestructibleId, type Destructible, type RayHit, type Structural } from '../Destructible.ts';
import { material as getMaterial, type MaterialProps } from '../../physics/materials.ts';
import type { BlastLoad, ImpactEvent, ThicknessProbe } from '../../physics/ballistics/types.ts';
import type { Rng } from '../../core/rng.ts';
import { CrackGraph, SEG_ARC, SEG_BOUNDARY, SEG_BRANCH, SEG_HOLE, type Face } from './crackGraph.ts';
import { growStar, holeOutline } from './cracks.ts';
import { CrackRaster } from './raster.ts';
import { pointInPoly, polyArea, polyBounds, polyCentroid, type Poly } from './polygon.ts';
import {
  arealMass, blastFragmentSpeed, blastStar, CRACK_SPEED, DICE_AREA, diceEjectionSpeed, diceSize, GASKET_GRIP, GRAVITY,
  impactStar, LAMINATED_PULLOUT, temperedFails, type GlassType,
} from './model.ts';
import { diceDrag, diceRest, dragA, hash01, landingTime, NEVER, siteRelease, sitePosition, type BreakTiming, type DiceRest } from './dicing.ts';
import { createGlassUniforms, createReflectionMaterial, createTransmissionMaterial, createFittingMaterial, type GlassUniforms } from './look.ts';
import { DICE_CAP, DiceSystem, type DieSpawn } from './DiceSystem.ts';
import { HeapDecal } from './HeapDecal.ts';
import { FloorProbe } from './floor.ts';
import { admitBlast, allowance, spend } from './budget.ts';
import { Membrane } from './membrane.ts';
import { Shards } from './Shards.ts';
import { ReflectionProbes } from './probes.ts';

const TYPE_MATERIAL = { tempered: 'glass_tempered', laminated: 'glass_laminated', annealed: 'glass_annealed' } as const;

/**
 * Absorption of standard clear float glass, 1/m per linear RGB channel: ≈ 0.1 % Fe₂O₃ soda-lime
 * glass transmits ≈ 0.86 / 0.93 / 0.90 through 10 mm (its green cast comes from Fe²⁺ absorption
 * in the red and near infrared; e.g. Pilkington Optifloat datasheets).
 */
const CLEAR_ABSORPTION = [15, 7.3, 10.5];

/** Most dice one pane spawns; larger panes throw proportionally larger clusters of dice. */
const MAX_DICE_PER_PANE = 20000;
/** Dice fade into the heap decal this long after the last one came to rest, s. */
const HEAP_DELAY = 12;
/** Rigid shards one blast release creates per pane (the smaller pieces fly as dice). */
const BLAST_SHARDS = 40;
/** Bucket size of the gone-region lookup grid, m. */
const GONE_CELL = 0.1;
/** Inset of point fittings from the corners, m (typical spider-fitting edge distance). */
const FITTING_INSET = 0.075;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _o = new THREE.Vector3();
const _q = new THREE.Quaternion();

function vec(v: Vec3Like): THREE.Vector3 {
  return v instanceof THREE.Vector3 ? v.clone() : new THREE.Vector3(v[0], v[1], v[2]);
}

/** A region of the pane that has gone (hole or released piece). */
interface Gone {
  outer: Poly;
  holes: Poly[];
  bounds: [number, number, number, number];
}

interface Scheduled {
  time: number;
  face: Face;
}

/** Blast load sampled over the pane: damage number and reflected impulse on a grid. */
interface BlastField {
  nx: number;
  ny: number;
  D: Float64Array;
  I: Float64Array;
  max: number;
  /** Pane-local point of the highest damage */
  ox: number;
  oy: number;
  center: THREE.Vector3;
  contact: boolean;
}

/**
 * One architectural glass pane (see model.ts for the physics and look.ts for the rendering).
 *
 *  - tempered: any penetration of the compressive skin, or blast damage ≥ 1, starts a fracture front
 *    that runs across the pane at 1.5 km/s (drawn by the shader in simulation time), then the crazed
 *    mosaic collapses into ~1 cm dice that pour out of the frame (DiceSystem) and settle into a
 *    glittering heap (HeapDecal).
 *  - annealed: every hit grows a crack star into the pane's crack graph; faces of the graph that lose
 *    their support fall out as rigid shards (Shards) that burst again when they land hard.
 *  - laminated: holes and a spider web in the texture, accumulated damage turns the pane into a
 *    sagging membrane (Membrane) that finally tears out of its frame as one flexible sheet.
 */
export class GlassPane implements Destructible, Structural {
  readonly id = allocateDestructibleId();
  readonly kind = 'glass' as const;
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  readonly structural: Structural = this;
  disposed = false;
  readonly spec: GlassPaneSpec;
  readonly type: GlassType;
  readonly material: MaterialProps;
  readonly width: number;
  readonly height: number;
  readonly thickness: number;
  /** Wall-clock costs for the sandbox HUD / reports, ms */
  readonly stats = { impactMs: 0, blastMs: 0, facesMs: 0, breakMs: 0, diceMs: 0, diceSliceMs: 0, stepMs: 0, frameMs: 0, faces: 0, cracks: 0, dice: 0, shards: 0 };

  private readonly ctx: SimContext;
  private readonly rng: Rng;
  private readonly rnd: () => number;
  private readonly seed: number;
  private readonly tint = new THREE.Color();
  /**
   * Albedo of a die (drawn opaque): four of its six faces are rough fracture surfaces, so like
   * crushed ice or cullet it scatters much of the light back (a heap of clear dice reads pale,
   * glittering green-grey, on asphalt as on stone), coloured by the long paths through the glass:
   * ≈ 0.05 + 0.36 T² per channel, T the pane's through-thickness transmittance (≈ 0.33 for clear
   * float, ≈ 0.1 for body-tinted grey).
   */
  private diceAlbedo: number[] = [0.32, 0.36, 0.34];
  private diceJob: {
    timing: BreakTiming; s: number; d: number; salt: number; nx: number; ny: number; rows: number[]; next: number;
    fadeAt: number; x: number; y: number; impactP: THREE.Vector3 | null; hitR: number; field: BlastField | null;
    heap: Float32Array; heapFloor: Float32Array; nh: number;
  } | null = null;
  private readonly launchScratch = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, c: 0, floor: 0 };
  private readonly landScratch = { floor: 0, ground: 0, t1: 0 };
  private readonly spawnScratch: DieSpawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, release: 0, flight: 0, drag: 0, seed: 0, sx: 0, sy: 0, sz: 0, floor: 0,
    qx: 0, qy: 0, qz: 0, qw: 1, r: 0, g: 0, b: 0, fadeAt: 1e9, cell: 0.008,
  };
  private readonly uniforms: GlassUniforms;
  private readonly cleanTex: THREE.DataTexture;
  private crackTex: THREE.DataTexture | null = null;
  private texFresh = false;
  private fullUploadQueued = false;
  private raster: CrackRaster | null = null;
  private readonly matT: THREE.ShaderMaterial;
  private readonly matR: THREE.MeshPhysicalMaterial;
  private readonly boxGeom: THREE.BufferGeometry;
  private readonly meshT: THREE.Mesh;
  private readonly meshR: THREE.Mesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly inverse = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly normalW = new THREE.Vector3();
  private fittings: { geo: THREE.BufferGeometry; mat: THREE.Material } | null = null;

  // Annealed / laminated crack network
  private graph: CrackGraph | null = null;
  private gone: Gone[] = [];
  /** Coarse bucket grid over the pane (GONE_CELL squares) listing the gone regions that overlap each cell */
  private goneGrid: number[][] | null = null;
  private goneGx = 1;
  private goneArea = 0;
  private facesDirty = false;
  private schedule = new Map<string, Scheduled>();
  private releaseQueue: { face: Face; field: BlastField | null; rigid: boolean; t0: number }[] = [];
  /** Pieces of the crack graph at `version` (releases do not change the graph, so they are reused) */
  private faceCache: { version: number; faces: Face[] } | null = null;
  /**
   * Fresh hits not yet realised on the pieces: pane-local centre, exit-cone radius r (m), and the
   * struck zone (kernel radius R, m; speed v0 its momentum gives the glass under the kernel, m/s)
   */
  private knock: { x: number; y: number; r: number; R: number; v0: number }[] = [];
  /** Unit in-plane direction of gravity (pane-local x, y) and the in-plane share of g, 0..1 */
  private readonly gIn = [0, -1, 1];
  private pendingBlasts: BlastLoad[] = [];
  /** Crack segments left to draw (blast stars are drawn over a few steps) */
  private cracksPending = false;
  private blastWaits = 0;
  private shards: Shards | null = null;
  private lastHit = { x: 0, y: 0, time: -1e9, p: new THREE.Vector3(), R: 0.05 };
  /** Releases are reported as few, aggregated 'shatter' events (sound and dust per burst, not per piece). */
  private shatterArea = 0;
  private readonly shatterAt = new THREE.Vector3();
  private groundArea = 0;
  private readonly groundAt = new THREE.Vector3();
  private lastShatter = -1e9;

  // Tempered
  private broken = false;
  private collapseEnd = Infinity;

  // Laminated
  private membrane: Membrane | null = null;
  private lam: { geom: THREE.BufferGeometry; pos: Float32Array; nrm: Float32Array; ring: number[] } | null = null;
  private lamDirty = false;
  private readonly mb = [0, 0, 0, 0, 0, 0];
  private tearAt = Infinity;
  private torn = false;
  private landed = false;

  // Reflections
  private probes: ReflectionProbes | null | undefined = undefined;

  // Dice and heaps
  private dice: DiceSystem | null = null;
  private decals: HeapDecal[] = [];
  /** DiceSystem write count when this pane's dice started: once the ring has come round past it, the heap shows at once */
  private heapFirst = -1;
  private floor: FloorProbe | null = null;

  // Structure
  private anchors = new Map<string, THREE.Box3>();
  private hadAnchor = false;
  private imposed = 0;

  constructor(ctx: SimContext, spec: GlassPaneSpec) {
    this.ctx = ctx;
    this.spec = spec;
    this.name = spec.name;
    this.type = spec.type;
    this.material = getMaterial(TYPE_MATERIAL[spec.type]);
    this.width = spec.width;
    this.height = spec.height;
    this.thickness = spec.thickness;
    this.rng = ctx.rng.fork();
    this.rnd = () => this.rng.next();
    this.seed = 1 + ((this.id * 7919) % 50000);

    this.root.name = `glass:${spec.name}`;
    this.root.position.copy(vec(spec.position));
    const r = spec.rotation;
    if (r instanceof THREE.Quaternion) this.root.quaternion.copy(r);
    else if (r) this.root.quaternion.setFromEuler(new THREE.Euler(...(r instanceof THREE.Vector3 ? r.toArray() : r)));
    this.root.updateMatrixWorld(true);
    this.matrix.copy(this.root.matrixWorld);
    this.inverse.copy(this.matrix).invert();
    this.quat.copy(this.root.quaternion);
    this.normalW.set(0, 0, 1).applyQuaternion(this.quat);
    const gl = _v.set(0, -1, 0).applyQuaternion(_q.copy(this.quat).invert());
    const gm = Math.hypot(gl.x, gl.y);
    if (gm > 1e-6) this.gIn.splice(0, 3, gl.x / gm, gl.y / gm, gm);
    else this.gIn.splice(0, 3, 0, -1, 0);

    // Tint: internal transmittance through the full thickness at normal incidence.
    if (spec.tint !== undefined) this.tint.setHex(spec.tint);
    else this.tint.setRGB(...(CLEAR_ABSORPTION.map((a) => Math.exp(-a * spec.thickness)) as [number, number, number]));

    this.diceAlbedo = [this.tint.r, this.tint.g, this.tint.b].map((c) => 0.05 + 0.36 * c * c);
    this.cleanTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.cleanTex.needsUpdate = true;
    this.uniforms = createGlassUniforms(this.cleanTex, this.width, this.height, this.thickness, this.seed, this.tint);
    this.matT = createTransmissionMaterial(this.uniforms);
    this.matR = createReflectionMaterial(this.uniforms);
    this.boxGeom = paneBox(this.width, this.height, this.thickness);
    this.meshT = new THREE.Mesh(this.boxGeom, this.matT);
    this.meshR = new THREE.Mesh(this.boxGeom, this.matR);
    this.meshT.name = `glass-t:${spec.name}`;
    this.meshR.name = `glass-r:${spec.name}`;
    this.meshR.receiveShadow = true;
    this.root.add(this.meshT, this.meshR);
    if (!spec.framed) this.addFittings();
    this.updateBounds(0.02);
  }

  // ─── Geometry helpers ────────────────────────────────────────────────────────────────────

  private updateBounds(pad: number): void {
    const w = this.width / 2, h = this.height / 2, t = this.thickness / 2 + pad;
    this.bounds.makeEmpty();
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) this.bounds.expandByPoint(_v.set(sx * w, sy * h, sz * t).applyMatrix4(this.matrix));
  }

  /** World AABB of the (sagging, bulging or fallen) laminated sheet, so registry culling keeps finding it. */
  private membraneBounds(): void {
    const m = this.membrane;
    if (!m) return;
    const b = m.bounds(this.mb);
    const pad = this.thickness / 2 + 0.02;
    this.bounds.makeEmpty();
    for (const sx of [0, 3]) for (const sy of [1, 4]) for (const sz of [2, 5]) {
      this.bounds.expandByPoint(_w.set(b[sx]!, b[sy]!, b[sz]!).applyMatrix4(this.matrix));
    }
    this.bounds.expandByScalar(pad);
  }

  private fittingPoints(): [number, number][] {
    const x = this.width / 2 - FITTING_INSET, y = this.height / 2 - FITTING_INSET;
    return [[-x, -y], [x, -y], [x, y], [-x, y]];
  }

  /** Polished stainless rotule fittings at the corners of frameless glass. */
  private addFittings(): void {
    const geo = new THREE.CylinderGeometry(0.032, 0.032, 1, 24).rotateX(Math.PI / 2);
    const mat = createFittingMaterial();
    this.fittings = { geo, mat };
    const t = this.thickness;
    for (const [x, y] of this.fittingPoints()) {
      const cap = new THREE.Mesh(geo, mat);
      cap.scale.set(1, 1, t + 0.024);
      cap.position.set(x, y, 0);
      const bolt = new THREE.Mesh(geo, mat);
      bolt.scale.set(0.45, 0.45, t + 0.06);
      bolt.position.set(x, y, -0.018);
      for (const m of [cap, bolt]) {
        m.castShadow = true;
        m.receiveShadow = true;
        this.root.add(m);
      }
    }
  }

  private toLocal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).applyMatrix4(this.inverse);
  }

  private toWorld(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).applyMatrix4(this.matrix);
  }

  private ensureRaster(): CrackRaster {
    if (this.raster) return this.raster;
    const r = (this.raster = new CrackRaster(this.width, this.height, 1024));
    const tex = new THREE.DataTexture(r.data, r.w, r.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    tex.onUpdate = () => {
      this.fullUploadQueued = false;
    };
    this.crackTex = tex;
    this.texFresh = true;
    this.uniforms.uCrack.value = tex;
    return r;
  }

  private ensureGraph(): CrackGraph {
    return (this.graph ??= new CrackGraph(this.width, this.height));
  }

  private ensureFloor(): FloorProbe {
    return (this.floor ??= new FloorProbe(this.ctx.physics));
  }

  private ensureDice(): DiceSystem {
    if (!this.dice || this.dice.disposed) this.dice = DiceSystem.acquire(this.ctx);
    return this.dice;
  }

  private ensureShards(): Shards {
    if (this.shards) return this.shards;
    this.shards = new Shards(this.ctx, this.uniforms, this.material, this.thickness, this.width, this.height, {
      dice: (p, area, v) => this.pieceDice(p, area, v, 0.012),
      shatter: (p, area) => {
        this.groundAt.lerp(p, this.groundArea > 0 ? area / (this.groundArea + area) : 1);
        this.groundArea += area;
      },
      contact: (p, impulse, size) => this.ctx.events.emit('debrisContact', { time: this.ctx.time.now, position: p.clone(), impulse, size, material: this.material }),
    }, this.rnd);
    this.ctx.world.add(this.shards.group);
    this.probes?.attach(this.probePosition(), this.shards.reflectionMaterial);
    return this.shards;
  }

  // ─── Destructible: queries ───────────────────────────────────────────────────────────────

  /** Is there still glass at pane-local (x, y)? */
  glassAt(x: number, y: number): boolean {
    if (Math.abs(x) > this.width / 2 || Math.abs(y) > this.height / 2) return false;
    if (this.type === 'tempered') return !this.broken;
    if (this.torn) return false;
    if (this.raster && this.raster.sample(x, y, 2) > 0.5) return false;
    return true;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    if (this.disposed || this.torn || (this.type === 'tempered' && this.broken)) return null;
    const o = this.toLocal(origin, _o);
    const d = _d.copy(dir).transformDirection(this.inverse);
    if (Math.abs(d.z) < 1e-6) return null;
    const half = this.thickness / 2;
    const face = d.z < 0 ? 1 : -1;
    // Laminated glass that sags: intersect the displaced mid-surface (two fixed-point passes).
    let w = 0;
    let s = 0, x = 0, y = 0;
    for (let k = 0; k < (this.membrane ? 3 : 1); k++) {
      if (Math.abs(o.z - w) < half) return null;
      s = (w + face * half - o.z) / d.z;
      x = o.x + s * d.x;
      y = o.y + s * d.y;
      if (!this.membrane) break;
      w = this.membrane.displacementAt(x, y);
    }
    if (s < 0 || s > maxDist) return null;
    if (!this.glassAt(x, y)) return null;
    const point = this.toWorld(x, y, w + face * half, new THREE.Vector3());
    const normal = this.normalW.clone().multiplyScalar(face);
    return { target: this, point, normal, distance: s, material: this.material };
  }

  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    const cos = Math.max(0.05, Math.abs(dir.dot(hit.normal)));
    const run = Math.min(maxDepth, this.thickness / cos);
    let strength = 1;
    const p = this.toLocal(hit.point, _v);
    if (this.type === 'laminated' && this.membrane) strength = 1 - 0.6 * this.membrane.damage[this.membrane.nearest(p.x, p.y)]!;
    else if (this.type === 'annealed' && this.raster && this.raster.maxAround(p.x, p.y, 0.01, 0) > 0.3) strength = 0.6;
    return { segments: [{ material: this.material, start: 0, end: run, strength: Math.max(0.2, strength) }], exits: true };
  }

  // ─── Destructible: impacts ───────────────────────────────────────────────────────────────

  applyImpact(ev: ImpactEvent): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const p = this.toLocal(ev.point, new THREE.Vector3());
    const x = Math.max(-this.width / 2, Math.min(this.width / 2, p.x));
    const y = Math.max(-this.height / 2, Math.min(this.height / 2, p.y));
    const perforated = ev.outcome === 'perforate';
    const r = this.ensureRaster();
    // The through-hole: the tunnel plus chipping at its lip (a clean hole is 1.2–1.8 × the tunnel).
    const tunnel = Math.max(ev.tunnelRadius, 0.4 * ev.ammo.diameter);
    let holeR = perforated ? tunnel * (this.type === 'laminated' ? 1.0 : 1.2 + 0.6 * this.rnd()) : 0;
    // Laminated: where earlier hits have already pulverised both plies (the frost channel), the
    // interlayer alone meets the round; it is punched and tears across the unsupported patch, so
    // a tight group merges into one ragged opening instead of staying a set of bullet holes.
    if (this.type === 'laminated' && holeR > 0) holeR *= 1 + 2.5 * r.sample(x, y, 1);
    // Oblique hits cut an elongated hole, its exit displaced downstream (the in-plane direction of
    // the shot, stretch 1/cos θ, capped where the round would rather ricochet).
    const dl = _d.copy(ev.direction).transformDirection(this.inverse);
    const inPlane = Math.hypot(dl.x, dl.y);
    const cosT = Math.max(Math.abs(dl.z), 0.4);
    const shape = inPlane > 1e-3 ? { ax: dl.x / inPlane, ay: dl.y / inPlane, stretch: 1 / cosT } : undefined;
    const shift = shape ? 0.5 * this.thickness * Math.sqrt(1 - cosT * cosT) / cosT : 0;
    const hx = shape ? x + shape.ax * shift : x, hy = shape ? y + shape.ay * shift : y;
    this.lastHit.x = x;
    this.lastHit.y = y;
    this.lastHit.time = this.ctx.time.now;
    this.lastHit.p.copy(ev.momentum);
    this.lastHit.R = Math.max(0.04, 0.5 * ev.damageRadius);

    if (this.type === 'tempered') {
      if (this.broken) return;
      if (temperedFails(ev.outcome, ev.depth, ev.craterDepth, this.thickness)) {
        if (holeR > 0) r.fillPoly(holeOutline(this.ensureGraph(), hx, hy, holeR, this.rnd, shape));
        this.impactFrost(x, y, ev, holeR);
        this.breakTempered(x, y, { kind: 'impact', ev });
      } else this.impactFrost(x, y, ev, 0);
    } else {
      const g = this.ensureGraph();
      const E = Math.min(ev.energyAbsorbed, 2e5);
      const spec = impactStar(this.type, E * (perforated ? 1 : 0.5), this.thickness, Math.max(holeR, 0.5 * tunnel), Math.hypot(this.width, this.height), this.rnd);
      const res = growStar(g, hx, hy, holeR, spec, this.rnd, (px, py) => this.isGone(px, py), shape);
      if (res.hole.length) this.markGone(res.hole, [], true);
      this.impactFrost(x, y, ev, holeR);
      this.paintCracks();
      if (this.type === 'annealed') {
        // The Hertzian cone the round punches out of the exit face (and the crushed zone at the
        // entry) takes the small fragments at the hole margin with it.
        const R = this.lastHit.R;
        const v0 = ev.momentum.length() / (arealMass(this.material, this.thickness) * Math.PI * R * R);
        this.knock.push({ x, y, r: 1.3 * Math.max(perforated ? ev.spallRadius : 0, 2.2 * holeR, ev.craterRadius), R, v0: Number.isFinite(v0) ? v0 : 0 });
        this.facesDirty = true;
      } else this.laminatedHit(x, y, ev, spec.length);
    }
    // Hertzian cone flake and glitter out of the exit face.
    if (perforated) {
      const out = ev.exitPoint ?? ev.point;
      this.ctx.fx.chips({
        position: out, direction: ev.direction, spread: 0.7, speed: Math.min(40, 6 + 0.02 * ev.residualSpeed),
        count: Math.min(40, 6 + ev.energyAbsorbed / 40), size: 0.004, color: this.material.color, kind: 'glass',
      });
    }
    this.stats.impactMs = performance.now() - t0;
  }

  /** Crushed halo, Hertzian cone flake and micro-cracks around an impact. */
  private impactFrost(x: number, y: number, ev: ImpactEvent, holeR: number): void {
    const r = this.ensureRaster();
    const s = (this.seed * 131 + Math.floor(this.ctx.time.now * 997)) % 10007;
    const crush = Math.max(ev.craterRadius, 1.5 * holeR, 0.003);
    const cone = Math.max(ev.spallRadius, 2.2 * holeR);
    r.halo(x, y, 0.55 * crush, 1.15 * crush, 0.9, s);
    if (cone > 0) r.halo(x, y, 0.4 * cone, cone, 0.6, s + 7);
    if (this.type === 'laminated') {
      // PVB delamination: a milky ring well beyond the crushed zone.
      r.halo(x, y, 1.1 * cone, 2.4 * cone + 0.008, 0.22, s + 13, 1, 0.5);
    }
    // Micro-cracks radiating from the crushed zone.
    const n = Math.round((this.type === 'laminated' ? 5 : 10) + (this.type === 'laminated' ? 6 : 16) * this.rnd());
    const R = Math.max(cone, crush) * 2.2;
    for (let k = 0; k < n; k++) {
      const a = this.rnd() * Math.PI * 2;
      const r0 = crush * (0.6 + 0.5 * this.rnd());
      const r1 = r0 + (R - r0) * (0.2 + 0.8 * this.rnd());
      const b = a + (this.rnd() - 0.5) * 0.4;
      r.line(x + r0 * Math.cos(a), y + r0 * Math.sin(a), x + r1 * Math.cos(b), y + r1 * Math.sin(b), 0.0002, this.type === 'laminated' ? 0.4 : 0.55);
    }
  }

  /** Draw the crack segments added since the last call into the damage texture. */
  /**
   * Draw the crack segments not drawn yet into the raster. With a budget (blasts), what is left over
   * is drawn by the next steps: the lines of a big star appear over a few steps.
   */
  private paintCracks(budgetMs = Infinity): void {
    const g = this.graph;
    const r = this.raster;
    if (!g || !r) return;
    const t0 = budgetMs < Infinity ? performance.now() : 0;
    this.cracksPending = false;
    for (let s = 0, n = 0; s < g.segmentCount; s++) {
      if (!g.live[s] || g.painted[s]) continue;
      if ((++n & 15) === 0 && budgetMs < Infinity && performance.now() - t0 > budgetMs) {
        this.cracksPending = true;
        break;
      }
      g.painted[s] = 1;
      const k = g.kind[s]!;
      if (k === SEG_BOUNDARY || k === SEG_HOLE) continue;
      const a = g.sa[s]!, b = g.sb[s]!;
      const width = k === SEG_ARC ? 0.00028 : k === SEG_BRANCH ? 0.0003 : 0.00036;
      const I = k === SEG_ARC ? 0.8 : k === SEG_BRANCH ? 0.85 : 0.95;
      r.line(g.vx[a]!, g.vy[a]!, g.vx[b]!, g.vy[b]!, width, I);
    }
    this.stats.cracks = g.crackCount();
  }

  // ─── Gone regions ────────────────────────────────────────────────────────────────────────

  private goneCell(x: number, y: number): number {
    const gx = this.goneGx, gy = this.goneGrid!.length / gx;
    const i = Math.min(gx - 1, Math.max(0, Math.floor((x + this.width / 2) / GONE_CELL)));
    const j = Math.min(gy - 1, Math.max(0, Math.floor((y + this.height / 2) / GONE_CELL)));
    return j * gx + i;
  }

  private isGone(x: number, y: number): boolean {
    const grid = this.goneGrid;
    if (!grid) return false;
    const cell = grid[this.goneCell(x, y)]!;
    for (let c = 0; c < cell.length; c++) {
      const q = this.gone[cell[c]!]!;
      const b = q.bounds;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (!pointInPoly(q.outer, x, y)) continue;
      let inHole = false;
      for (const h of q.holes) if (pointInPoly(h, x, y)) inHole = true;
      if (!inHole) return true;
    }
    return false;
  }

  /** Paint released pieces: one fill when (almost) nothing is left, otherwise piece by piece. */
  private paintGone(faces: Face[]): void {
    const r = this.ensureRaster();
    if (this.goneArea > 0.97 * this.width * this.height) {
      r.fillAll(2);
      return;
    }
    // Pieces that left together: fill them; the edges against what stays are crack lines already.
    for (const f of faces) r.fillPoly(f.outer, f.holes, 2, false);
  }

  private markGone(outer: Poly, holes: Poly[], paint: boolean): void {
    const b = polyBounds(outer);
    const id = this.gone.length;
    this.gone.push({ outer, holes, bounds: b });
    if (!this.goneGrid) {
      this.goneGx = Math.max(1, Math.ceil(this.width / GONE_CELL));
      this.goneGrid = Array.from({ length: this.goneGx * Math.max(1, Math.ceil(this.height / GONE_CELL)) }, () => []);
    }
    const i0 = this.goneCell(b[0], b[1]), i1 = this.goneCell(b[2], b[3]);
    const gx = this.goneGx;
    for (let j = Math.floor(i0 / gx); j <= Math.floor(i1 / gx); j++) for (let i = i0 % gx; i <= i1 % gx; i++) this.goneGrid[j * gx + i]!.push(id);
    this.goneArea += Math.max(0, polyArea(outer) + holes.reduce((s, h) => s + polyArea(h), 0));
    if (paint) this.paintPiece(outer, holes);
  }

  private paintPiece(outer: Poly, holes: Poly[]): void {
    const r = this.ensureRaster();
    r.fillPoly(outer, holes);
    // The fresh fracture edge left in the frame: a band of conchoidal chipping, frosted and
    // catching light (the only thing that shows a hole in clear glass).
    const w = Math.max(0.0012, 0.25 * this.thickness);
    for (const ring of [outer, ...holes]) {
      const n = ring.length >> 1;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        r.line(ring[2 * j]!, ring[2 * j + 1]!, ring[2 * i]!, ring[2 * i + 1]!, 0.0004, 1);
        r.band(ring[2 * j]!, ring[2 * j + 1]!, ring[2 * i]!, ring[2 * i + 1]!, w, 0.7);
      }
    }
  }

  // ─── Annealed: which pieces fall ─────────────────────────────────────────────────────────

  /** Pieces of the current crack graph (cached until the graph changes). */
  private currentFaces(g: CrackGraph): Face[] {
    if (!this.faceCache || this.faceCache.version !== g.version) this.faceCache = { version: g.version, faces: g.faces() };
    return this.faceCache.faces;
  }

  /**
   * Which pieces stay in the frame. A cracked pane is a masonry of glass: every piece bears on the
   * pieces below it through their crack faces, down to the sill (the wedge between two radial
   * cracks above a hole is a keystone and stays), so support is propagated upward from the frame
   * along contacts whose outward normal points down the pane (in-plane gravity). Framed: the sill
   * carries what bears on it; a piece touching only the side/head gaskets is held by their grip
   * (GASKET_GRIP × contact length) but works loose after a while (the "guillotine" shard).
   * Point-fixed: the pieces holding a fitting carry the rest. Returns 0 = falls, 1 = held,
   * 2 = held by gasket friction only (falls later).
   */
  private support(faces: Face[], gone: Uint8Array): Uint8Array {
    const n = faces.length;
    const held = new Uint8Array(n);
    const bear = new Float64Array(n);
    const [gx, gy, gm] = this.gIn as [number, number, number];
    const q = arealMass(this.material, this.thickness) * GRAVITY;
    const stack: number[] = [];
    for (let k = 0; k < n; k++) {
      if (gone[k]) continue;
      const f = faces[k]!;
      if (this.spec.framed) {
        let sill = 0, grip = 0;
        const L = f.links;
        for (let i = 0; i < L.length; i += 4) {
          if (L[i]! >= 0) continue;
          const down = L[i + 2]! * gx + L[i + 3]! * gy;
          if (down > 0.5 && gm > 0.3) sill += L[i + 1]!;
          else grip += L[i + 1]!;
        }
        if (sill > 0.01) held[k] = 1;
        else if (grip * GASKET_GRIP > 1.5 * q * f.area) held[k] = 2;
      } else {
        for (const [fx, fy] of this.fittingPoints()) if (pointInPoly(f.outer, fx, fy)) held[k] = 1;
      }
    }
    // Gasket-held seeds go to the bottom of the stack, so full support propagates first and a piece
    // bearing on both kinds of neighbour counts as fully held.
    for (let k = 0; k < n; k++) if (held[k] === 2) stack.push(k);
    for (let k = 0; k < n; k++) if (held[k] === 1) stack.push(k);
    // A (nearly) horizontal pane has no in-plane load path: loose pieces drop through.
    if (gm < 0.3) return held;
    while (stack.length) {
      const j = stack.pop()!;
      const L = faces[j]!.links;
      for (let i = 0; i < L.length; i += 4) {
        const k = L[i]!;
        if (k < 0 || gone[k] || held[k]) continue;
        // Piece k presses on j where j's outward normal points up the pane (k lies above j).
        const up = -(L[i + 2]! * gx + L[i + 3]! * gy);
        if (up <= 0.1) continue;
        bear[k] += L[i + 1]! * up;
        // Enough bearing length that the piece cannot rotate off a point contact.
        if (bear[k] >= Math.min(0.03, 0.15 * Math.sqrt(faces[k]!.area))) {
          held[k] = held[j] === 2 ? 2 : 1;
          stack.push(k);
        }
      }
    }
    return held;
  }

  /**
   * Decide the fate of every piece still in the frame (see `support`). Pieces a fresh round has
   * punched out (inside its exit cone) leave at once with the round's momentum; unsupported pieces
   * slide out after a moment; the release of a piece re-runs the check, so a hole grows upward as
   * the pieces above it lose their bearing, and sustained fire eats the pane away progressively.
   */
  private evaluateFaces(field: BlastField | null): void {
    const g = this.graph;
    if (!g) return;
    const t0 = performance.now();
    const faces = this.currentFaces(g);
    this.stats.faces = faces.length;
    const now = this.ctx.time.now;
    const next = new Map<string, Scheduled>();
    const gone = new Uint8Array(faces.length);
    for (let k = 0; k < faces.length; k++) gone[k] = this.isGone(faces[k]!.sample[0], faces[k]!.sample[1]) ? 1 : 0;
    // Blast releases are painted in one go afterwards (usually the whole pane goes at once); the
    // largest pieces fly as rigid shards, the many small ones as dice (bounded cost per blast).
    const blasted: Face[] = [];
    if (field) {
      for (let k = 0; k < faces.length; k++) {
        const f = faces[k]!;
        if (!gone[k] && sampleField(field, field.D, f.sample[0], f.sample[1], this.width, this.height) >= 1) {
          blasted.push(f);
          gone[k] = 1;
        }
      }
      // Largest first: they become the rigid shards and are spawned in the first steps.
      blasted.sort((a, b) => b.area - a.area);
      blasted.forEach((f, k) => {
        this.markGone(f.outer, f.holes, false);
        this.releaseQueue.push({ face: f, field, rigid: k < BLAST_SHARDS, t0: this.ctx.time.now });
      });
      this.runReleaseQueue(4);
    }
    // Fresh hits: pieces lying wholly inside the exit cone are punched out; loose pieces (not
    // clamped by the frame) are shaken out when the round's momentum, shared over the struck zone
    // (Gaussian kernel of radius R: Δv = v0·e^(−r²/R²), a large piece spreading its share over its
    // own mass), exceeds what friction on their crack faces arrests within one glass thickness of
    // travel: v_c = √(2 μ g t), μ ≈ 0.9 for glass on glass.
    if (this.knock.length) {
      const vc = Math.sqrt(2 * 0.9 * GRAVITY * this.thickness);
      for (let k = 0; k < faces.length; k++) {
        if (gone[k]) continue;
        const f = faces[k]!;
        const b = f.bounds;
        let loose = true;
        for (let i = 0; i < f.links.length && loose; i += 4) if (f.links[i]! < 0) loose = false;
        for (const h of this.knock) {
          let out = false;
          if (!(b[0] > h.x + h.r || b[2] < h.x - h.r || b[1] > h.y + h.r || b[3] < h.y - h.r)) {
            out = true;
            for (let i = 0; i < f.outer.length && out; i += 2) {
              const dx = f.outer[i]! - h.x, dy = f.outer[i + 1]! - h.y;
              if (dx * dx + dy * dy > h.r * h.r) out = false;
            }
          }
          if (!out && loose && h.v0 > vc) {
            const dx = f.sample[0] - h.x, dy = f.sample[1] - h.y;
            const zone = Math.PI * h.R * h.R;
            out = h.v0 * Math.exp(-(dx * dx + dy * dy) / (h.R * h.R)) * Math.min(1, zone / f.area) > vc;
          }
          if (!out) continue;
          // The hole shows at once; the piece's body is spawned within the step budget (a burst
          // can punch out a dozen pieces at once), starting where its flight has taken it.
          this.markGone(f.outer, f.holes, true);
          this.releaseQueue.push({ face: f, field: null, rigid: true, t0: now });
          gone[k] = 1;
          break;
        }
      }
      this.knock.length = 0;
    }
    const held = this.support(faces, gone);
    for (let k = 0; k < faces.length; k++) {
      if (gone[k] || held[k] === 1) continue;
      const f = faces[k]!;
      const late = held[k] === 2;
      if (f.area < DICE_AREA && !late) {
        this.releaseFace(f, null);
        continue;
      }
      const key = `${Math.round(f.sample[0] * 2000)},${Math.round(f.sample[1] * 2000)},${Math.round(f.area * 1e6)}`;
      const prev = this.schedule.get(key);
      const delay = late ? 3 + 25 * this.rnd() : 0.03 + 0.25 * this.rnd();
      next.set(key, prev ?? { time: now + delay, face: f });
    }
    this.schedule = next;
    if (blasted.length) this.paintGone(blasted);
    this.stats.facesMs = performance.now() - t0;
  }

  /** A piece leaves the frame: as a rigid shard, or as dice when it is tiny. */
  private releaseFace(f: Face, field: BlastField | null, paint = true, rigid = true): void {
    this.markGone(f.outer, f.holes, paint);
    this.spawnPiece(f, field, rigid, 0);
  }

  /**
   * Spawn blast-released pieces within `budgetMs` per step. Pieces already count as gone (the pane
   * shows the hole at once); one spawned `age` s late starts where its free flight has taken it.
   */
  private runReleaseQueue(budgetMs: number): void {
    const t0 = performance.now();
    let k = 0;
    const q = this.releaseQueue;
    while (k < q.length) {
      const r = q[k++]!;
      this.spawnPiece(r.face, r.field, r.rigid, this.ctx.time.now - r.t0);
      if (performance.now() - t0 > budgetMs) break;
    }
    q.splice(0, k);
  }

  /** The physical piece of a released face: a rigid shard, or dice when small. */
  private spawnPiece(f: Face, field: BlastField | null, rigid: boolean, age: number): void {
    const c = polyCentroid(f.outer);
    const v = new THREE.Vector3();
    const w = new THREE.Vector3();
    if (field) {
      // Blast: impulse–momentum of the free fragment, away from the charge.
      const I = sampleField(field, field.I, c[0], c[1], this.width, this.height);
      const sp = blastFragmentSpeed(I, this.material.density, this.thickness) * (0.85 + 0.3 * this.rnd());
      this.toWorld(c[0], c[1], 0, _v);
      _d.copy(_v).sub(field.center);
      if (_d.dot(this.normalW) * this.normalW.dot(_w.copy(this.bounds.getCenter(_o)).sub(field.center)) < 0) _d.reflect(this.normalW);
      _d.normalize();
      v.copy(_d).multiplyScalar(sp);
      w.set(this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5).multiplyScalar(Math.min(40, sp * 0.8));
    } else {
      // Gravity release: the piece tips out of the frame; near a fresh hit it carries some of the
      // bullet's momentum (spread over the struck zone).
      const side = this.rnd() < 0.5 ? -1 : 1;
      v.copy(this.normalW).multiplyScalar(side * (0.05 + 0.25 * this.rnd()));
      const since = this.ctx.time.now - this.lastHit.time;
      const dx = c[0] - this.lastHit.x, dy = c[1] - this.lastHit.y;
      const R = this.lastHit.R;
      if (since < 0.4 && dx * dx + dy * dy < 4 * R * R) {
        const m = arealMass(this.material, this.thickness) * Math.PI * R * R;
        v.addScaledVector(this.lastHit.p, Math.min(8, 1 / Math.max(m, 1e-3)) * Math.exp(-(dx * dx + dy * dy) / (R * R)));
      }
      _v.set(1, 0, 0).applyQuaternion(this.quat);
      w.copy(_v).multiplyScalar((this.rnd() - 0.5) * 6);
    }
    const shards = f.area >= DICE_AREA && rigid ? this.ensureShards() : null;
    if (!shards || !shards.add({ outer: f.outer, holes: f.holes, linvel: v, angvel: w, age }, this.matrix)) {
      this.pieceDice(this.toWorld(c[0], c[1], 0, new THREE.Vector3()), f.area, v, 0.01, age);
    }
    this.stats.shards = this.shards?.count ?? 0;
    this.toWorld(c[0], c[1], 0, _v);
    this.shatterAt.lerp(_v, this.shatterArea > 0 ? f.area / (this.shatterArea + f.area) : 1);
    this.shatterArea += f.area;
  }

  /**
   * Floor height a die thrown from (x, y, z) with velocity v lands on, and its flight time: solve
   * once against the floor under the release point, then again against the floor under the landing
   * point (a die thrown off a podium lands on the ground below it, not in mid-air).
   */
  private landing(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: number, half: number, out: { floor: number; ground: number; t1: number }): void {
    const floor = this.ensureFloor();
    let g = floor.heightAt(x, z, y);
    let t1 = landingTime(y, vy, c, g + half);
    const A = dragA(c, t1);
    const g2 = floor.heightAt(x + vx * A, z + vz * A, y);
    if (g2 !== g) {
      g = g2;
      t1 = landingTime(y, vy, c, g + half);
    }
    out.floor = g + half;
    out.ground = g;
    out.t1 = t1;
  }

  /** Small bits of glass (crumbs of a shard, slivers of a pane) as dice. */
  private pieceDice(p: THREE.Vector3, area: number, v: THREE.Vector3, size: number, age = 0): void {
    const n = Math.max(1, Math.min(24, Math.round(area / (size * size))));
    const s = Math.sqrt(area / n);
    const ds = this.ensureDice();
    const floor = this.ensureFloor();
    const now = this.ctx.time.now - age;
    const sp = this.spawnScratch;
    const albedo = this.diceAlbedo;
    const spread = 0.35 + 0.15 * v.length();
    const L = Math.sqrt(area);
    for (let k = 0; k < n; k++) {
      const vx = v.x + (this.rnd() - 0.5) * spread, vy = v.y + (this.rnd() - 0.3) * spread, vz = v.z + (this.rnd() - 0.5) * spread;
      const x = p.x + (this.rnd() - 0.5) * L, y = p.y + (this.rnd() - 0.5) * 0.02, z = p.z + (this.rnd() - 0.5) * L;
      const c = diceDrag(s, this.thickness, Math.hypot(vx, vy, vz));
      this.landing(x, y, z, vx, vy, vz, c, 0.45 * Math.min(s, this.thickness), this.landScratch);
      const fl = this.landScratch.floor;
      _q.setFromUnitVectors(_n.set(0, 0, 1), _w.set(this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5).normalize());
      sp.x = x; sp.y = y; sp.z = z;
      sp.vx = vx; sp.vy = vy; sp.vz = vz;
      sp.release = now;
      sp.flight = this.landScratch.t1;
      sp.drag = c;
      sp.seed = this.rnd();
      sp.sx = s;
      sp.sy = s * (0.7 + 0.5 * this.rnd());
      sp.sz = this.thickness;
      sp.floor = fl;
      sp.qx = _q.x; sp.qy = _q.y; sp.qz = _q.z; sp.qw = _q.w;
      sp.r = albedo[0]!; sp.g = albedo[1]!; sp.b = albedo[2]!;
      sp.fadeAt = 1e9;
      sp.cell = s;
      ds.write(sp);
    }
    this.stats.dice += n;
  }

  // ─── Tempered: dicing ────────────────────────────────────────────────────────────────────

  /**
   * The tempered pane fails from (x, y): the front runs out at 1.5 km/s, the crazed mosaic holds for
   * a moment, then every die leaves with the velocity the cause gives it (tempering energy release,
   * bullet momentum, blast impulse) plus gravity.
   */
  private breakTempered(x: number, y: number, cause: { kind: 'impact'; ev: ImpactEvent } | { kind: 'blast'; field: BlastField } | { kind: 'support' }): void {
    if (this.broken) return;
    const t0 = performance.now();
    this.broken = true;
    const W = this.width, H = this.height, T = this.thickness;
    const now = this.ctx.time.now;
    const blast = cause.kind === 'blast';
    const framed = this.spec.framed;
    const timing: BreakTiming = {
      ox: x + W / 2, oy: y + H / 2, t0: now,
      hold: blast ? 0.002 : framed ? 0.06 : 0.025,
      unzip: blast ? 1e6 : framed ? 9 : 16,
      bite: framed ? 0.012 : 0,
      fitting: framed ? 0 : 0.07,
    };
    const ds = this.ensureDice();
    const d = diceSize(this.material);
    const s = Math.max(d, Math.sqrt((W * H) / ds.budget(now, MAX_DICE_PER_PANE)));
    const salt = this.seed;
    this.uniforms.uBreak.value.set(timing.ox, timing.oy, now, 1);
    this.uniforms.uCollapse.value.set(timing.hold, timing.unzip, timing.bite, timing.fitting);
    this.uniforms.uDice.value.set(s, d);
    // Latest release and a conservative time by which every die has come to rest (fall from the
    // top of the pane, one hop and a slide), so dice can be spawned over several frames.
    const diag = Math.hypot(W, H);
    this.collapseEnd = now + 1.5 * timing.hold + diag / CRACK_SPEED + (timing.unzip < 1e5 ? diag / timing.unzip : 0);
    const fall = Math.max(0.5, this.bounds.max.y - this.ensureFloor().heightAt(this.root.position.x, this.root.position.z, this.bounds.min.y + 0.05) + 1);
    const fadeAt = this.collapseEnd + Math.sqrt((2 * fall) / GRAVITY) + 1.5 + HEAP_DELAY;
    const nx = Math.ceil(W / s), ny = Math.ceil(H / s);
    // Rows centre-out from the origin, so the first frames spawn the dice that leave first.
    const j0 = Math.min(ny - 1, Math.max(0, Math.floor(timing.oy / s)));
    const rows: number[] = [j0];
    for (let k = 1; rows.length < ny; k++) {
      if (j0 + k < ny) rows.push(j0 + k);
      if (j0 - k >= 0) rows.push(j0 - k);
    }
    this.heapFirst = ds.spawned;
    this.diceJob = {
      timing, s, d, salt, nx, ny, rows, next: 0, fadeAt, x, y,
      impactP: cause.kind === 'impact' ? cause.ev.momentum.clone() : null,
      hitR: cause.kind === 'impact' ? Math.max(0.05, 0.4 * cause.ev.damageRadius) : 1,
      field: cause.kind === 'blast' ? cause.field : null,
      heap: new Float32Array(2 * nx * ny), heapFloor: new Float32Array(nx * ny), nh: 0,
    };
    this.runDiceJob(8);
    this.goneArea = W * H;
    // The whole pane lets go: glitter burst at the origin and the shatter event (sound, FX).
    const origin = this.toWorld(x, y, 0, new THREE.Vector3());
    const away = blast ? Math.sign(_v.copy(this.bounds.getCenter(_o)).sub(cause.field.center).dot(this.normalW)) || 1 : -1;
    this.ctx.fx.chips({ position: origin, direction: this.normalW.clone().multiplyScalar(away), spread: 1.3, speed: blast ? 25 : 4, count: 60, size: 0.005, color: this.material.color, kind: 'glass' });
    this.ctx.events.emit('shatter', { time: now, position: this.bounds.getCenter(new THREE.Vector3()), area: W * H, material: this.material });
    this.ctx.structure.touch(this);
    // Cost of the frame the pane broke in (the dice spawn continues over the next frames).
    this.stats.breakMs = performance.now() - t0;
  }

  /**
   * Spawn the dice of a broken tempered pane, row by row, within `budgetMs` of wall-clock time per
   * call (continued every fixed step until done).
   */
  private runDiceJob(budgetMs: number): void {
    const job = this.diceJob;
    if (!job) return;
    const t0 = performance.now();
    if (job.next >= job.rows.length) {
      // All dice written (previous frame): the heap decals get a frame of their own.
      this.diceJob = null;
      this.buildHeaps(job.heap.subarray(0, 2 * job.nh), job.heapFloor.subarray(0, job.nh), job.d, job.s, job.fadeAt, this.ensureDice());
      this.stats.diceMs += performance.now() - t0;
      return;
    }
    const W = this.width, H = this.height, T = this.thickness;
    const { s, d, salt, nx, timing } = job;
    const ds = this.ensureDice();
    const floor = this.ensureFloor();
    const vEj = diceEjectionSpeed(this.material);
    const site: [number, number] = [0, 0];
    const rest: DiceRest = { t1: 0, t2: 0, t3: 0, x: 0, z: 0 };
    const launch = this.launchScratch;
    const sp = this.spawnScratch;
    const hitM = arealMass(this.material, T) * Math.PI * job.hitR * job.hitR;
    const albedo = this.diceAlbedo;
    const field = job.field;
    const blastDirSign = field ? Math.sign(_v.copy(this.bounds.getCenter(_o)).sub(field.center).dot(this.normalW)) || 1 : 1;
    const half = 0.45 * Math.min(s, T);
    sp.sx = sp.sy = s * 0.96;
    sp.sz = T;
    sp.qx = this.quat.x; sp.qy = this.quat.y; sp.qz = this.quat.z; sp.qw = this.quat.w;
    sp.cell = d;
    sp.fadeAt = job.fadeAt;
    while (job.next < job.rows.length) {
      const j = job.rows[job.next++]!;
      for (let i = 0; i < nx; i++) {
        sitePosition(i, j, s, salt, W, H, site);
        const rel = siteRelease(timing, site[0], site[1], hash01(i, j, salt + 2), W, H);
        if (rel >= NEVER) continue;
        const lx = site[0] - W / 2, ly = site[1] - H / 2;
        this.toWorld(lx, ly, 0, _v);
        // Tempering energy release: mostly out of plane, either side.
        const side = hash01(i, j, salt + 4) < 0.5 ? -1 : 1;
        const e = vEj * (0.4 + 1.2 * hash01(i, j, salt + 5));
        _w.copy(this.normalW).multiplyScalar(side * e * 0.8);
        _d.set(hash01(i, j, salt + 6) - 0.5, hash01(i, j, salt + 7) - 0.5, 0).applyQuaternion(this.quat);
        _w.addScaledVector(_d, e);
        if (job.impactP) {
          // The bullet's momentum, shared by the dice of the struck zone (out of the exit face).
          const dx = lx - job.x, dy = ly - job.y;
          const f = Math.exp(-(dx * dx + dy * dy) / (job.hitR * job.hitR));
          if (f > 1e-3) _w.addScaledVector(job.impactP, Math.min(12, (f / hitM) * (0.6 + 0.8 * hash01(i, j, salt + 8))));
        } else if (field) {
          const I = sampleField(field, field.I, lx, ly, W, H);
          const v = blastFragmentSpeed(I, this.material.density, T) * (0.8 + 0.4 * hash01(i, j, salt + 8));
          _d.copy(_v).sub(field.center).normalize();
          if (_d.dot(this.normalW) * blastDirSign < 0) _d.reflect(this.normalW);
          _w.addScaledVector(_d, v);
        }
        const c = diceDrag(s, T, _w.length());
        this.landing(_v.x, _v.y, _v.z, _w.x, _w.y, _w.z, c, half, this.landScratch);
        const flo = this.landScratch.ground;
        const fl = this.landScratch.floor;
        const t1 = this.landScratch.t1;
        launch.x = _v.x; launch.y = _v.y; launch.z = _v.z;
        launch.vx = _w.x; launch.vy = _w.y; launch.vz = _w.z;
        launch.c = c;
        launch.floor = fl;
        diceRest(launch, rest, t1);
        job.heap[2 * job.nh] = rest.x;
        job.heap[2 * job.nh + 1] = rest.z;
        job.heapFloor[job.nh++] = flo;
        const shade = 0.85 + 0.3 * hash01(i, j, salt + 9);
        sp.x = _v.x; sp.y = _v.y; sp.z = _v.z;
        sp.vx = _w.x; sp.vy = _w.y; sp.vz = _w.z;
        sp.release = rel;
        sp.flight = t1;
        sp.drag = c;
        sp.seed = hash01(i, j, salt + 3);
        sp.floor = fl;
        sp.r = albedo[0]! * shade;
        sp.g = albedo[1]! * shade;
        sp.b = albedo[2]! * shade;
        ds.write(sp);
        this.stats.dice++;
      }
      if (performance.now() - t0 > budgetMs) break;
    }
    ds.flush();
    const ms = performance.now() - t0;
    this.stats.diceMs += ms;
    this.stats.diceSliceMs = Math.max(this.stats.diceSliceMs, ms);
  }

  /** One heap decal per floor level the dice came to rest on. */
  private buildHeaps(points: Float32Array, floors: Float32Array, die: number, cover: number, fadeAt: number, ds: DiceSystem): void {
    const counts = new Map<number, number>();
    for (let i = 0; i < floors.length; i++) {
      const key = Math.round(floors[i]! / 0.03);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, n] of counts) {
      if (n < 60) continue;
      const pts = new Float32Array(2 * n);
      let k = 0;
      for (let i = 0; i < floors.length; i++) {
        if (Math.round(floors[i]! / 0.03) !== key) continue;
        pts[k++] = points[2 * i]!;
        pts[k++] = points[2 * i + 1]!;
      }
      // Same body colour as the dice it replaces (a little lighter: the heap also scatters from below).
      const a = this.diceAlbedo;
      const tint = new THREE.Color(1.4 * a[0]!, 1.4 * a[1]!, 1.4 * a[2]!);
      const decal = new HeapDecal(pts, key * 0.03, die, cover, tint, fadeAt, ds.time);
      this.decals.push(decal);
      this.ctx.world.add(decal.mesh);
    }
  }

  // ─── Laminated ───────────────────────────────────────────────────────────────────────────

  private ensureMembrane(): Membrane {
    if (this.membrane) return this.membrane;
    const m = new Membrane({
      width: this.width, height: this.height, thickness: this.thickness, density: this.material.density,
      spacing: Math.max(0.06, Math.max(this.width, this.height) / 26), framed: this.spec.framed,
    });
    _q.copy(this.quat).invert();
    const g = _v.set(0, -GRAVITY, 0).applyQuaternion(_q);
    m.gravity[0] = g.x; m.gravity[1] = g.y; m.gravity[2] = g.z;
    const up = _v.set(0, 1, 0).applyQuaternion(_q);
    m.floorN[0] = up.x; m.floorN[1] = up.y; m.floorN[2] = up.z;
    const c = this.root.position;
    m.floorD = this.ensureFloor().heightAt(c.x, c.z, this.bounds.min.y + 0.05) - c.y + 0.5 * this.thickness;
    this.membrane = m;
    this.buildLaminatedMesh(m);
    return m;
  }

  /** Grid mesh (front, back, rim) that follows the membrane particles. */
  private buildLaminatedMesh(m: Membrane): void {
    const nx = m.nx, ny = m.ny, n = m.n;
    const ring: number[] = [];
    for (let i = 0; i < nx - 1; i++) ring.push(i);
    for (let j = 0; j < ny - 1; j++) ring.push(j * nx + nx - 1);
    for (let i = nx - 1; i > 0; i--) ring.push((ny - 1) * nx + i);
    for (let j = ny - 1; j > 0; j--) ring.push(j * nx);
    const nv = 2 * n + 4 * ring.length;
    const pos = new Float32Array(3 * nv), nrm = new Float32Array(3 * nv), uv = new Float32Array(2 * nv), rim = new Float32Array(nv);
    const idx: number[] = [];
    for (let k = 0; k < n; k++) {
      const u = (m.rest[2 * k]! + this.width / 2) / this.width, v = (m.rest[2 * k + 1]! + this.height / 2) / this.height;
      uv.set([u, v], 2 * k);
      uv.set([u, v], 2 * (n + k));
    }
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx + 1, d = a + nx;
        idx.push(a, b, c, a, c, d);
        idx.push(n + a, n + c, n + b, n + a, n + d, n + c);
      }
    }
    const base = 2 * n;
    for (let r = 0; r < ring.length; r++) {
      const a = ring[r]!, b = ring[(r + 1) % ring.length]!;
      const o = base + 4 * r;
      for (const [q, k] of [[0, a], [1, b], [2, b], [3, a]] as const) {
        uv.set([uv[2 * k]!, uv[2 * k + 1]!], 2 * (o + q));
        rim[o + q] = 1;
      }
      idx.push(o, o + 3, o + 2, o, o + 2, o + 1);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setAttribute('aRim', new THREE.BufferAttribute(rim, 1));
    geom.setIndex(idx);
    this.lam = { geom, pos, nrm, ring };
    this.updateLaminatedMesh();
    this.meshT.geometry = geom;
    this.meshR.geometry = geom;
    this.meshT.frustumCulled = this.meshR.frustumCulled = false;
  }

  private updateLaminatedMesh(): void {
    const m = this.membrane, L = this.lam;
    if (!m || !L) return;
    const { pos, nrm, ring } = L;
    const nx = m.nx, ny = m.ny, n = m.n, x = m.x;
    const h = this.thickness / 2;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const kl = j * nx + Math.max(0, i - 1), kr = j * nx + Math.min(nx - 1, i + 1);
        const kd = Math.max(0, j - 1) * nx + i, ku = Math.min(ny - 1, j + 1) * nx + i;
        const ax = x[3 * kr]! - x[3 * kl]!, ay = x[3 * kr + 1]! - x[3 * kl + 1]!, az = x[3 * kr + 2]! - x[3 * kl + 2]!;
        const bx = x[3 * ku]! - x[3 * kd]!, by = x[3 * ku + 1]! - x[3 * kd + 1]!, bz = x[3 * ku + 2]! - x[3 * kd + 2]!;
        let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        const l = Math.hypot(cx, cy, cz) || 1;
        cx /= l; cy /= l; cz /= l;
        pos[3 * k] = x[3 * k]! + cx * h; pos[3 * k + 1] = x[3 * k + 1]! + cy * h; pos[3 * k + 2] = x[3 * k + 2]! + cz * h;
        nrm[3 * k] = cx; nrm[3 * k + 1] = cy; nrm[3 * k + 2] = cz;
        const o = 3 * (n + k);
        pos[o] = x[3 * k]! - cx * h; pos[o + 1] = x[3 * k + 1]! - cy * h; pos[o + 2] = x[3 * k + 2]! - cz * h;
        nrm[o] = -cx; nrm[o + 1] = -cy; nrm[o + 2] = -cz;
      }
    }
    const base = 2 * n;
    for (let r = 0; r < ring.length; r++) {
      const a = ring[r]!, b = ring[(r + 1) % ring.length]!;
      const o = base + 4 * r;
      // Outward rim normal: edge direction × surface normal.
      const ex = x[3 * b]! - x[3 * a]!, ey = x[3 * b + 1]! - x[3 * a + 1]!, ez = x[3 * b + 2]! - x[3 * a + 2]!;
      const sx = nrm[3 * a]!, sy = nrm[3 * a + 1]!, sz = nrm[3 * a + 2]!;
      let rx = ey * sz - ez * sy, ry = ez * sx - ex * sz, rz = ex * sy - ey * sx;
      const l = Math.hypot(rx, ry, rz) || 1;
      rx /= l; ry /= l; rz /= l;
      const set = (q: number, src: number) => {
        pos[3 * (o + q)] = pos[3 * src]!; pos[3 * (o + q) + 1] = pos[3 * src + 1]!; pos[3 * (o + q) + 2] = pos[3 * src + 2]!;
        nrm[3 * (o + q)] = rx; nrm[3 * (o + q) + 1] = ry; nrm[3 * (o + q) + 2] = rz;
      };
      set(0, a);
      set(1, b);
      set(2, n + b);
      set(3, n + a);
    }
    (L.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (L.geom.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** A hit on laminated glass: damage softens the membrane, the bullet's momentum pushes it. */
  private laminatedHit(x: number, y: number, ev: ImpactEvent, starLength: number): void {
    const m = this.ensureMembrane();
    this.toLocal(_v.copy(this.root.position).add(ev.momentum), _w);
    m.impulse(x, y, 0.12, _w.x, _w.y, _w.z);
    m.addDamage(x, y, Math.max(0.08, 1.1 * starLength), 0.75);
    this.lamDirty = true;
    if (m.meanDamage() > LAMINATED_PULLOUT && this.tearAt === Infinity) this.tearAt = this.ctx.time.now + 0.4 + 0.8 * this.rnd();
  }

  private tearOut(): void {
    if (this.torn || !this.membrane) return;
    this.torn = true;
    this.membrane.release();
    this.goneArea = this.width * this.height;
    this.ctx.events.emit('shatter', { time: this.ctx.time.now, position: this.bounds.getCenter(new THREE.Vector3()), area: this.width * this.height, material: this.material });
    this.ctx.structure.touch(this);
  }

  // ─── Blast ───────────────────────────────────────────────────────────────────────────────

  /** P–I damage and reflected impulse over the pane (the face towards the charge). */
  private blastField(load: BlastLoad): BlastField {
    const nx = Math.min(12, Math.max(3, Math.ceil(this.width / 0.3) + 1));
    const ny = Math.min(12, Math.max(3, Math.ceil(this.height / 0.3) + 1));
    const D = new Float64Array(nx * ny), I = new Float64Array(nx * ny);
    const contact = load.contactTargetId === this.id;
    let max = 0, ox = 0, oy = 0;
    const c = this.bounds.getCenter(_o);
    const facing = Math.sign(_n.copy(load.center).sub(c).dot(this.normalW)) || 1;
    const n = _n.copy(this.normalW).multiplyScalar(facing).clone();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = -this.width / 2 + (i / (nx - 1)) * this.width, y = -this.height / 2 + (j / (ny - 1)) * this.height;
        this.toWorld(x, y, 0, _v);
        let dmg = load.damageAt(_v, n, this.material, this.thickness);
        let imp = load.reflectedImpulseAt(_v, n);
        if (contact) {
          const cd = load.contactDamage(this.material, this.thickness);
          const r = _v.distanceTo(load.center);
          if (r < cd.breachRadius) {
            dmg = Math.max(dmg, 4);
            imp = Math.max(imp, (cd.spallVelocity * arealMass(this.material, this.thickness)) / 0.8);
          }
        }
        if (!Number.isFinite(dmg)) dmg = 0;
        if (!Number.isFinite(imp)) imp = 0;
        D[j * nx + i] = dmg;
        I[j * nx + i] = imp;
        if (dmg > max) {
          max = dmg;
          ox = x;
          oy = y;
        }
      }
    }
    // Fracture starts at the peak: the point nearest a close charge, the centre for a distant one.
    const pl = this.toLocal(load.center, _v);
    const px = Math.max(-this.width / 2, Math.min(this.width / 2, pl.x)), py = Math.max(-this.height / 2, Math.min(this.height / 2, pl.y));
    const near = Math.exp(-Math.abs(pl.z) / Math.max(this.width, this.height));
    ox = near * px + (1 - near) * 0.5 * ox;
    oy = near * py + (1 - near) * 0.5 * oy;
    return { nx, ny, D, I, max, ox, oy, center: load.center.clone(), contact };
  }

  applyBlast(load: BlastLoad): void {
    this.blastWithin(load, false);
  }

  /** Process a blast now if the scene's per-step budget allows (or `force`), else defer it a step. */
  private blastWithin(load: BlastLoad, force: boolean): void {
    if (this.disposed || this.hasFailed()) return;
    if (!admitBlast(this.ctx) && !force) {
      this.pendingBlasts.push(load);
      return;
    }
    const t0 = performance.now();
    this.processBlast(load);
    spend(this.ctx, performance.now() - t0);
  }

  private processBlast(load: BlastLoad): void {
    const t0 = performance.now();
    const field = this.blastField(load);
    if (field.max >= 1) {
      switch (this.type) {
        case 'tempered':
          this.breakTempered(field.ox, field.oy, { kind: 'blast', field });
          break;
        case 'annealed': {
          const g = this.ensureGraph();
          this.ensureRaster();
          growStar(g, field.ox, field.oy, 0, blastStar(field.max, this.width, this.height, this.rnd), this.rnd, (x, y) => this.isGone(x, y));
          this.evaluateFaces(field);
          this.facesDirty = false;
          // Only what is left in the frame needs its cracks drawn.
          if (this.goneArea < 0.97 * this.width * this.height) this.paintCracks(3);
          else for (let s = 0; s < g.segmentCount; s++) g.painted[s] = 1;
          break;
        }
        case 'laminated':
          this.laminatedBlast(field);
          break;
      }
    }
    this.stats.blastMs = performance.now() - t0;
  }

  private laminatedBlast(field: BlastField): void {
    const g = this.ensureGraph();
    this.ensureRaster();
    const spec = blastStar(Math.max(1, field.max), this.width, this.height, this.rnd);
    spec.ringProb = spec.ringProb.map(() => 0.8);
    growStar(g, field.ox, field.oy, 0, spec, this.rnd, (x, y) => this.isGone(x, y));
    this.paintCracks(3);
    // The interlayer delaminates across the loaded pane: a milky, blotchy veil.
    this.uniforms.uHaze.value = Math.min(0.22, Math.max(this.uniforms.uHaze.value, 0.1 * field.max));
    const m = this.ensureMembrane();
    if (m.bulge === 0) m.bulge = Math.sign(_v.copy(this.bounds.getCenter(_o)).sub(field.center).dot(this.normalW)) || 1;
    for (let k = 0; k < m.n; k++) {
      const D = sampleField(field, field.D, m.rest[2 * k]!, m.rest[2 * k + 1]!, this.width, this.height);
      if (D >= 1) m.damage[k] = Math.min(1, Math.max(m.damage[k]!, 0.55 + 0.25 * (D - 1)));
    }
    m.addDamage(field.ox, field.oy, 0.01, 0);
    // The membrane is loaded by the reflected impulse (per particle), pushed away from the charge.
    const away = Math.sign(_v.copy(this.bounds.getCenter(_o)).sub(field.center).dot(this.normalW)) || 1;
    const rho = arealMass(this.material, this.thickness);
    m.kick((k, out) => {
      const I = sampleField(field, field.I, m.rest[2 * k]!, m.rest[2 * k + 1]!, this.width, this.height);
      out[0] = 0;
      out[1] = 0;
      out[2] = (away * 0.8 * I) / rho;
    });
    this.lamDirty = true;
    if (field.max >= 2) this.tearOut();
    else if (m.meanDamage() > LAMINATED_PULLOUT && this.tearAt === Infinity) this.tearAt = this.ctx.time.now + 0.2 + 0.5 * this.rnd();
  }

  // ─── Simulation ──────────────────────────────────────────────────────────────────────────

  fixedUpdate(dt: number): void {
    if (this.disposed) return;
    // Dice of a broken tempered pane still being spawned (a few ms per step, centre-out).
    if (this.diceJob) {
      const t = performance.now();
      this.runDiceJob(allowance(this.ctx, this.diceJob.field ? 12 : 5, 2));
      spend(this.ctx, performance.now() - t);
    }
    if (this.releaseQueue.length) {
      const t = performance.now();
      this.runReleaseQueue(allowance(this.ctx, 5, 1));
      spend(this.ctx, performance.now() - t);
    }
    if (this.cracksPending) {
      const t = performance.now();
      this.paintCracks(allowance(this.ctx, 4, 1));
      spend(this.ctx, performance.now() - t);
    }
    if (this.pendingBlasts.length) {
      // Deferred by the shared budget; after a few steps it goes through regardless, so a stalled
      // clock (or a scene of many panes) never starves one.
      this.blastWaits++;
      this.blastWithin(this.pendingBlasts.shift()!, this.blastWaits > 8);
      if (!this.pendingBlasts.length) this.blastWaits = 0;
    }
    const t0 = performance.now();
    const now = this.ctx.time.now;
    if (this.type === 'annealed') {
      if (this.facesDirty) {
        this.facesDirty = false;
        this.evaluateFaces(null);
      }
      if (this.schedule.size) {
        for (const [k, s] of this.schedule) {
          if (s.time > now) continue;
          this.schedule.delete(k);
          if (this.isGone(s.face.sample[0], s.face.sample[1])) continue;
          this.releaseFace(s.face, null);
          // What bore on it has lost its support: check again next step (the hole grows upward).
          this.facesDirty = true;
        }
      }
    }
    this.shards?.fixedUpdate(dt);
    if (this.membrane) {
      if (now >= this.tearAt) {
        this.tearAt = Infinity;
        this.tearOut();
      }
      if (this.membrane.awake) {
        this.membrane.step(dt);
        this.lamDirty = true;
        this.membraneBounds();
        if (this.torn && !this.landed && this.membrane.floorImpulse > 0.5) {
          this.landed = true;
          this.ctx.events.emit('debrisContact', { time: now, position: this.bounds.getCenter(new THREE.Vector3()).setY(this.bounds.min.y), impulse: this.membrane.floorImpulse * 20, size: Math.max(this.width, this.height), material: this.material });
        }
      }
    }
    if (now - this.lastShatter > 0.25 || this.shatterArea > 0.1) {
      let emitted = false;
      if (this.shatterArea > 0.004) {
        this.emitShatter(this.shatterAt, this.shatterArea);
        this.shatterArea = 0;
        emitted = true;
      }
      if (this.groundArea > 0.004) {
        this.emitShatter(this.groundAt, this.groundArea);
        this.groundArea = 0;
        emitted = true;
      }
      if (emitted) this.lastShatter = now;
    }
    this.stats.stepMs = performance.now() - t0;
  }

  private emitShatter(p: THREE.Vector3, area: number): void {
    this.ctx.events.emit('shatter', { time: this.ctx.time.now, position: p.clone(), area, material: this.material });
    this.ctx.structure.touch(this);
  }

  /** Where this pane's reflection probe sits: 1.2 m in front of its centre. */
  private probePosition(): THREE.Vector3 {
    return this.bounds.getCenter(new THREE.Vector3()).addScaledVector(this.normalW, 1.2);
  }

  frameUpdate(): void {
    if (this.disposed) return;
    const t0 = performance.now();
    if (this.probes === undefined) {
      this.probes = ReflectionProbes.acquire(this.ctx);
      this.probes?.attach(this.probePosition(), this.matR);
      if (this.shards) this.probes?.attach(this.probePosition(), this.shards.reflectionMaterial);
    }
    this.probes?.update();
    this.uniforms.uTime.value = this.ctx.time.now;
    if (this.dice) {
      this.dice.update(this.ctx.time.now);
      // The scene's dice ring has come round to this pane's dice (a big blast elsewhere): show the
      // heap now instead of letting it vanish until its decal was due.
      if (this.heapFirst >= 0 && this.decals.length && this.dice.spawned - DICE_CAP > this.heapFirst) {
        for (const dcl of this.decals) dcl.appearBy(this.ctx.time.now);
        this.heapFirst = -1;
      }
    }
    this.uploadRaster();
    this.shards?.frameUpdate();
    if (this.lamDirty) {
      this.lamDirty = false;
      this.updateLaminatedMesh();
    }
    this.stats.frameMs = performance.now() - t0;
  }

  /**
   * Push the changed rows of the damage image to the GPU (whole image when much changed). A full
   * upload that is still queued (no render since) already carries every later change: adding row
   * ranges to it would turn it into a partial upload and drop the rest.
   */
  private uploadRaster(): void {
    const r = this.raster, tex = this.crackTex;
    if (!r || !tex) return;
    const d = r.takeDirty();
    if (!d || this.fullUploadQueued) return;
    if (this.texFresh || d[3] - d[1] > 96) {
      this.texFresh = false;
      this.fullUploadQueued = true;
      tex.clearUpdateRanges();
      tex.needsUpdate = true;
      return;
    }
    for (let j = d[1]; j <= d[3]; j++) tex.addUpdateRange(4 * (j * r.w + d[0]), 4 * (d[2] - d[0] + 1));
    tex.needsUpdate = true;
  }

  // ─── Structural ──────────────────────────────────────────────────────────────────────────

  weight(): number {
    const area = Math.max(0, this.width * this.height - this.goneArea);
    return arealMass(this.material, this.thickness) * area * GRAVITY;
  }

  addAnchor(anchorId: string, regionWorld: THREE.Box3): void {
    this.anchors.set(anchorId, regionWorld.clone());
    this.hadAnchor = true;
  }

  /** Glass carries nothing: it never offers support to other elements. */
  supportPresence(): number {
    return 0;
  }

  releaseAnchor(anchorId: string): void {
    if (!this.anchors.delete(anchorId)) return;
    if (this.hadAnchor && this.anchors.size === 0) this.supportLost();
  }

  /**
   * Edge-loaded glass buckles long before it crushes. Plate simply supported on four edges,
   * compressed down its height a = H across its width b = W: N_cr = k π² D / b² per metre of loaded
   * edge, D = E t³ / 12(1 − ν²), k = min over half-waves m of (m b/a + a/(m b))² (≈ 4 for tall
   * panes, larger for wide low ones; Timoshenko & Gere 1961, "Theory of Elastic Stability", §9.2).
   * A frame that deflects onto the pane with more than N_cr · W breaks it.
   */
  setImposedLoad(newtons: number): void {
    this.imposed = newtons;
    const m = this.material, t = this.thickness;
    const Dp = (m.youngModulus * t * t * t) / (12 * (1 - m.poisson * m.poisson));
    const a = this.height, b = this.width;
    let k = Infinity;
    for (let w = 1; w <= 12; w++) k = Math.min(k, (w * b / a + a / (w * b)) ** 2);
    const Ncr = ((k * Math.PI * Math.PI * Dp) / (b * b)) * b;
    if (newtons > Ncr && !this.hasFailed()) this.supportLost();
  }

  /** The frame is gone (or racked onto the glass): the pane breaks and falls. */
  private supportLost(): void {
    switch (this.type) {
      case 'tempered':
        this.breakTempered(0, 0, { kind: 'support' });
        break;
      case 'annealed': {
        const g = this.ensureGraph();
        this.ensureRaster();
        growStar(g, 0, 0, 0, blastStar(1.3, this.width, this.height, this.rnd), this.rnd, (x, y) => this.isGone(x, y));
        this.paintCracks();
        const faces = this.currentFaces(g).filter((f) => !this.isGone(f.sample[0], f.sample[1]));
        for (const f of faces) this.releaseFace(f, null, false);
        this.paintGone(faces);
        break;
      }
      case 'laminated': {
        const m = this.ensureMembrane();
        m.addDamage(0, 0, Math.max(this.width, this.height), 0.5);
        this.tearOut();
        break;
      }
    }
  }

  hasFailed(): boolean {
    switch (this.type) {
      case 'tempered':
        return this.broken;
      case 'laminated':
        return this.torn;
      default:
        return this.goneArea > 0.95 * this.width * this.height;
    }
  }

  /** Fraction of the pane still in its frame, 0..1. */
  remaining(): number {
    if (this.type === 'tempered') return this.broken ? 0 : 1;
    if (this.torn) return 0;
    return Math.max(0, 1 - this.goneArea / (this.width * this.height));
  }

  /** The crazed pane has finished coming apart (tempered), s of simulation time. */
  get collapseTime(): number {
    return this.collapseEnd;
  }

  get laminatedDamage(): number {
    return this.membrane?.meanDamage() ?? 0;
  }

  get sag(): number {
    const m = this.membrane;
    if (!m) return 0;
    let z = 0;
    for (let k = 0; k < m.n; k++) z = Math.max(z, Math.abs(m.x[3 * k + 2]!));
    return z;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingBlasts.length = 0;
    this.root.removeFromParent();
    this.boxGeom.dispose();
    this.lam?.geom.dispose();
    this.matT.dispose();
    this.matR.dispose();
    this.cleanTex.dispose();
    this.crackTex?.dispose();
    this.fittings?.geo.dispose();
    this.fittings?.mat.dispose();
    if (this.shards) this.probes?.detach(this.shards.reflectionMaterial);
    this.shards?.dispose();
    for (const d of this.decals) d.dispose();
    this.decals.length = 0;
    this.dice?.release();
    this.dice = null;
    if (this.probes) {
      this.probes.detach(this.matR);
      this.probes.release();
      this.probes = null;
    }
    this.ctx.structure.remove(this);
  }
}

/** Bilinear lookup in a blast field grid at pane-local (x, y). */
function sampleField(f: BlastField, a: Float64Array, x: number, y: number, W: number, H: number): number {
  const fx = Math.min(f.nx - 1.0001, Math.max(0, ((x + W / 2) / W) * (f.nx - 1)));
  const fy = Math.min(f.ny - 1.0001, Math.max(0, ((y + H / 2) / H) * (f.ny - 1)));
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const k = j * f.nx + i;
  return (1 - v) * ((1 - u) * a[k]! + u * a[k + 1]!) + v * ((1 - u) * a[k + f.nx]! + u * a[k + f.nx + 1]!);
}

/** Pane box: front (+z) and back faces with uv 0..1, and four rim faces flagged by aRim. */
function paneBox(w: number, h: number, t: number): THREE.BufferGeometry {
  const x = w / 2, y = h / 2, z = t / 2;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], rim: number[] = [], idx: number[] = [];
  const quad = (p: number[][], n: number[], u: number[][], r: number) => {
    const b = pos.length / 3;
    for (let k = 0; k < 4; k++) {
      pos.push(...p[k]!);
      nrm.push(...n);
      uv.push(...u[k]!);
      rim.push(r);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  quad([[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]], 0);
  quad([[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]], [0, 0, -1], [[1, 0], [0, 0], [0, 1], [1, 1]], 0);
  quad([[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]], [0, -1, 0], [[0, 0], [1, 0], [1, 0], [0, 0]], 1);
  quad([[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]], [1, 0, 0], [[1, 0], [1, 1], [1, 1], [1, 0]], 1);
  quad([[x, y, -z], [-x, y, -z], [-x, y, z], [x, y, z]], [0, 1, 0], [[1, 1], [0, 1], [0, 1], [1, 1]], 1);
  quad([[-x, y, -z], [-x, -y, -z], [-x, -y, z], [-x, y, z]], [-1, 0, 0], [[0, 1], [0, 0], [0, 0], [0, 1]], 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aRim', new THREE.Float32BufferAttribute(rim, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
