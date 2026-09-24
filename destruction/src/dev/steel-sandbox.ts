import * as THREE from 'three';
import { createSandbox } from './sandboxKit.ts';
import { Pipeline } from '../render/Pipeline.ts';
import type { FxApi, SceneDef, SimContext, SteelBeamSpec, SteelPlateSpec } from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import { createSteelBeam, createSteelPlate, SteelBeam, SteelPlate } from '../destructibles/steel/index.ts';
import { installBallistics } from '../systems/index.ts';
import { createBlastLoad } from '../physics/ballistics/blast.ts';
import { getAmmo } from '../physics/ballistics/ammo.ts';
import type { ImpactEvent } from '../physics/ballistics/types.ts';

/**
 * Steel sandbox: a 2 × 2 m, 20 mm S355 plate welded into a test frame, a 12 mm Corten facade
 * panel, an 8 mm RHA plate, an HEB 300 column carrying 3 MN, a chrome cruciform column (Mies) and
 * an IPE 300 beam across two piers. Real projectiles and blasts come from the ballistics module;
 * `window.__steelDemo` drives scripted scenarios for scripts/shot.ts.
 */

/** Tiny spark renderer (the FX module owns the real one): hot streaks with drag and gravity. */
class Sparks {
  private readonly max = 3000;
  private pos = new Float32Array(3 * this.max);
  private vel = new Float32Array(3 * this.max);
  private life = new Float32Array(this.max);
  private heat = new Float32Array(this.max);
  private n = 0;
  readonly points: THREE.Points;
  private colors = new Float32Array(3 * this.max);
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.035, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: true }));
    this.points.frustumCulled = false;
  }
  emit(p: THREE.Vector3, d: THREE.Vector3, count: number, speed: number, hot: number, rng: () => number): void {
    for (let k = 0; k < count && this.n < this.max; k++) {
      const i = this.n++;
      const dir = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(1.4).add(d).normalize();
      const s = speed * (0.3 + rng());
      this.pos.set([p.x, p.y, p.z], 3 * i);
      this.vel.set([dir.x * s, dir.y * s, dir.z * s], 3 * i);
      this.life[i] = 0.3 + rng() * 0.9;
      this.heat[i] = hot;
    }
  }
  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) continue;
      const k = 3 * i, o = 3 * w;
      const drag = Math.exp(-1.5 * dt);
      this.vel[k] = this.vel[k]! * drag;
      this.vel[k + 1] = this.vel[k + 1]! * drag - 9.81 * dt;
      this.vel[k + 2] = this.vel[k + 2]! * drag;
      this.pos[o] = this.pos[k]! + this.vel[k]! * dt;
      this.pos[o + 1] = Math.max(0.01, this.pos[k + 1]! + this.vel[k + 1]! * dt);
      this.pos[o + 2] = this.pos[k + 2]! + this.vel[k + 2]! * dt;
      this.vel[o] = this.vel[k]!;
      this.vel[o + 1] = this.vel[k + 1]!;
      this.vel[o + 2] = this.vel[k + 2]!;
      this.life[w] = this.life[i]!;
      this.heat[w] = this.heat[i]!;
      const b = Math.min(1, this.life[w]!) * (2 + 4 * this.heat[w]!);
      this.colors[o] = b;
      this.colors[o + 1] = b * 0.55;
      this.colors[o + 2] = b * 0.18;
      w++;
    }
    this.n = w;
    const g = this.points.geometry;
    g.setDrawRange(0, w);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}

const sparks = new Sparks();
const els: Record<string, Destructible> = {};
let floorBlock: THREE.Mesh | null = null;

function plate(ctx: SimContext, spec: SteelPlateSpec): SteelPlate {
  const p = createSteelPlate(ctx, spec) as SteelPlate;
  els[spec.name] = p;
  return p;
}
function beam(ctx: SimContext, spec: SteelBeamSpec): SteelBeam {
  const b = createSteelBeam(ctx, spec) as SteelBeam;
  els[spec.name] = b;
  return b;
}

/** Board-formed concrete for the plinths: mottling, fine grain and faint form seams. */
function concreteTexture(): THREE.DataTexture {
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  const hash = (x: number, y: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const smooth = (x: number, y: number, f: number) => {
    const X = x * f, Y = y * f, i = Math.floor(X), j = Math.floor(Y), u = X - i, v = Y - j;
    const a = hash(i % f, j % f), b = hash((i + 1) % f, j % f), c = hash(i % f, (j + 1) % f), d = hash((i + 1) % f, (j + 1) % f);
    const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let c = 0.62 + 0.07 * smooth(u, v, 4) + 0.05 * smooth(u, v, 16) + 0.05 * (hash(x, y) - 0.5);
      if ((y % 64) < 1) c -= 0.06;
      const i = 4 * (y * n + x);
      data[i] = Math.round(255 * c);
      data[i + 1] = Math.round(255 * c * 0.985);
      data[i + 2] = Math.round(255 * c * 0.95);
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}
const concrete = new THREE.MeshStandardMaterial({ color: 0xffffff, map: concreteTexture(), roughness: 0.92 });
function block(ctx: SimContext, size: [number, number, number], pos: [number, number, number]): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), concrete);
  m.position.set(...pos);
  m.castShadow = m.receiveShadow = true;
  ctx.world.add(m);
  return m;
}

const RHS: SteelBeamSpec['profile'] = { type: 'box', h: 0.12, b: 0.12, t: 0.008 };

const pipeline = new Pipeline({ quality: 2 });
const kit = await createSandbox({
  title: 'steel sandbox',
  pipeline,
  camera: { position: [2.2, 2.4, 9.5], lookAt: [1.6, 1.4, 0] },
  install(sim) {
    installBallistics(sim);
    const fx: FxApi = {
      ...sim.ctx.fx,
      sparks(o) {
        sparks.emit(o.position, o.direction, Math.min(80, o.count), o.speed, o.hot ?? 0.5, () => sim.ctx.rng.next());
      },
    };
    sim.ctx.fx = fx;
    sim.onFrame((realDt) => {
      sparks.update(sim.manual ? 1 / 60 : Math.min(realDt, 0.05) * sim.ctx.time.scale);
      const col = els['HEB 300 column'] as SteelBeam | undefined;
      if (col && floorBlock && !col.disposed) {
        const s = col.sim, top = s.n - 1;
        floorBlock.position.set(s.x[3 * top]!, s.x[3 * top + 1]! + 0.2, s.x[3 * top + 2]!);
      }
    });
  },
  build(ctx) {
    ctx.scene.add(sparks.points);

    // 1. 2 × 2 m, 20 mm S355 plate welded into a test frame on a concrete plinth.
    block(ctx, [3.2, 0.3, 1.2], [0, 0.15, 0]);
    beam(ctx, { name: 'frame left', material: 'steel_s355', profile: RHS, start: [-1.06, 0.3, 0], end: [-1.06, 2.66, 0], ends: { start: 'fixed', end: 'free' }, finish: 'painted', paintColor: 0x1d2a24 });
    beam(ctx, { name: 'frame right', material: 'steel_s355', profile: RHS, start: [1.06, 0.3, 0], end: [1.06, 2.66, 0], ends: { start: 'fixed', end: 'free' }, finish: 'painted', paintColor: 0x1d2a24 });
    beam(ctx, { name: 'frame top', material: 'steel_s355', profile: RHS, start: [-1.12, 2.6, 0], end: [1.12, 2.6, 0], up: [0, 1, 0], ends: { start: 'fixed', end: 'fixed' }, finish: 'painted', paintColor: 0x1d2a24 });
    plate(ctx, {
      name: 'S355 plate 20 mm', material: 'steel_s355', width: 2, height: 2, thickness: 0.02, position: [0, 1.52, 0],
      edges: { top: true, bottom: true, left: true, right: true }, finish: 'mill-scale',
    });

    // 2. 12 mm Corten facade panel hung between two posts from a head rail, footed on a sill.
    block(ctx, [1.8, 0.2, 0.6], [-3.4, 0.1, 0.6]);
    const cr0 = -0.35, tx = Math.cos(cr0), tz = -Math.sin(cr0);
    plate(ctx, {
      name: 'Corten panel 12 mm', material: 'steel_s355', width: 1.4, height: 3, thickness: 0.012, position: [-3.4, 1.72, 0.6], rotation: [0, cr0, 0],
      edges: { top: true, bottom: true, left: false, right: false }, finish: 'corten',
    });
    for (const sgn of [-1, 1]) {
      beam(ctx, { name: `Corten post ${sgn < 0 ? 'L' : 'R'}`, material: 'steel_s355', profile: RHS, start: [-3.4 + sgn * 0.84 * tx, 0.2, 0.6 + sgn * 0.84 * tz], end: [-3.4 + sgn * 0.84 * tx, 3.34, 0.6 + sgn * 0.84 * tz], ends: { start: 'fixed', end: 'free' }, finish: 'mill-scale' });
    }
    beam(ctx, { name: 'Corten rail', material: 'steel_s355', profile: RHS, start: [-3.4 - 0.9 * tx, 3.28, 0.6 - 0.9 * tz], end: [-3.4 + 0.9 * tx, 3.28, 0.6 + 0.9 * tz], up: [0, 1, 0], ends: { start: 'fixed', end: 'fixed' }, finish: 'mill-scale' });

    // 3. 8 mm RHA plate on an armour test stand.
    block(ctx, [1.6, 0.4, 0.8], [3.3, 0.2, 0.8]);
    plate(ctx, {
      name: 'RHA plate 8 mm', material: 'rha', width: 1.2, height: 1.2, thickness: 0.008, position: [3.3, 1.02, 0.8], rotation: [0, -0.3, 0],
      edges: { top: false, bottom: true, left: true, right: true }, finish: 'armor',
    });

    // 4. HEB 300 column, 4 m, fixed base, held at the head, carrying 3 MN (the floor above).
    block(ctx, [1.0, 0.1, 1.0], [6.2, 0.05, -0.5]);
    const col = beam(ctx, { name: 'HEB 300 column', material: 'steel_s355', profile: { type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 }, start: [6.2, 0.1, -0.5], end: [6.2, 4.1, -0.5], up: [0, 0, 1], ends: { start: 'fixed', end: 'pinned' }, finish: 'painted', paintColor: 0x8a2a1c });
    col.setImposedLoad(3.0e6);
    floorBlock = block(ctx, [1.6, 0.4, 1.6], [6.2, 4.3, -0.5]);

    // 5. Chrome cruciform column (Barcelona Pavilion), 3.1 m, carrying a roof share.
    block(ctx, [0.8, 0.08, 0.8], [8.4, 0.04, 0.4]);
    const cr = beam(ctx, { name: 'chrome cruciform', material: 'stainless', profile: { type: 'cruciform', arm: 0.08, t: 0.02 }, start: [8.4, 0.08, 0.4], end: [8.4, 3.18, 0.4], up: [0, 0, 1], ends: { start: 'fixed', end: 'pinned' }, finish: 'chrome' });
    cr.setImposedLoad(1.2e5);
    block(ctx, [1.2, 0.2, 1.2], [8.4, 3.28, 0.4]);

    // 6. IPE 300 beam across two piers.
    block(ctx, [0.6, 2.2, 0.6], [-1.9, 1.1, -3.6]);
    block(ctx, [0.6, 2.2, 0.6], [3.9, 1.1, -3.6]);
    beam(ctx, { name: 'IPE 300 beam', material: 'steel_s355', profile: { type: 'I', h: 0.3, b: 0.15, tw: 0.0071, tf: 0.0107 }, start: [-1.9, 2.35, -3.6], end: [3.9, 2.35, -3.6], up: [0, 1, 0], ends: { start: 'pinned', end: 'pinned' }, finish: 'fireproofed' });

  },
});

const { sim, controls } = kit;
const ctx = sim.ctx;
// Low golden-hour sun from the left, raking across the plates so dents read in the shading.
const sceneDef: SceneDef = {
  id: 'steel', name: 'steel sandbox', nameTr: 'çelik', blurb: '', blurbTr: '',
  spawn: { position: [2.2, 2.4, 9.5], lookAt: [1.6, 1.4, 0] }, sun: { elevation: 18, azimuth: 295 }, build: () => {},
};
pipeline.setup(ctx, sceneDef);
const v3 = (a: [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2]);

const demo = {
  els,
  sim,
  THREE,
  view(position: [number, number, number], lookAt: [number, number, number], fov?: number) {
    ctx.camera.position.set(...position);
    controls.target.set(...lookAt);
    if (fov) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
    controls.update();
    ctx.camera.lookAt(...lookAt);
  },
  /** Fire real projectiles (ballistics module) from → at, `count` rounds `interval` s apart. */
  fire(ammo: string, from: [number, number, number], at: [number, number, number], count = 1, interval = 0.06, spread = 0, settle = 0.1) {
    const spec = ctx.ammo(ammo);
    const o = v3(from);
    const t0 = performance.now();
    const n0 = sim.impactLog.length;
    for (let k = 0; k < count; k++) {
      const target = v3(at).add(new THREE.Vector3(ctx.rng.gaussian(0, spread), ctx.rng.gaussian(0, spread), ctx.rng.gaussian(0, spread)));
      const dir = target.sub(o).normalize();
      ctx.projectiles.spawn({ ammo: spec, origin: o.clone(), velocity: dir.multiplyScalar(spec.muzzleVelocity), target: v3(at) });
      if (k < count - 1) sim.advance(interval);
    }
    sim.advance(settle);
    return { ms: performance.now() - t0, impacts: sim.impactLog.slice(n0).map((e) => ({ target: e.targetName, outcome: e.outcome, speed: Math.round(e.speed), depth: e.depth, summary: e.summary })) };
  },
  /**
   * Detonate a charge (optionally in contact with a named element). With `ammo`, the charge, casing
   * and Gurney constant come from that round, so its casing fragments fly as real projectiles.
   */
  blast(o: { at: [number, number, number]; tntKg?: number; ammo?: string; kind?: 'he' | 'contact' | 'hesh'; normal?: [number, number, number]; contact?: string; travel?: [number, number, number]; settle?: number }) {
    const t0 = performance.now();
    const target = o.contact ? els[o.contact] : undefined;
    const a = o.ammo ? getAmmo(o.ammo) : undefined;
    ctx.blasts.detonate({
      center: v3(o.at), tntKg: o.tntKg ?? a?.explosiveTNT ?? 1, kind: o.kind ?? 'he', normal: o.normal ? v3(o.normal).normalize() : undefined, contactTargetId: target?.id,
      casingMass: a?.casingMass, gurney: a?.gurney, source: a, label: a?.name,
      travelDirection: o.travel ? v3(o.travel).normalize() : undefined, travelSpeed: o.travel && a ? a.muzzleVelocity : undefined,
    });
    sim.advance(o.settle ?? 0.05);
    return { ms: performance.now() - t0 };
  },
  /** Hand-made impact event straight into an element (no ballistics needed). */
  impact(name: string, o: { ammo: string; from: [number, number, number]; at: [number, number, number]; outcome: ImpactEvent['outcome']; speed?: number; tunnelRadius?: number; craterRadius?: number; craterDepth?: number; energyAbsorbed?: number }) {
    const el = els[name]!;
    const a = getAmmo(o.ammo);
    const from = v3(o.from), dir = v3(o.at).sub(from).normalize();
    const hit = el.raycast(from, dir, 100);
    if (!hit) return null;
    const speed = o.speed ?? a.muzzleVelocity;
    const ke = 0.5 * a.mass * speed * speed;
    const e: ImpactEvent = {
      time: ctx.time.now, ammo: a, agent: 'projectile', point: hit.point, direction: dir, normal: hit.normal, obliquity: Math.acos(Math.min(1, -dir.dot(hit.normal))),
      speed, mass: a.mass, kineticEnergy: ke, outcome: o.outcome, depth: o.outcome === 'perforate' ? 0.02 : 0.004, residualSpeed: o.outcome === 'perforate' ? speed * 0.6 : 0,
      craterRadius: o.craterRadius ?? a.diameter, craterDepth: o.craterDepth ?? 0.002, tunnelRadius: o.tunnelRadius ?? 0.55 * a.diameter, spallRadius: 0, spallDepth: 0,
      damageRadius: 4 * a.diameter, energyAbsorbed: o.energyAbsorbed ?? 0.5 * ke, momentum: dir.clone().multiplyScalar(a.mass * speed * 0.4), material: hit.material,
      targetKind: el.kind, targetName: el.name, summary: 'hand-made',
    };
    if (o.outcome === 'perforate') e.exitPoint = hit.point.clone().addScaledVector(dir, 0.02);
    el.applyImpact(e);
    return { point: hit.point.toArray() };
  },
  /** A blast load delivered directly (no shock delay). */
  load(name: string, o: { at: [number, number, number]; tntKg: number; kind?: 'he' | 'contact' | 'hesh'; contact?: boolean }) {
    const el = els[name]!;
    const load = createBlastLoad({ center: v3(o.at), tntKg: o.tntKg, kind: o.kind ?? 'he', contactTargetId: o.contact ? el.id : undefined }, ctx.time.now);
    const t0 = performance.now();
    el.applyBlast(load);
    return { ms: performance.now() - t0 };
  },
  advance(s: number) {
    const t0 = performance.now();
    sim.advance(s);
    return performance.now() - t0;
  },
  stats() {
    const out: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(els)) {
      if (e instanceof SteelPlate) out[k] = { ...e.stats, mode: e.mode, disposed: e.disposed, welds: e.sim.liveWelds(), plasticWork: Math.round(e.sim.plasticWork), particles: e.sim.n, tris: e.sim.nt, failed: e.hasFailed() };
      else if (e instanceof SteelBeam) out[k] = { ...e.stats, mode: e.mode, disposed: e.disposed, failed: e.hasFailed(), maxHinge: e.sim.maxHinge, plasticWork: Math.round(e.sim.plasticWork) };
    }
    out.pieces = ctx.registry.all().filter((d) => d.name.includes('piece') || /-(a|b)$/.test(d.name)).map((d) => d.name);
    out.drawCalls = ctx.renderer.info.render.calls;
    out.triangles = ctx.renderer.info.render.triangles;
    return out;
  },
};
(window as unknown as { __steelDemo: typeof demo }).__steelDemo = demo;
