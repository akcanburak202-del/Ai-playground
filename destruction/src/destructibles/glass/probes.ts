import * as THREE from 'three';
import type { SimContext } from '../../app/contracts.ts';
import { probeUniforms } from './look.ts';

/** Probes closer than this are shared, m. */
const SHARE_RADIUS = 7;
/** Far plane of the capture, m. */
const FAR = 600;
/**
 * After a blast or a structural failure the reflections are recaptured once the scene has been
 * quiet for SETTLE s of simulation time (debounced: a collapse is a stream of failures), and at
 * the latest MAX_STALE s after the first change, so a long collapse still shows up in the glass.
 */
const SETTLE = 1.2;
const MAX_STALE = 6;
/** Work units of one capture: the six cube faces (the mips are generated with the last one). */
const FACES = 6;

interface Probe {
  position: THREE.Vector3;
  target: THREE.WebGLCubeRenderTarget;
  camera: THREE.CubeCamera;
  /** A complete capture exists (the target is sampled from then on) */
  ready: boolean;
  /** Wants a (re)capture */
  dirty: boolean;
  users: Set<THREE.Material>;
}

/** Cost counters of a scene's probes (read by sandboxes and QA scenarios). */
export interface ProbeStats {
  probes: number;
  /** Work units done (one cube face each) and complete captures */
  units: number;
  captures: number;
  /** CPU time of the last unit, the most expensive one, and all of them, ms */
  lastMs: number;
  maxMs: number;
  totalMs: number;
  /** Renderer frames the probes observed (at most one unit is done per frame) */
  frames: number;
}

const sets = new WeakMap<SimContext, ReflectionProbes>();
const HIDE = (o: THREE.Object3D) => o.name.startsWith('glass') || o.name === 'fx-root' || o.name === 'fx-solid' || o.name === 'sky';

/**
 * Local reflection probes for glass. A flat pane is a mirror: what makes it read as glass in a
 * photograph is the reflection of its surroundings (the plaza, the building opposite, its own
 * mullions), which a sky-only environment map cannot give. Each probe is a cube capture of the
 * scene (glass, particles and the sun-disc sky mesh hidden; the sky environment as background, so
 * the sun is not counted twice) with box-filtered mips, which the glass reflection pass samples in
 * place of the scene environment (look.ts, PROBE_IBL). Panes within SHARE_RADIUS share a probe.
 * Reference-counted per scene like the dice.
 *
 * Cost is strictly budgeted: a capture is split into six units (one cube face each; the mips are
 * generated with the last) and at most ONE unit runs per rendered frame, whoever of the scene's
 * panes asks first. "Rendered frame" is the renderer's frame counter minus the renders the probes
 * issued themselves, so a capture never licenses the next one within the same frame, and nothing
 * is captured while the simulation is stepped without rendering. Captures reuse the frame's sun
 * shadow maps instead of re-rendering them for every face, go to the dirty probe nearest the camera
 * first, and are re-triggered by blasts and collapses only after a debounce in simulation time
 * (never a storm of recaptures). There is no PMREM pass: three's GGX prefilter (256 samples per
 * texel of every mip) cost more than the six faces together.
 */
export class ReflectionProbes {
  /** Global switch (quality setting): without probes the glass reflects the scene environment only. */
  static enabled = true;
  /**
   * Cube face size of new probes, px (quality setting): 256 resolves ≈ 0.35° per texel, a sharp
   * mirror image at 1080p; 128 costs about a quarter of the fill per face, a little softer.
   */
  static resolution = 256;

  static acquire(ctx: SimContext): ReflectionProbes | null {
    if (!ctx.renderer || !ReflectionProbes.enabled) return null;
    let s = sets.get(ctx);
    if (!s || s.disposed) {
      s = new ReflectionProbes(ctx);
      sets.set(ctx, s);
    }
    s.refs++;
    return s;
  }

  /** The live probe set of a scene, if its glass uses probes (for stats). */
  static of(ctx: SimContext): ReflectionProbes | null {
    const s = sets.get(ctx);
    return s && !s.disposed ? s : null;
  }

  disposed = false;
  readonly stats: ProbeStats = { probes: 0, units: 0, captures: 0, lastMs: 0, maxMs: 0, totalMs: 0, frames: 0 };
  private refs = 0;
  private readonly ctx: SimContext;
  private readonly probes: Probe[] = [];
  private lastEnv: THREE.Texture | null | undefined = undefined;
  /** Renderer frames issued by the probes themselves */
  private own = 0;
  /** Last external frame number a unit was done (or skipped) in */
  private frame = -1;
  /** Probe being captured and its next face (0–5) */
  private current: Probe | null = null;
  private unit = 0;
  /** Simulation times of the first and the latest scene change not yet recaptured (−1: none) */
  private changedFirst = -1;
  private changedLast = -1;
  private readonly hidden: THREE.Object3D[] = [];
  private readonly off: (() => void)[] = [];

  private constructor(ctx: SimContext) {
    this.ctx = ctx;
    const changed = () => {
      const t = this.ctx.time.now;
      if (this.changedFirst < 0 || t < this.changedFirst) this.changedFirst = t;
      this.changedLast = t;
    };
    this.off.push(ctx.events.on('blast', changed), ctx.events.on('structuralFailure', changed));
  }

  /**
   * Feed the probe nearest `position` (created if none is close) to a glass reflection material
   * (see look.ts probeUniforms; other materials are ignored).
   */
  attach(position: THREE.Vector3, material: THREE.Material): void {
    if (this.disposed || !probeUniforms(material)) return;
    let probe = this.probes.find((p) => p.position.distanceTo(position) < SHARE_RADIUS);
    if (!probe) {
      const target = new THREE.WebGLCubeRenderTarget(ReflectionProbes.resolution, {
        type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      });
      probe = { position: position.clone(), target, camera: new THREE.CubeCamera(0.05, FAR, target), ready: false, dirty: true, users: new Set() };
      this.probes.push(probe);
      this.stats.probes = this.probes.length;
    }
    probe.users.add(material);
    if (probe.ready) this.assign(material, probe);
  }

  /** Stop feeding `material`; a probe nobody uses any more is freed. */
  detach(material: THREE.Material): void {
    for (let i = this.probes.length - 1; i >= 0; i--) {
      const p = this.probes[i]!;
      if (!p.users.delete(material)) continue;
      unassign(material);
      if (p.users.size) continue;
      if (this.current === p) this.current = null;
      this.freeProbe(p);
      this.probes.splice(i, 1);
    }
    this.stats.probes = this.probes.length;
  }

  private assign(m: THREE.Material, p: Probe): void {
    const u = probeUniforms(m);
    if (!u) return;
    u.uProbe.value = p.target.texture;
    u.uProbeMaxLod.value = Math.log2(p.target.width);
    u.uProbeOn.value = 1;
  }

  /**
   * Called by every pane once per rendered frame: the first call of a frame renders at most one
   * cube face, the others return at once.
   */
  update(): void {
    if (this.disposed) return;
    const r = this.ctx.renderer;
    const frame = r.info.render.frame - this.own;
    if (frame === this.frame) return;
    this.frame = frame;
    this.stats.frames++;
    const env = this.ctx.scene.environment;
    if (env !== this.lastEnv) {
      this.lastEnv = env;
      for (const p of this.probes) p.dirty = true;
    }
    const now = this.ctx.time.now;
    if (this.changedFirst >= 0 && (now - this.changedLast >= SETTLE || now - this.changedFirst >= MAX_STALE || now < this.changedLast)) {
      this.changedFirst = this.changedLast = -1;
      for (const p of this.probes) p.dirty = true;
    }
    if (!this.current) {
      this.current = this.nearestDirty();
      this.unit = 0;
      if (!this.current) return;
      // Cleared when the capture starts: a change during the capture schedules another one.
      this.current.dirty = false;
    }
    const p = this.current;
    const t0 = performance.now();
    const f0 = r.info.render.frame;
    try {
      this.renderFace(p, this.unit++);
    } finally {
      this.own += r.info.render.frame - f0;
    }
    if (this.unit >= FACES) {
      // Complete (the mips were generated with the last face): the glass samples it from now on.
      this.current = null;
      p.ready = true;
      for (const m of p.users) this.assign(m, p);
      this.stats.captures++;
    }
    const ms = performance.now() - t0;
    const s = this.stats;
    s.units++;
    s.lastMs = ms;
    s.maxMs = Math.max(s.maxMs, ms);
    s.totalMs += ms;
  }

  /** Dirty probe with users nearest the viewer (what the player looks at is refreshed first). */
  private nearestDirty(): Probe | null {
    const cam = this.ctx.camera.position;
    let best: Probe | null = null;
    let bd = Infinity;
    for (const p of this.probes) {
      if (!p.dirty || !p.users.size) continue;
      const d = p.position.distanceToSquared(cam);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /**
   * Render one cube face of `p` (glass, particles and the sky mesh hidden; no shadow-map pass). The
   * glass samples this target while it is being refreshed face by face; it is never drawn into it.
   */
  private renderFace(p: Probe, face: number): void {
    const { renderer: r, scene } = this.ctx;
    const cam = p.camera;
    if (cam.coordinateSystem !== r.coordinateSystem) {
      cam.coordinateSystem = r.coordinateSystem;
      cam.updateCoordinateSystem();
    }
    if (face === 0) {
      cam.position.copy(p.position);
      cam.updateMatrixWorld(true);
    }
    const hidden = this.hidden;
    hidden.length = 0;
    scene.traverseVisible((o) => {
      if (HIDE(o)) hidden.push(o);
    });
    for (const o of hidden) o.visible = false;
    const bg = scene.background;
    if (scene.environment) scene.background = scene.environment;
    const autoClear = r.autoClear;
    const shadows = r.shadowMap;
    const autoUpdate = shadows.autoUpdate, needsUpdate = shadows.needsUpdate;
    const target = r.getRenderTarget(), cubeFace = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    r.autoClear = true;
    // The frame's sun shadow maps are current: re-rendering the cascades for each face (three
    // does so on every render() call by default) would cost more than the face itself.
    shadows.autoUpdate = false;
    shadows.needsUpdate = false;
    const tex = p.target.texture;
    // three regenerates the mip chain after a render into a mipmapped target: after the last face only.
    tex.generateMipmaps = face === FACES - 1;
    try {
      r.setRenderTarget(p.target, face);
      r.render(scene, cam.children[face] as THREE.Camera);
    } finally {
      tex.generateMipmaps = false;
      r.setRenderTarget(target, cubeFace, mip);
      shadows.autoUpdate = autoUpdate;
      shadows.needsUpdate = needsUpdate;
      r.autoClear = autoClear;
      scene.background = bg;
      for (const o of hidden) o.visible = true;
      hidden.length = 0;
    }
  }

  private freeProbe(p: Probe): void {
    for (const m of p.users) unassign(m);
    p.users.clear();
    p.target.dispose();
    p.ready = false;
  }

  release(): void {
    if (--this.refs <= 0) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const f of this.off) f();
    this.off.length = 0;
    for (const p of this.probes) this.freeProbe(p);
    this.probes.length = 0;
    this.current = null;
    this.stats.probes = 0;
    if (sets.get(this.ctx) === this) sets.delete(this.ctx);
  }
}

/** Back to the scene environment. */
function unassign(m: THREE.Material): void {
  const u = probeUniforms(m);
  if (!u) return;
  u.uProbeOn.value = 0;
  u.uProbe.value = null;
}
