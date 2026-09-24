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
/**
 * Wall-clock budget per frame for preparing the capture's shader programs without the parallel
 * compile extension, ms; and at most one program that is actually new is compiled per frame then
 * (see `precompile`).
 */
const COMPILE_BUDGET = 3;

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
  /**
   * Frames a due unit waited instead: for the main pass to render the shadow maps the capture
   * reuses, or for the capture's shader programs to be compiled ahead (`precompile`).
   */
  waits: number;
  /** Programs compiled ahead for the capture, and programs a face render still had to compile (misses) */
  compiled: number;
  missed: number;
  /** CPU time of the frames spent preparing (scan and compile) instead of a unit: all, and the largest, ms */
  prepMs: number;
  prepMaxMs: number;
}

const sets = new WeakMap<SimContext, ReflectionProbes>();

type Renderable = THREE.Mesh | THREE.Points | THREE.Line | THREE.Sprite;
const isLight = (o: THREE.Object3D): o is THREE.Light => (o as THREE.Light).isLight === true;
const isRenderable = (o: THREE.Object3D): o is Renderable => {
  const r = o as Partial<THREE.Mesh & THREE.Points & THREE.Line & THREE.Sprite>;
  return !!(r.isMesh || r.isPoints || r.isLine || r.isSprite);
};

/**
 * What the capture leaves out: the glass itself (it would reflect itself), the particles and the
 * sun-disc sky mesh (the sky comes in as the background). The chips under 'fx-solid' go, but never
 * a light: the effect-light pool lives there, and the set of lights is part of every lit
 * material's program — a capture without them compiled a second program for every material in the
 * scene (SwiftShader: tens of seconds of stall in the first captures and after every collapse).
 */
function hiddenInCapture(o: THREE.Object3D): boolean {
  if (o.name.startsWith('glass') || o.name === 'fx-root' || o.name === 'sky') return true;
  return o.parent?.name === 'fx-solid' && !isLight(o) && !o.children.some(isLight);
}

/**
 * Program variant of an object beyond its material (what else three keys a program on per object):
 * instancing, batching, skinning, morphs, shadow receiving (a small integer).
 */
function variant(o: Renderable): number {
  const m = o as Partial<THREE.InstancedMesh & THREE.BatchedMesh & THREE.SkinnedMesh>;
  const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  return (m.isInstancedMesh ? 1 : 0) | (m.isInstancedMesh && m.instanceColor ? 2 : 0) | (m.isBatchedMesh ? 4 : 0)
    | (m.isSkinnedMesh ? 8 : 0) | (g && Object.keys(g.morphAttributes).length ? 16 : 0) | (o.receiveShadow ? 32 : 0);
}

/** Program variants (see `variant`) of a material the capture has compiled, at material `version`. */
interface CompiledSet {
  version: number;
  variants: Set<number>;
}

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
 *
 * A face render never compiles shaders if it can help it (a program link is the one cost a
 * one-face budget does not bound: seconds per program in software GL). The capture keeps the
 * scene's lights, so it shares the main pass's programs; objects whose program the capture has not
 * prepared yet (new rubble, pieces out of the main view) are compiled ahead with
 * `renderer.compileAsync` where the parallel-compile extension exists, the capture waiting until
 * they are ready, else with `renderer.compile` at most one new program per frame. A capture also
 * waits until the main pass has rendered the shadow maps it reuses (before the first frame, three
 * binds placeholders the drivers reject as mismatched shadow samplers).
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
  readonly stats: ProbeStats = { probes: 0, units: 0, captures: 0, lastMs: 0, maxMs: 0, totalMs: 0, frames: 0, waits: 0, compiled: 0, missed: 0, prepMs: 0, prepMaxMs: 0 };
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
  /** Objects whose program the capture has not prepared yet (one per material and variant), from `scan` */
  private readonly uncompiled: Renderable[] = [];
  /** Every shadow-casting light of the capture has its shadow map (from `scan`) */
  private shadowsReady = true;
  /** Programs the capture has prepared, per material; forgotten when the scene's lights change */
  private compiled = new WeakMap<THREE.Material, CompiledSet>();
  private lightKey = '';
  /** A parallel compile is in flight */
  private compiling = false;
  /** A recapture forced by MAX_STALE while changes keep coming: it runs to the end */
  private forced = false;
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
      this.forced = now - this.changedLast < SETTLE && now >= this.changedLast;
      this.changedFirst = this.changedLast = -1;
      for (const p of this.probes) p.dirty = true;
    }
    const p = this.current ?? this.nearestDirty();
    if (!p) {
      this.forced = false;
      return;
    }
    // While a blast or a collapse is still unfolding, no unit runs (a capture in progress pauses):
    // its fresh rubble, programs and buffer uploads are the main pass's first — a face rendered
    // before it paid for all of them (seconds in software GL) — unless the reflections are
    // MAX_STALE old, when the forced round runs to the end.
    if (this.changedFirst >= 0 && !this.forced) {
      this.stats.waits++;
      return;
    }
    if (this.compiling) {
      this.stats.waits++;
      return;
    }
    const t0 = performance.now();
    // What the face would draw: if it needs programs the capture has not prepared, or shadow maps
    // the main pass has not rendered yet, this frame's unit is spent preparing (or waiting) instead.
    this.scan();
    if (!this.shadowsReady || this.uncompiled.length) {
      if (this.shadowsReady) this.precompile(p);
      this.hidden.length = 0;
      const ms = performance.now() - t0;
      this.stats.waits++;
      this.stats.prepMs += ms;
      this.stats.prepMaxMs = Math.max(this.stats.prepMaxMs, ms);
      return;
    }
    if (!this.current) {
      this.current = p;
      this.unit = 0;
      // Cleared when the capture starts: a change during the capture schedules another one.
      p.dirty = false;
    }
    const f0 = r.info.render.frame;
    const programs = r.info.programs?.length ?? 0;
    try {
      this.renderFace(p, this.unit++);
    } finally {
      this.own += r.info.render.frame - f0;
      this.stats.missed += Math.max(0, (r.info.programs?.length ?? 0) - programs);
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

  /**
   * Walk what the capture draws: collect the objects to hide, the objects whose program the capture
   * has not prepared (one per material and variant), whether every shadow-casting light has its
   * map, and the light set (a change of which changes every lit program).
   */
  private scan(): void {
    const hidden = this.hidden, pending = this.uncompiled;
    hidden.length = 0;
    pending.length = 0;
    this.shadowsReady = true;
    let lights = '';
    const seen = new Set<string>();
    const visit = (o: THREE.Object3D) => {
      if (!o.visible) return;
      if (hiddenInCapture(o)) {
        hidden.push(o);
        return;
      }
      if (isLight(o)) {
        lights += `${o.type}${o.castShadow ? '*' : ''},`;
        const shadow = (o as { shadow?: THREE.LightShadow }).shadow;
        if (o.castShadow && shadow && !shadow.map) this.shadowsReady = false;
      } else if (isRenderable(o) && o.layers.mask & 1) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const v = variant(o);
        for (const m of mats) {
          if (!m || !m.visible) continue;
          const c = this.compiled.get(m);
          if (c && c.version === m.version && c.variants.has(v)) continue;
          // One representative per material and variant.
          const key = `${m.uuid}:${v}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pending.push(o);
        }
      }
      for (const c of o.children) visit(c);
    };
    visit(this.ctx.scene);
    if (lights !== this.lightKey) {
      // Another set of lights: every lit program is another one.
      this.lightKey = lights;
      this.compiled = new WeakMap();
      this.scan();
    }
  }

  /** Mark the materials of `o` compiled for the capture (in its variant). */
  private markCompiled(o: Renderable): void {
    const v = variant(o);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      let c = this.compiled.get(m);
      if (!c || c.version !== m.version) this.compiled.set(m, (c = { version: m.version, variants: new Set() }));
      c.variants.add(v);
    }
  }

  /**
   * Prepare the programs of `this.uncompiled` for a capture into `p` (its render target bound, so
   * colour space and tone mapping match the capture's). With KHR_parallel_shader_compile, all at
   * once and asynchronously (the capture waits for the promise); without it, synchronously within
   * COMPILE_BUDGET ms and at most one program that is actually new per frame — those the main pass
   * already compiled are found in three's program cache and cost next to nothing.
   */
  private precompile(p: Probe): void {
    const { renderer: r, scene } = this.ctx;
    const list = this.uncompiled.slice();
    const cam = p.camera.children[0] as THREE.Camera;
    if (p.camera.coordinateSystem !== r.coordinateSystem) {
      p.camera.coordinateSystem = r.coordinateSystem;
      p.camera.updateCoordinateSystem();
    }
    const target = r.getRenderTarget(), cubeFace = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const programs = () => r.info.programs?.length ?? 0;
    r.setRenderTarget(p.target, 0);
    try {
      if (r.extensions?.get('KHR_parallel_shader_compile')) {
        const n0 = programs();
        const done = () => {
          this.compiling = false;
          for (const o of list) this.markCompiled(o);
        };
        this.compiling = true;
        try {
          void r.compileAsync(group(list), cam, scene).then(done, done);
        } catch {
          done();
        }
        this.stats.compiled += programs() - n0;
        return;
      }
      const t0 = performance.now();
      for (const o of list) {
        const n0 = programs();
        try {
          r.compile(group([o]), cam, scene);
        } catch {
          // Left to the face render (counted as a miss if it compiles there): never retried for ever.
        }
        this.markCompiled(o);
        const made = programs() - n0;
        this.stats.compiled += made;
        if (made > 0 || performance.now() - t0 > COMPILE_BUDGET) break;
      }
    } finally {
      r.setRenderTarget(target, cubeFace, mip);
    }
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

/**
 * `objects` as the subject of `renderer.compile`, which only traverses it (they keep their parents:
 * world matrices and receive-shadow flags stay those of the scene); lights come from the target scene.
 */
function group(objects: THREE.Object3D[]): THREE.Object3D {
  const g = {
    traverse(fn: (o: THREE.Object3D) => void) {
      for (const o of objects) fn(o);
    },
    traverseVisible() {},
  };
  return g as unknown as THREE.Object3D;
}

/** Back to the scene environment. */
function unassign(m: THREE.Material): void {
  const u = probeUniforms(m);
  if (!u) return;
  u.uProbeOn.value = 0;
  u.uProbe.value = null;
}
