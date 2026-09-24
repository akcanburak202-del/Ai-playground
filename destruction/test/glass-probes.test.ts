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
    info: { render: { frame: 0 } },
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
    render(_s: THREE.Scene, _c: THREE.Camera) {
      r.info.render.frame++;
      const t = r.target as THREE.WebGLCubeRenderTarget | null;
      r.renders.push({ face: r.face, shadowAuto: r.shadowMap.autoUpdate, target: t, mips: !!t?.texture.generateMipmaps });
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
