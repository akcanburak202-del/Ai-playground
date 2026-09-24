import { Simulation } from './app/Simulation.ts';
import { installHarness } from './app/harness.ts';
import { createElementFactories } from './app/elements.ts';
import { Pipeline } from './render/Pipeline.ts';
import { installFx } from './fx/index.ts';
import { installBallistics } from './systems/index.ts';
import { createWeaponController } from './weapons/index.ts';
import { installAudio } from './audio/index.ts';
import { installPlayer } from './player/index.ts';
import { installHud } from './ui/index.ts';
import { installStructure } from './structure/index.ts';
import { SCENES, SCENE_LOOKS, sceneById } from './scenes/index.ts';
import { applyLookAfterLoad, applyLookBeforeLoad } from './scenes/look.ts';

/**
 * App entry: builds the simulation with every subsystem, shows the scene menu over a live scene,
 * and exposes `window.__sim` for scripted runs.
 *
 * URL options: `#<scene-id>` opens that scene directly (range, chapel, pavilion, tower, temple);
 * `?q=0|1|2` render quality; `?touch` forces touch controls; `?manual` starts without real-time
 * stepping (used by scripts/shot.ts).
 */

const params = new URLSearchParams(location.search);
const boot = document.getElementById('boot')!;
const bootMsg = document.getElementById('boot-msg')!;

function status(text: string): void {
  bootMsg.textContent = text;
}

function fail(text: string, err?: unknown): void {
  boot.classList.remove('done');
  boot.classList.add('error');
  status(text);
  if (err) console.error(err);
}

/** Phones and small touch screens start at the lightest quality; everything else at the middle one. */
function pickQuality(): 0 | 1 | 2 {
  const q = params.get('q');
  if (q === '0' || q === '1' || q === '2') return Number(q) as 0 | 1 | 2;
  const coarse = matchMedia('(pointer: coarse)').matches;
  return coarse || Math.min(screen.width, screen.height) < 700 ? 0 : 1;
}

async function start(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) {
    fail('BU TARAYICI WEBGL2 DESTEKLEMİYOR. GÜNCEL BİR CHROME, EDGE, FIREFOX YA DA SAFARI İLE AÇIN.');
    return;
  }

  let sim: Simulation;
  const pipeline = new Pipeline({ quality: pickQuality() });
  try {
    sim = await Simulation.create({ canvas, pipeline });
  } catch (err) {
    fail('FİZİK MOTORU (WEBASSEMBLY) BAŞLATILAMADI. SAYFAYI YEREL OLARAK ÇALIŞTIRIN: npm install && npm run dev', err);
    return;
  }

  sim.factories = createElementFactories(sim.ctx);
  installStructure(sim);
  installBallistics(sim);
  const weapons = createWeaponController(sim);
  installFx(sim);
  installAudio(sim);

  let loading: Promise<void> = Promise.resolve();
  const load = (id: string): Promise<void> => {
    const def = sceneById(id) ?? SCENES[0]!;
    loading = loading.then(async () => {
      status(`${def.nameTr.toLocaleUpperCase('tr')} KURULUYOR`);
      // Per-scene photography (sky, exposure, ambient, lens, haze) around the scene build.
      applyLookBeforeLoad(pipeline, SCENE_LOOKS[def.id]);
      await sim.loadScene(def);
      applyLookAfterLoad(sim.ctx, SCENE_LOOKS[def.id]);
      if (location.hash.slice(1) !== def.id) history.replaceState(null, '', `#${def.id}`);
    });
    return loading;
  };

  installPlayer(sim, weapons, { canvas, touch: params.has('touch') || undefined, onReload: () => void load(sim.currentScene?.id ?? 'chapel') });
  const initial = location.hash.slice(1);
  installHud(sim, weapons, { scenes: SCENES, onSelectScene: load, startWithMenu: !sceneById(initial) });
  installHarness(sim);

  const resize = () => sim.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resize);
  resize();

  status('SAHNE KURULUYOR');
  try {
    await load(sceneById(initial) ? initial : 'chapel');
  } catch (err) {
    fail('SAHNE KURULAMADI. AYRINTI İÇİN TARAYICI KONSOLUNA BAKIN.', err);
    return;
  }

  sim.manual = params.has('manual');
  sim.start();
  boot.classList.add('done');
  (window as unknown as { __ready: boolean }).__ready = true;
}

start().catch((err) => fail('BEKLENMEYEN BİR HATA OLUŞTU.', err));
