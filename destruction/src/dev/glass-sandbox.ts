import * as THREE from 'three';
import { createSandbox } from './sandboxKit.ts';
import { Pipeline, type Quality } from '../render/Pipeline.ts';
import { BasicPipeline } from '../render/BasicPipeline.ts';
import type { GlassPaneSpec, SceneDef, SimContext } from '../app/contracts.ts';
import { createGlassPane, DiceSystem, GlassPane, ReflectionProbes } from '../destructibles/glass/index.ts';
import { installBallistics } from '../systems/index.ts';
import { installFx } from '../fx/index.ts';
import { createTerrain } from '../destructibles/terrain/index.ts';
import { getAmmo } from '../physics/ballistics/ammo.ts';
import { createBlastLoad } from '../physics/ballistics/blast.ts';
import type { ImpactEvent } from '../physics/ballistics/types.ts';

/**
 * Glass sandbox: a 3 × 2 curtain wall in dark bronze mullions (left column tempered 10 mm, middle
 * annealed 8 mm, right laminated 6+6 mm / 1.52 PVB) in front of a concrete interior, a 3 × 3 m
 * framed tempered pane (grey-green tint) before a travertine wall, and a frameless laminated pane
 * on stainless point fittings. Real projectiles, blasts and FX; `window.__glassDemo` drives the
 * scripted scenarios for scripts/shot.ts.
 *
 * URL: ?q=0|1|2 (render quality), ?basic (BasicPipeline + RoomEnvironment), ?terrain=0 (flat ground).
 */

const params = new URLSearchParams(location.search);
const useBasic = params.has('basic');
if (params.get('probes') === '0') ReflectionProbes.enabled = false;
const pipeline = useBasic ? new BasicPipeline() : new Pipeline({ quality: Number(params.get('q') ?? 2) as Quality });
const panes: Record<string, GlassPane> = {};
const disposables: { dispose(): void }[] = [];

/** Board-formed concrete / travertine / plaster: soft mottling, grain, horizontal banding. */
function stoneTexture(kind: 'concrete' | 'travertine' | 'plaster' | 'pavers'): THREE.DataTexture {
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
  const base = kind === 'travertine' || kind === 'pavers' ? [0.86, 0.8, 0.68] : kind === 'plaster' ? [0.8, 0.76, 0.7] : [0.66, 0.65, 0.62];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let c = 1 + 0.08 * (smooth(u, v, 4) - 0.5) + 0.05 * (smooth(u, v, 16) - 0.5) + 0.05 * (hash(x, y) - 0.5);
      if (kind === 'travertine') {
        c += 0.07 * Math.sin(v * 70 + 3 * smooth(u, v, 8)) * smooth(u, v, 2);
        if (hash(x >> 1, y) > 0.985) c -= 0.25;
      }
      if (kind === 'concrete' && y % 32 < 1) c -= 0.05;
      if (kind === 'pavers') {
        // 4 × 2 slabs per tile with 3 mm joints; each slab its own shade.
        const bx = Math.floor(x / 64), by = Math.floor(y / 128);
        c *= 0.93 + 0.1 * hash(bx + 17, by + 3);
        if (x % 64 < 1 || y % 128 < 1) c *= 0.72;
      }
      const i = 4 * (y * n + x);
      data[i] = Math.round(255 * Math.min(1, base[0]! * c));
      data[i + 1] = Math.round(255 * Math.min(1, base[1]! * c));
      data[i + 2] = Math.round(255 * Math.min(1, base[2]! * c));
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  disposables.push(t);
  return t;
}

function block(ctx: SimContext, mat: THREE.Material, size: [number, number, number], pos: [number, number, number], collider = true, rotY = 0): THREE.Mesh {
  const geo = new THREE.BoxGeometry(...size);
  disposables.push(geo);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos);
  m.rotation.y = rotY;
  m.castShadow = m.receiveShadow = true;
  ctx.world.add(m);
  if (collider) {
    const p = ctx.physics;
    p.createFixed(m.position.clone(), m.quaternion.clone(), [p.R.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setFriction(0.8)]);
  }
  return m;
}

function pane(ctx: SimContext, spec: GlassPaneSpec): GlassPane {
  const p = createGlassPane(ctx, spec) as GlassPane;
  panes[spec.name] = p;
  return p;
}

const TYPES: GlassPaneSpec['type'][] = ['tempered', 'annealed', 'laminated'];
const THICK = { tempered: 0.01, annealed: 0.008, laminated: 0.0135 } as const;

const kit = await createSandbox({
  title: 'glass sandbox',
  pipeline,
  camera: { position: [0.6, 1.75, 10.5], lookAt: [0.3, 1.9, 0] },
  install(sim) {
    installBallistics(sim);
    installFx(sim);
  },
  build(ctx) {
    for (const d of disposables.splice(0)) d.dispose();
    for (const k of Object.keys(panes)) delete panes[k];
    if (params.get('terrain') === '1') createTerrain(ctx, { plaza: { halfX: 16, halfZ: 12, finish: 'travertine' } });
    else {
      // Travertine plaza (0.6 × 0.9 m slabs) with a matching static collider, on the pipeline's ground.
      const pav = stoneTexture('pavers');
      pav.repeat.set(40 / 2.4, 30 / 1.8);
      const plazaMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: pav, roughness: 0.75 });
      disposables.push(plazaMat);
      const plaza = block(ctx, plazaMat, [40, 0.05, 30], [0, -0.021, 0]);
      plaza.castShadow = false;
    }
    if (useBasic) {
      // BasicPipeline has no sky light probe: a neutral room environment gives the glass something to reflect.
      const pm = new THREE.PMREMGenerator(ctx.renderer);
      import('three/addons/environments/RoomEnvironment.js').then(({ RoomEnvironment }) => {
        const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
        ctx.scene.environment = env;
        disposables.push(env, pm);
      });
    }
    const concrete = new THREE.MeshStandardMaterial({ color: 0xffffff, map: stoneTexture('concrete'), roughness: 0.9 });
    const travertine = new THREE.MeshStandardMaterial({ color: 0xffffff, map: stoneTexture('travertine'), roughness: 0.7 });
    const plaster = new THREE.MeshStandardMaterial({ color: 0xffffff, map: stoneTexture('plaster'), roughness: 0.95 });
    const bronze = new THREE.MeshStandardMaterial({ color: 0x2a241f, metalness: 0.85, roughness: 0.38 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x18191a, metalness: 0.6, roughness: 0.45 });
    const oak = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.6 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x5b2a1c, roughness: 0.5 });
    disposables.push(concrete, travertine, plaster, bronze, steel, oak, leather);

    // ── Pavilion bay behind the curtain wall: travertine floor, thin roof on chrome columns; open
    // behind so rounds leave into the distance (a travertine screen wall stands 16 m back). ──
    const chrome = new THREE.MeshStandardMaterial({ color: 0xe8eaec, metalness: 1, roughness: 0.12 });
    disposables.push(chrome);
    block(ctx, travertine, [5.8, 0.33, 6.5], [0, 0.165, -3.25]);
    block(ctx, plaster, [7.0, 0.22, 7.6], [0, 3.8, -3.1]);
    for (const x of [-1.9, 1.9]) {
      block(ctx, chrome, [0.16, 3.36, 0.02], [x, 2.02, -3.6], false);
      block(ctx, chrome, [0.02, 3.36, 0.16], [x, 2.02, -3.6], false);
    }
    block(ctx, travertine, [22, 3.6, 0.5], [0, 1.8, -16]);
    block(ctx, concrete, [0.4, 3.6, 7], [-3.3, 1.8, -6.5]);
    // Furniture seen through the glass: a table and a lounge chair (Barcelona-chair proportions).
    block(ctx, oak, [1.6, 0.05, 0.8], [-0.9, 1.08, -3.2], false);
    block(ctx, oak, [0.06, 0.72, 0.06], [-1.6, 0.69, -3.5], false);
    block(ctx, oak, [0.06, 0.72, 0.06], [-0.2, 0.69, -2.9], false);
    block(ctx, leather, [0.75, 0.12, 0.75], [1.1, 0.75, -2.6], false, 0.4);
    block(ctx, leather, [0.75, 0.62, 0.12], [1.25, 1.03, -2.95], false, 0.4);

    const W = 1.5, H = 1.6, m = 0.06;
    const x0 = -(1.5 * W + m);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 2; r++) {
        const type = TYPES[c]!;
        pane(ctx, {
          name: `cw-${type}-${r ? 'high' : 'low'}`, type, width: W, height: H, thickness: THICK[type],
          position: [x0 + m + W / 2 + c * (W + m), 0.33 + H / 2 + r * (H + m), 0], framed: true,
        });
      }
    }
    // Mullions (60 × 150 mm) and transoms, set just behind the glass line.
    for (let c = 0; c <= 3; c++) block(ctx, bronze, [m, 2 * H + 3 * m, 0.15], [x0 + m / 2 + c * (W + m), 0.33 + H + m / 2, -0.07], false);
    for (let r = 0; r <= 2; r++) block(ctx, bronze, [3 * W + 4 * m, m, 0.15], [0, 0.33 - m / 2 + r * (H + m), -0.07], false);

    // ── Across the plaza (what the glass reflects): a long travertine screen wall, a dark granite
    // plinth with a bronze figure, a row of clipped trees. ──
    const granite = new THREE.MeshStandardMaterial({ color: 0x2e2d2c, roughness: 0.35 });
    const leaves = new THREE.MeshStandardMaterial({ color: 0x3d4f2c, roughness: 0.85 });
    const bark = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.9 });
    disposables.push(granite, leaves, bark);
    // (Placed so their long golden-hour shadows fall clear of the glass.)
    block(ctx, travertine, [16, 2.2, 0.5], [-5, 1.1, 13]);
    block(ctx, granite, [1.2, 0.6, 1.2], [2.2, 0.3, 7.5]);
    block(ctx, bronze, [0.35, 1.6, 0.3], [2.2, 1.4, 7.5], false, 0.3);
    for (let k = 0; k < 5; k++) {
      const x = -22 + k * 3.2;
      block(ctx, bark, [0.18, 1.6, 0.18], [x, 0.8, 9], false);
      const g = new THREE.SphereGeometry(1.1, 18, 12);
      disposables.push(g);
      const crown = new THREE.Mesh(g, leaves);
      crown.position.set(x, 2.5, 9);
      crown.scale.set(1, 0.9, 1);
      crown.castShadow = crown.receiveShadow = true;
      ctx.world.add(crown);
    }

    // ── Large framed tempered pane (Barcelona-Pavilion grey-green), before a travertine wall ──
    const rot = -0.32;
    const cx = 6.6, cz = 0.9;
    pane(ctx, { name: 'big-tempered', type: 'tempered', width: 3, height: 3, thickness: 0.012, position: [cx, 1.56, cz], rotation: [0, rot, 0], tint: 0x9fb2a8, framed: true });
    const ax = new THREE.Vector3(Math.cos(rot), 0, -Math.sin(rot));
    const frame = (dx: number, y: number, w: number, h: number) => block(ctx, steel, [w, h, 0.06], [cx + ax.x * dx, y, cz + ax.z * dx - 0.02], false, rot);
    frame(-1.52, 1.56, 0.05, 3.1);
    frame(1.52, 1.56, 0.05, 3.1);
    frame(0, 3.08, 3.09, 0.05);
    frame(0, 0.035, 3.09, 0.07);
    block(ctx, travertine, [5.2, 3.4, 0.4], [8.2, 1.7, -7.5], true, -0.1);

    // ── Frameless laminated pane on point fittings, hung from two steel posts ──
    const lr = 0.35, lx = -5.9, lz = 1.2;
    pane(ctx, { name: 'lam-point', type: 'laminated', width: 1.8, height: 2.4, thickness: 0.0176, position: [lx, 1.45, lz], rotation: [0, lr, 0], framed: false });
    const lax = new THREE.Vector3(Math.cos(lr), 0, -Math.sin(lr));
    for (const s of [-1, 1]) {
      const px = lx + lax.x * s * 0.825, pz = lz + lax.z * s * 0.825;
      block(ctx, steel, [0.08, 3.0, 0.08], [px - Math.sin(lr) * 0.12, 1.5, pz - Math.cos(lr) * 0.12], false, lr);
    }
    block(ctx, concrete, [4.5, 3.2, 0.35], [-8.5, 1.6, -8.0], true, 0.25);
  },
});

const { sim, controls } = kit;
const ctx = sim.ctx;
if (pipeline instanceof Pipeline) {
  // Low golden-hour sun from the front-right: it rakes the mullions and glints in the cracks.
  const sceneDef: SceneDef = {
    id: 'glass', name: 'glass sandbox', nameTr: 'cam', blurb: '', blurbTr: '',
    spawn: { position: [0.6, 1.75, 10.5], lookAt: [0.3, 1.9, 0] }, sun: { elevation: 11, azimuth: 38 }, build: () => {},
  };
  pipeline.setup(ctx, sceneDef);
}

const v3 = (a: [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2]);

const demo = {
  panes,
  sim,
  THREE,
  view(position: [number, number, number], lookAt: [number, number, number], fov = 50) {
    ctx.camera.position.set(...position);
    controls.target.set(...lookAt);
    ctx.camera.fov = fov;
    ctx.camera.updateProjectionMatrix();
    controls.update();
    ctx.camera.lookAt(...lookAt);
  },
  /** Real projectiles from `from` towards `at`, `count` rounds `interval` s apart with a Gaussian spread (m at the target). */
  fire(ammo: string, from: [number, number, number], at: [number, number, number], count = 1, interval = 0.075, spread = 0, settle = 0.05) {
    const spec = ctx.ammo(ammo);
    const o = v3(from);
    const t0 = performance.now();
    const n0 = sim.impactLog.length;
    for (let k = 0; k < count; k++) {
      const target = v3(at).add(new THREE.Vector3(ctx.rng.gaussian(0, spread), ctx.rng.gaussian(0, spread), 0));
      const dir = target.sub(o).normalize();
      ctx.projectiles.spawn({ ammo: spec, origin: o.clone(), velocity: dir.multiplyScalar(spec.muzzleVelocity), target: v3(at) });
      if (k < count - 1) sim.advance(interval);
    }
    sim.advance(settle);
    const ev = sim.impactLog.slice(n0);
    return { ms: +(performance.now() - t0).toFixed(1), impacts: ev.length, glass: ev.filter((e) => e.targetKind === 'glass').map((e) => `${e.targetName}: ${e.outcome} ${e.speed.toFixed(0)}→${e.residualSpeed.toFixed(0)} m/s, E_abs ${e.energyAbsorbed.toFixed(0)} J`).slice(-4) };
  },
  /** Hand-made impact straight into a pane (no projectile flight). */
  impact(name: string, o: { ammo: string; from: [number, number, number]; at: [number, number, number] }) {
    const el = panes[name]!;
    const a = getAmmo(o.ammo);
    const from = v3(o.from), dir = v3(o.at).sub(from).normalize();
    const hit = el.raycast(from, dir, 100);
    if (!hit) return null;
    const speed = a.muzzleVelocity, ke = 0.5 * a.mass * speed * speed;
    const e: ImpactEvent = {
      time: ctx.time.now, ammo: a, agent: 'projectile', point: hit.point, direction: dir, normal: hit.normal, obliquity: Math.acos(Math.min(1, -dir.dot(hit.normal))),
      speed, mass: a.mass, kineticEnergy: ke, outcome: 'perforate', depth: el.thickness, exitPoint: hit.point.clone().addScaledVector(dir, el.thickness),
      residualSpeed: speed * 0.85, craterRadius: 1.5 * a.diameter, craterDepth: 0.5 * a.diameter, tunnelRadius: 0.6 * a.diameter, spallRadius: 3 * a.diameter, spallDepth: 0.5 * el.thickness,
      damageRadius: 15 * a.diameter, energyAbsorbed: 0.28 * ke, momentum: dir.clone().multiplyScalar(a.mass * speed * 0.15), material: hit.material,
      targetKind: 'glass', targetName: el.name, summary: 'hand-made',
    };
    el.applyImpact(e);
    ctx.events.emit('impact', e);
    return { point: hit.point.toArray() };
  },
  blast(at: [number, number, number], tntKg: number, settle = 0.02) {
    const t0 = performance.now();
    ctx.blasts.detonate({ center: v3(at), tntKg, kind: 'he' });
    sim.advance(settle);
    return { ms: +(performance.now() - t0).toFixed(1) };
  },
  /** Blast load delivered to one pane directly (no shock delay). */
  load(name: string, at: [number, number, number], tntKg: number) {
    const el = panes[name]!;
    const t0 = performance.now();
    el.applyBlast(createBlastLoad({ center: v3(at), tntKg, kind: 'he' }, ctx.time.now));
    return { ms: +(performance.now() - t0).toFixed(1) };
  },
  /** Advance in small fixed steps (slow motion: the tempered fracture front is 1.5 km/s). */
  step(seconds: number, dt = 1 / 60) {
    const t0 = performance.now();
    let t = 0;
    while (t < seconds - 1e-12) {
      const h = Math.min(dt, seconds - t);
      sim.fixedStep(h);
      t += h;
    }
    sim.frameStep(seconds, seconds);
    return +(performance.now() - t0).toFixed(1);
  },
  advance(s: number) {
    const t0 = performance.now();
    sim.advance(s);
    return +(performance.now() - t0).toFixed(1);
  },
  /** Mean render cost over n frames (CPU submit + GPU finish via a pixel read), ms. */
  renderMs(n = 3) {
    const gl = ctx.renderer.getContext();
    const px = new Uint8Array(4);
    const t0 = performance.now();
    for (let k = 0; k < n; k++) {
      sim.render(1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    return +((performance.now() - t0) / n).toFixed(1);
  },
  /** Debug: read the pane's damage texture back from the GPU at uv (R, G, B, A bytes). */
  texProbe(name: string, u: number, v: number) {
    const pane = panes[name]! as unknown as { uniforms: { uCrack: { value: THREE.Texture } }; raster: { sample(x: number, y: number, c: number): number } | null };
    const tex = pane.uniforms.uCrack.value;
    const rt = new THREE.WebGLRenderTarget(64, 64);
    const scene = new THREE.Scene();
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const geo = new THREE.PlaneGeometry(2, 2);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
    scene.add(new THREE.Mesh(geo, mat));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const r = ctx.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(scene, cam);
    const px = new Uint8Array(4);
    r.readRenderTargetPixels(rt, 32, 32, 1, 1, px);
    r.setRenderTarget(prev);
    rt.dispose(); mat.dispose(); geo.dispose();
    const p = panes[name]!;
    const x = (u - 0.5) * p.width, y = (v - 0.5) * p.height;
    const cpu = pane.raster ? [0, 1, 2].map((c) => Math.round(255 * pane.raster!.sample(x, y, c as 0))) : null;
    return { gpu: Array.from(px), cpu, version: tex.version, ranges: tex.updateRanges.length };
  },
  stats() {
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(panes)) {
      const s = p.stats;
      out[k] = { remaining: +p.remaining().toFixed(3), failed: p.hasFailed(), sag: +p.sag.toFixed(3), dmg: +p.laminatedDamage.toFixed(2), cracks: s.cracks, faces: s.faces, shards: s.shards, dice: s.dice, impactMs: +s.impactMs.toFixed(2), facesMs: +s.facesMs.toFixed(2), breakMs: +s.breakMs.toFixed(1), blastMs: +s.blastMs.toFixed(1), stepMs: +s.stepMs.toFixed(2), frameMs: +s.frameMs.toFixed(2) };
    }
    const info = ctx.renderer.info;
    const dice = ctx.scene.children.find((c) => c.name === 'glass-dice') as THREE.Mesh | undefined;
    out.dice = dice ? (dice.geometry as THREE.InstancedBufferGeometry).instanceCount : 0;
    out.bodies = ctx.physics.dynamicCount;
    out.drawCalls = info.render.calls;
    out.triangles = info.render.triangles;
    out.time = +ctx.time.now.toFixed(4);
    return out;
  },
  DiceSystem,
};
(window as unknown as { __glassDemo: typeof demo }).__glassDemo = demo;
