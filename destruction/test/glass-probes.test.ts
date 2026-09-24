import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EventBus } from '../src/core/events.ts';
import type { SimContext, SimEvents } from '../src/app/contracts.ts';
import { ReflectionProbes } from '../src/destructibles/glass/probes.ts';
import {
  createReflectionMaterial, createGlassUniforms, createDiceMaterial, probeUniforms, GLASS_ENV_ROUGHNESS, GLASS_GLINT, GLASS_MAX_RADIANCE, GLASS_SUN_ROUGHNESS,
} from '../src/destructibles/glass/look.ts';

/**
 * A stand-in for WebGLRenderer with what the probes touch: the frame counter (advanced by every
 * render() call, as three does), render targets, shadow-map flags. It records what each render saw.
 */
function fakeRenderer() {
  const r = {
    info: { render: { frame: 0 }, programs: [] as string[] },
    coordinateSystem: THREE.WebGLCoordinateSystem,
    autoClear: false,
    shadowMap: { autoUpdate: true, needsUpdate: false },
    xr: { enabled: false },
    target: null as unknown,
    renders: [] as { face: number; shadowAuto: boolean; target: unknown; mips: boolean }[],
    face: 0,
    getRenderTarget: () => r.target,
    getActiveCubeFace: () => r.face,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(t: unknown, face = 0) {
      r.target = t;
      r.face = face;
    },
    /** Materials with a program (three's program cache, keyed here by material only) */
    known: new Set<THREE.Material>(),
    compiles: [] as { objects: THREE.Object3D[]; target: unknown }[],
    /** What each render drew and which lights it saw */
    drawn: [] as { objects: THREE.Object3D[]; lights: THREE.Light[] }[],
    extensions: { get: (_name: string) => null as unknown },
    program(m: THREE.Material) {
      if (r.known.has(m)) return;
      r.known.add(m);
      r.info.programs.push(m.uuid);
    },
    compile(scene: THREE.Object3D, _c: THREE.Camera, _t: THREE.Scene) {
      const objects: THREE.Object3D[] = [];
      scene.traverse((o) => {
        objects.push(o);
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) r.program(m);
      });
      r.compiles.push({ objects, target: r.target });
      return new Set();
    },
    render(s: THREE.Scene, _c: THREE.Camera) {
      r.info.render.frame++;
      const t = r.target as THREE.WebGLCubeRenderTarget | null;
      r.renders.push({ face: r.face, shadowAuto: r.shadowMap.autoUpdate, target: t, mips: !!t?.texture.generateMipmaps });
      const objects: THREE.Object3D[] = [], lights: THREE.Light[] = [];
      s.traverseVisible((o) => {
        if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (!m) return;
        objects.push(o);
        r.program(m);
      });
      r.drawn.push({ objects, lights });
    },
    /** The app's own frame: the composer renders a few times */
    mainFrame() {
      for (let k = 0; k < 3; k++) r.info.render.frame++;
    },
  };
  return r;
}

const uniforms = createGlassUniforms(new THREE.Texture(), 1, 1, 0.01, 1, new THREE.Color(1, 1, 1));
/** A glass reflection material (the probes feed its probe uniforms). */
const glassMat = () => createReflectionMaterial(uniforms);
const probeOf = (m: THREE.Material) => probeUniforms(m)!;

function makeCtx() {
  const renderer = fakeRenderer();
  const scene = new THREE.Scene();
  const env = new THREE.Texture();
  scene.environment = env;
  const glass = new THREE.Group();
  glass.name = 'glass:pane';
  scene.add(glass);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
  const ctx = { renderer, scene, camera, events: new EventBus<SimEvents>(), time: { now: 0, scale: 1, fixedDt: 1 / 60 } } as unknown as SimContext;
  return { ctx, renderer, scene, camera, glass };
}

/** Every pane of the scene calls update() once per frame, then the app renders. */
function frame(p: ReflectionProbes, r: ReturnType<typeof fakeRenderer>, panes: number): void {
  for (let k = 0; k < panes; k++) p.update();
  r.mainFrame();
}

test('probes: at most one cube face per rendered frame, however many panes ask', () => {
  const { ctx, renderer, camera } = makeCtx();
  const probes = ReflectionProbes.acquire(ctx)!;
  const mats = Array.from({ length: 12 }, glassMat);
  // Four probes 10 m apart, three panes each.
  mats.forEach((m, i) => probes.attach(new THREE.Vector3(10 * (i % 4), 2, 0), m));
  assert.equal(probes.stats.probes, 4);
  camera.position.set(31, 2, 5);
  // The first frame: 12 panes call update(); one face is rendered.
  frame(probes, renderer, 12);
  assert.equal(probes.stats.units, 1);
  assert.equal(renderer.renders.length, 1);
  // Stepping without rendering (Simulation.advance calls frameUpdate at 30 Hz): one unit for the
  // frame rendered since, then nothing, however many frame steps follow.
  for (let k = 0; k < 20; k++) for (let i = 0; i < 12; i++) probes.update();
  assert.equal(probes.stats.units, 2);
  // 4 probes × 6 faces: done after 24 rendered frames, never more than one face per frame.
  renderer.mainFrame();
  let before = probes.stats.units;
  for (let f = 2; f < 24; f++) {
    frame(probes, renderer, 12);
    assert.equal(probes.stats.units - before, 1, `frame ${f}: one unit`);
    before = probes.stats.units;
  }
  assert.equal(probes.stats.captures, 4);
  for (const m of mats) assert.ok(probeOf(m).uProbeOn.value === 1 && probeOf(m).uProbe.value, 'every pane has its probe');
  assert.equal(probeOf(mats[0]!).uProbeMaxLod.value, Math.log2(ReflectionProbes.resolution));
  // Mips are generated with the last face of a capture only.
  assert.deepEqual(renderer.renders.slice(0, 6).map((x) => x.mips), [false, false, false, false, false, true]);
  // The nearest probe to the viewer (x = 30) went first: its six faces were the first renders.
  const first = renderer.renders[0]!.target;
  assert.ok(renderer.renders.slice(0, 6).every((x) => x.target === first));
  // Faces 0–5 in order, rendered without re-rendering the shadow maps, which are restored.
  assert.deepEqual(renderer.renders.slice(0, 6).map((x) => x.face), [0, 1, 2, 3, 4, 5]);
  assert.ok(renderer.renders.every((x) => !x.shadowAuto || x.target === null));
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.equal(renderer.autoClear, false);
  // Everything is current: further frames do nothing.
  const u = probes.stats.units;
  for (let f = 0; f < 10; f++) frame(probes, renderer, 12);
  assert.equal(probes.stats.units, u);
  probes.release();
  assert.ok(probes.disposed);
});

test('probes: blasts and collapses recapture once after the scene settles (sim time), no storm', () => {
  const { ctx, renderer, glass } = makeCtx();
  const probes = ReflectionProbes.acquire(ctx)!;
  const mats = [0, 1, 2].map(glassMat);
  mats.forEach((m, i) => probes.attach(new THREE.Vector3(20 * i, 2, 0), m));
  for (let f = 0; f < 18; f++) frame(probes, renderer, 3);
  assert.equal(probes.stats.captures, 3);
  const u0 = probes.stats.units;
  // A collapse: a structural failure every 0.1 s for 3 s, one frame per 1/60 s.
  for (let f = 0; f < 180; f++) {
    ctx.time.now += 1 / 60;
    if (f % 6 === 0) ctx.events.emit('structuralFailure', { time: ctx.time.now, position: new THREE.Vector3(), label: 'x', mass: 1e4, cause: 'support-lost' });
    frame(probes, renderer, 3);
  }
  // Nothing during the collapse (still settling, and MAX_STALE not reached).
  assert.equal(probes.stats.units, u0, 'no recapture while failures keep coming');
  // 1.2 s after the last failure: one round of recaptures, one unit per frame.
  for (let f = 0; f < 120; f++) {
    ctx.time.now += 1 / 60;
    frame(probes, renderer, 3);
  }
  assert.equal(probes.stats.units - u0, 18, 'every probe recaptured exactly once');
  // Glass is hidden in the capture and shown again.
  assert.equal(glass.visible, true);
  // A never-ending stream of changes still gets the reflections updated (at the latest MAX_STALE s).
  const u1 = probes.stats.units;
  for (let f = 0; f < 60 * 8; f++) {
    ctx.time.now += 1 / 60;
    if (f % 6 === 0) ctx.events.emit('blast', { time: ctx.time.now, center: new THREE.Vector3(), tntKg: 1, kind: 'he', fireballRadius: 1 });
    frame(probes, renderer, 3);
  }
  assert.ok(probes.stats.units - u1 >= 18 && probes.stats.units - u1 <= 36, `units during an 8 s stream: ${probes.stats.units - u1}`);
  // A capture in progress pauses while a blast unfolds (its fresh rubble is the main pass's first),
  // and resumes once the scene has settled.
  for (let f = 0; f < 120; f++) {
    ctx.time.now += 1 / 60;
    frame(probes, renderer, 3);
  }
  const u2 = probes.stats.units;
  for (const pr of (probes as unknown as { probes: { dirty: boolean }[] }).probes) pr.dirty = true;
  frame(probes, renderer, 3);
  assert.equal(probes.stats.units, u2 + 1, 'a capture started');
  ctx.events.emit('blast', { time: ctx.time.now, center: new THREE.Vector3(), tntKg: 1, kind: 'he', fireballRadius: 1 });
  for (let f = 0; f < 30; f++) {
    ctx.time.now += 1 / 60;
    frame(probes, renderer, 3);
  }
  assert.equal(probes.stats.units, u2 + 1, 'paused while the blast unfolds');
  for (let f = 0; f < 60; f++) {
    ctx.time.now += 1 / 60;
    frame(probes, renderer, 3);
  }
  assert.ok(probes.stats.units > u2 + 6, 'resumed after it settled');
  probes.release();
});

test('probes: a probe nobody uses is freed; dispose hands the glass back to the scene environment', () => {
  const { ctx, renderer } = makeCtx();
  const probes = ReflectionProbes.acquire(ctx)!;
  const a = glassMat(), b = glassMat();
  probes.attach(new THREE.Vector3(0, 0, 0), a);
  probes.attach(new THREE.Vector3(50, 0, 0), b);
  // Not a glass reflection material: ignored.
  probes.attach(new THREE.Vector3(100, 0, 0), new THREE.MeshStandardMaterial());
  assert.equal(probes.stats.probes, 2);
  for (let f = 0; f < 12; f++) frame(probes, renderer, 2);
  assert.ok(probeOf(a).uProbeOn.value && probeOf(b).uProbeOn.value);
  probes.detach(b);
  assert.equal(probes.stats.probes, 1);
  assert.equal(probeOf(b).uProbeOn.value, 0);
  assert.equal(probeOf(b).uProbe.value, null);
  probes.release();
  assert.equal(probeOf(a).uProbeOn.value, 0);
  assert.equal(ReflectionProbes.of(ctx), null);
});

test('glass shaders: sun glint no sharper than the sun disc, capped, and never non-finite', () => {
  // Peak of GGX, D = 1/(π α²) with α = r² (Walter et al. 2007); a sun of E = 10 (brighter than any
  // scene's), slab reflectance ≈ 0.08, V = 1/4 at normal incidence.
  const peak = (r: number) => (10 * 0.08 * 0.25) / (Math.PI * r ** 4);
  assert.ok(peak(0.015) > 65504, 'the old floor overflowed half float');
  assert.ok(peak(GLASS_SUN_ROUGHNESS) < 65504 / 10, `glint peak ${peak(GLASS_SUN_ROUGHNESS).toFixed(0)}`);
  assert.ok(GLASS_ENV_ROUGHNESS >= 0.03);
  assert.ok(GLASS_GLINT * 10 < GLASS_MAX_RADIANCE && GLASS_MAX_RADIANCE * 8 < 65504);
  const u = createGlassUniforms(new THREE.Texture(), 1, 1, 0.01, 1, new THREE.Color(1, 1, 1));
  for (const m of [createReflectionMaterial(u), createReflectionMaterial(u, { shards: true }), createDiceMaterial({ value: 0 })]) {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
    const fs = shader.fragmentShader;
    assert.ok(fs.includes(`max( material.roughness, ${GLASS_SUN_ROUGHNESS.toFixed(4)} )`), `${m.name}: direct-light floor`);
    assert.ok(fs.includes(`directLight.color * ${GLASS_GLINT.toFixed(4)}`), `${m.name}: glint cap`);
    assert.ok(fs.includes('isinf( outgoingLight )') && fs.includes(`clamp( outgoingLight, 0.0, ${GLASS_MAX_RADIANCE.toFixed(1)} )`), `${m.name}: final guard`);
    assert.ok(!fs.includes('0.015 )'), `${m.name}: no 0.015 floor`);
    if (m.name.includes('reflection')) assert.ok(fs.includes('textureLod( uProbe, gR, gLod )'), `${m.name}: probe IBL`);
    m.dispose();
  }
});

test('probes: the capture keeps the lights, waits for shadow maps, and compiles new programs ahead', () => {
  const { ctx, renderer, scene, glass } = makeCtx();
  // Effects: particles (hidden in the capture) and the solid layer holding chips and the light pool.
  const fxRoot = new THREE.Group();
  fxRoot.name = 'fx-root';
  const fxSolid = new THREE.Group();
  fxSolid.name = 'fx-solid';
  const chips = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const pool = new THREE.Group();
  pool.name = 'fx-lights';
  const flash = new THREE.PointLight();
  pool.add(flash);
  fxSolid.add(chips, pool);
  fxRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  glass.add(new THREE.Mesh(new THREE.BoxGeometry(), glassMat()));
  scene.add(fxRoot, fxSolid, sun, wall);
  // The main pass has drawn the wall (its program exists) but not rendered the sun's shadow map yet.
  renderer.program(wall.material);
  const probes = ReflectionProbes.acquire(ctx)!;
  probes.attach(new THREE.Vector3(0, 2, 0), glassMat());
  frame(probes, renderer, 1);
  assert.equal(probes.stats.units, 0, 'no capture before the shadow maps exist');
  assert.equal(probes.stats.waits, 1);
  sun.shadow.map = new THREE.WebGLRenderTarget(4, 4);
  // A rubble mesh appears that the main pass has not drawn: its program is compiled ahead (in the
  // capture's render target), in a frame of its own, before any face is rendered.
  const rubble = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  scene.add(rubble);
  frame(probes, renderer, 1);
  assert.equal(probes.stats.units, 0);
  // (The wall is looked up too: found in the program cache, it costs nothing and does not count.)
  assert.ok(renderer.compiles.some((c) => c.objects.includes(rubble)));
  assert.ok(renderer.compiles.every((c) => c.target), 'compiled with the probe target bound');
  assert.equal(probes.stats.compiled, 1);
  for (let f = 0; f < 6; f++) frame(probes, renderer, 1);
  assert.equal(probes.stats.captures, 1);
  assert.equal(probes.stats.missed, 0, 'no face render compiled a program');
  // Every face saw the effect light (same light set as the main pass, so the same programs), and
  // neither the glass, the particles nor the chips.
  const d = renderer.drawn;
  assert.equal(d.length, 6);
  for (const x of d) {
    assert.ok(x.lights.includes(flash) && x.lights.includes(sun));
    assert.ok(x.objects.includes(wall) && x.objects.includes(rubble));
    assert.ok(!x.objects.includes(chips) && !x.objects.some((o) => o.parent === glass || o.parent === fxRoot));
  }
  assert.ok(chips.visible && glass.visible && fxRoot.visible);
  // One new program per frame at most when there is no parallel compile.
  const more = [0, 1, 2].map(() => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  scene.add(...more);
  ctx.events.emit('blast', { time: ctx.time.now, center: new THREE.Vector3(), tntKg: 1, kind: 'he', fireballRadius: 1 });
  ctx.time.now += 2;
  const c0 = renderer.compiles.length;
  for (let f = 0; f < 3; f++) frame(probes, renderer, 1);
  assert.equal(renderer.compiles.length - c0, 3);
  assert.equal(probes.stats.compiled, 4);
  assert.equal(probes.stats.captures, 1, 'the recapture starts once they are compiled');
  for (let f = 0; f < 6; f++) frame(probes, renderer, 1);
  assert.equal(probes.stats.captures, 2);
  assert.equal(probes.stats.missed, 0);
  probes.release();
});
