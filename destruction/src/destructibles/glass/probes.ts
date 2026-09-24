import * as THREE from 'three';
import type { SimContext } from '../../app/contracts.ts';

/** Probes closer than this are shared, m. */
const SHARE_RADIUS = 7;
/** Cube face size of a probe, px. */
const SIZE = 256;
/** Recapture after a scene-changing event (blast, collapse) at most this often, s (wall clock). */
const MIN_INTERVAL = 4;

interface Probe {
  position: THREE.Vector3;
  target: THREE.WebGLCubeRenderTarget;
  camera: THREE.CubeCamera;
  env: THREE.WebGLRenderTarget | null;
  dirty: boolean;
  users: Set<THREE.MeshStandardMaterial>;
}

const sets = new WeakMap<SimContext, ReflectionProbes>();
const HIDE = (o: THREE.Object3D) => o.name.startsWith('glass') || o.name === 'fx-root' || o.name === 'fx-solid' || o.name === 'sky';

/**
 * Local reflection probes for glass. A flat pane is a mirror: what makes it read as glass in a
 * photograph is the reflection of its surroundings (the plaza, the building opposite, its own
 * mullions), which a sky-only environment map cannot give. Each probe is a cube capture of the
 * scene (glass, particles and the sun-disc sky mesh hidden; the sky environment as background, so
 * the sun is not counted twice) prefiltered with PMREM and used as the glass envMap. Panes within
 * SHARE_RADIUS share a probe; captures happen lazily, one per frame, and again after blasts or
 * collapses change the scene. Reference-counted per scene like the dice.
 */
export class ReflectionProbes {
  /** Global switch (quality setting): without probes the glass reflects the scene environment only. */
  static enabled = true;

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

  disposed = false;
  private refs = 0;
  private readonly ctx: SimContext;
  private readonly probes: Probe[] = [];
  private pmrem: THREE.PMREMGenerator | null = null;
  private lastEnv: THREE.Texture | null = null;
  private lastCapture = -Infinity;
  private pendingSince = -1;
  private frame = -1;
  private readonly off: (() => void)[] = [];

  private constructor(ctx: SimContext) {
    this.ctx = ctx;
    const later = () => {
      if (this.pendingSince < 0) this.pendingSince = performance.now();
    };
    this.off.push(ctx.events.on('blast', later), ctx.events.on('structuralFailure', later));
  }

  /** Use the probe nearest `position` (created if none is close) as the envMap of `material`. */
  attach(position: THREE.Vector3, material: THREE.MeshStandardMaterial): void {
    let probe = this.probes.find((p) => p.position.distanceTo(position) < SHARE_RADIUS);
    if (!probe) {
      const target = new THREE.WebGLCubeRenderTarget(SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
      probe = { position: position.clone(), target, camera: new THREE.CubeCamera(0.05, 600, target), env: null, dirty: true, users: new Set() };
      this.probes.push(probe);
    }
    probe.users.add(material);
    if (probe.env) this.assign(material, probe.env.texture);
  }

  detach(material: THREE.MeshStandardMaterial): void {
    for (const p of this.probes) p.users.delete(material);
  }

  private assign(m: THREE.MeshStandardMaterial, tex: THREE.Texture): void {
    if (m.envMap !== tex) {
      m.envMap = tex;
      m.needsUpdate = true;
    }
  }

  /** Once per rendered frame (several panes may call it): capture at most one dirty probe. */
  update(): void {
    if (this.disposed) return;
    const r = this.ctx.renderer;
    const frame = r.info.render.frame;
    if (frame === this.frame) return;
    this.frame = frame;
    const env = this.ctx.scene.environment;
    if (env !== this.lastEnv) {
      this.lastEnv = env;
      for (const p of this.probes) p.dirty = true;
    }
    const now = performance.now();
    if (this.pendingSince >= 0 && now - this.pendingSince > 1500 && (now - this.lastCapture) / 1000 > MIN_INTERVAL) {
      this.pendingSince = -1;
      for (const p of this.probes) p.dirty = true;
    }
    const p = this.probes.find((q) => q.dirty);
    if (p) this.capture(p);
  }

  private capture(p: Probe): void {
    const { renderer: r, scene } = this.ctx;
    p.dirty = false;
    this.lastCapture = performance.now();
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.visible && HIDE(o)) hidden.push(o);
    });
    for (const o of hidden) o.visible = false;
    const bg = scene.background;
    if (scene.environment) scene.background = scene.environment;
    const autoClear = r.autoClear;
    r.autoClear = true;
    try {
      p.camera.position.copy(p.position);
      p.camera.updateMatrixWorld(true);
      p.camera.update(r, scene);
      this.pmrem ??= new THREE.PMREMGenerator(r);
      const env = this.pmrem.fromCubemap(p.target.texture, p.env ?? undefined);
      p.env = env;
      for (const m of p.users) this.assign(m, env.texture);
    } finally {
      r.autoClear = autoClear;
      scene.background = bg;
      for (const o of hidden) o.visible = true;
    }
  }

  release(): void {
    if (--this.refs <= 0) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const f of this.off) f();
    for (const p of this.probes) {
      p.target.dispose();
      p.env?.dispose();
      for (const m of p.users) if (m.envMap === p.env?.texture) m.envMap = null;
    }
    this.probes.length = 0;
    this.pmrem?.dispose();
    if (sets.get(this.ctx) === this) sets.delete(this.ctx);
  }
}
