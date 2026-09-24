import { blastAt, hemisphericalCharge } from '../physics/ballistics/blast.ts';
import type { AmmoSpec } from '../physics/ballistics/types.ts';
import type { WeaponSpec } from '../app/contracts.ts';
import { MATERIALS } from '../physics/materials.ts';
import { ballisticShock, receivedSpl, splFromPressure, splToGain, airAbsorptionCutoff, impactLevelAt1m } from './acoustics.ts';
import { AudioEngine } from './engine.ts';
import { reportProfile } from './profiles.ts';
import * as S from './synth.ts';

/**
 * Offline render check (no speakers in CI): renders a set of sounds through the real engine into
 * an OfflineAudioContext and reports peak / RMS per clip, NaNs and clipped samples. Browser-only
 * (needs OfflineAudioContext); called by the UI sandbox.
 */

export interface ClipReport {
  name: string;
  /** Linear peak of the final output (after limiter and soft clip) */
  peak: number;
  peakDbfs: number;
  /** RMS over the clip's first 250 ms, dBFS */
  rmsDbfs: number;
  /** Peak before the master dynamics (headroom the limiter had to manage), dBFS */
  rawPeakDbfs: number;
  nans: number;
  /** Samples at or beyond ±0.999 */
  clipped: number;
  /** Seconds until the output falls below −60 dBFS for good */
  tail: number;
}

export interface OfflineReport {
  sampleRate: number;
  clips: ClipReport[];
  renderMs: number;
}

interface Clip {
  name: string;
  seconds: number;
  play(engine: AudioEngine, t: number): void;
}

const ammo = (o: Partial<AmmoSpec> & Pick<AmmoSpec, 'id' | 'mass' | 'muzzleVelocity' | 'diameter' | 'length'>): AmmoSpec => ({
  name: o.id, caliber: '', kind: 'ball', dragCd: 0.3, coreDensity: 11340, noseFactor: 1, deformable: true, fuze: 'none', note: '', ...o,
});
const weapon = (id: string, sound: string, category: WeaponSpec['category'], rpm = 600): WeaponSpec => ({
  id, name: id, role: '', category, ammo: [], rpm, fireMode: 'auto', dispersionMOA: 1, tracerEvery: 0, delivery: 'direct', recoil: 0.1, sound, zoom: 1, muzzleOffset: [0.15, -0.1, 0.5],
});

function shot(name: string, w: WeaponSpec, a: AmmoSpec, r: number): Clip {
  return {
    name, seconds: 2.2,
    play(engine, t) {
      const p = reportProfile(w, a);
      const v = engine.voice(3, t, 2, { pan: 0.2, cutoff: airAbsorptionCutoff(r), dry: 1, wet: 0.45 * (0.6 + r / 60) }, splToGain(receivedSpl(p.levelAt1m, r)));
      if (v) v.hold(t + S.gunshot(v, p));
    },
  };
}

function blast(name: string, tntKg: number, r: number, thermobaric = false): Clip {
  return {
    name, seconds: 4.5,
    play(engine, t) {
      const W = hemisphericalCharge(tntKg, 0, true);
      const bp = blastAt(W, r, thermobaric);
      const v = engine.voice(5, t, 4, { pan: -0.1, cutoff: airAbsorptionCutoff(r), dry: 1, wet: 0.8 * (0.6 + r / 60) }, splToGain(splFromPressure(bp.ps)));
      if (v) v.hold(t + S.explosion(v, { td: bp.td, tntKg, thermobaric, distance: r }));
    },
  };
}

const CLIPS: Clip[] = [
  shot('M4A1 5.56 at the shooter (1 m)', weapon('m4a1', 'rifle', 'rifle', 800), ammo({ id: 'm855', mass: 0.00402, muzzleVelocity: 905, diameter: 0.0057, length: 0.0231 }), 1),
  shot('M2HB .50 BMG at 1 m', weapon('m2hb', 'hmg', 'mg', 550), ammo({ id: 'm33', mass: 0.0428, muzzleVelocity: 887, diameter: 0.01295, length: 0.0584 }), 1),
  shot('120 mm tank gun at 3 m', weapon('tankgun', 'tank', 'cannon', 8), ammo({ id: 'm829a4', mass: 5.7, muzzleVelocity: 1555, diameter: 0.022, length: 0.8 }), 3),
  shot('RPG-7 launch at 1 m', weapon('rpg7', 'rpg', 'launcher', 4), ammo({ id: 'pg7vl', mass: 2.6, muzzleVelocity: 115, diameter: 0.093, length: 0.95 }), 1),
  blast('1 kg TNT at 20 m', 1, 20),
  blast('95 kg TNT (Mk 82) at 150 m', 95, 150),
  blast('2.2 kg thermobaric at 12 m', 2.2, 12, true),
  blast('58 g HEI (30 mm) at 40 m', 0.058, 40),
  {
    name: 'Steel plate struck by .50 at 30 m', seconds: 2.5,
    play(engine, t) {
      const r = 30;
      const v = engine.voice(2, t, 2, { pan: 0.3, cutoff: airAbsorptionCutoff(r), dry: 1, wet: 0.4 }, splToGain(receivedSpl(impactLevelAt1m(16000), r)));
      if (v) v.hold(t + S.metalImpact(v, { ring: engine.bank.modalRing(MATERIALS.rha, 1.5, 1.0, 0.02, 7e-5), perforate: false, shatter: false, heavy: 0 }));
    },
  },
  {
    name: 'Concrete struck by 5.56 at 25 m', seconds: 1.5,
    play(engine, t) {
      const r = 25;
      const v = engine.voice(2, t, 1, { pan: -0.3, cutoff: airAbsorptionCutoff(r), dry: 1, wet: 0.4 }, splToGain(receivedSpl(impactLevelAt1m(1600), r)));
      if (v) v.hold(t + S.brittleImpact(v, { energy: 1600, diameter: 0.0057, crumble: 0.4, hardness: 1 }));
    },
  },
  {
    name: 'Supersonic crack, 7.62 mm passing at 5 m', seconds: 1.2,
    play(engine, t) {
      const sh = ballisticShock(2.4, 0.00782, 0.0288, 5);
      const v = engine.voice(3, t, 0.5, { pan: 0.6, cutoff: 18000, dry: 1, wet: 0.3 }, splToGain(splFromPressure(sh.peakPa)));
      if (v) v.hold(t + S.ballisticCrack(v, { buffer: engine.bank.nwave(sh.duration) }));
    },
  },
  {
    name: 'GAU-8 one-second burst at the gun', seconds: 2.5,
    play(engine, t) {
      const w = weapon('gau8', 'gau8', 'cannon', 3900);
      const p = reportProfile(w, ammo({ id: 'pgu14', mass: 0.395, muzzleVelocity: 1013, diameter: 0.03, length: 0.113 }));
      const v = engine.voice(4, t, 1.3, { pan: 0, cutoff: 20000, dry: 1, wet: 0.5 }, splToGain(receivedSpl(p.levelAt1m + 3, 2)));
      if (!v) return;
      const h = S.rotaryLoopVoice(v, { buffer: engine.bank.rotaryLoop(3900, p.rotary!.bodyTau), rpm: 3900, lowpass: p.rotary!.lowpass, rate: 1 });
      v.out.gain.setTargetAtTime(0, t + 1, 0.02);
      for (const src of h.sources) src.stop(t + 1.2);
    },
  },
  {
    name: 'Tempered pane 3 m² shattering at 15 m', seconds: 3,
    play(engine, t) {
      const v = engine.voice(3, t, 3, { pan: -0.4, cutoff: airAbsorptionCutoff(15), dry: 1, wet: 0.5 }, splToGain(receivedSpl(118 + 10 * Math.log10(3), 15)));
      if (v) v.hold(t + S.shatterCascade(v, { area: 3, type: 'tempered' }));
    },
  },
  {
    name: 'Ricochet off granite at 20 m', seconds: 1.2,
    play(engine, t) {
      const v = engine.voice(2, t, 1, { pan: 0.4, cutoff: airAbsorptionCutoff(20), dry: 1, wet: 0.4 }, splToGain(receivedSpl(impactLevelAt1m(800), 20)));
      if (v) v.hold(t + S.ricochet(v, { speed: 700 }));
    },
  },
  {
    name: 'Structural failure, 40 t at 30 m', seconds: 6,
    play(engine, t) {
      const v = engine.voice(4, t, 6, { pan: 0.2, cutoff: airAbsorptionCutoff(30), dry: 1, wet: 1 }, splToGain(receivedSpl(112 + 10 * Math.log10(40000), 30)));
      if (v) v.hold(t + S.structuralFailure(v, { mass: 40000, steel: false, fallTime: 1.2 }));
    },
  },
  {
    name: 'Rocket motor 1.5 s at 15 m', seconds: 2.2,
    play(engine, t) {
      const v = engine.voice(4, t, 1.6, { pan: 0.1, cutoff: airAbsorptionCutoff(15), dry: 1, wet: 0.4 }, splToGain(receivedSpl(150, 15)));
      if (!v) return;
      const h = S.rocketLoop(v);
      v.out.gain.setTargetAtTime(0, t + 1.5, 0.03);
      for (const src of h.sources) src.stop(t + 1.7);
    },
  },
];

const SETTLE = 0.5;

async function renderClips(clips: Clip[], raw: boolean): Promise<{ data: Float32Array[]; sampleRate: number }[]> {
  const out: { data: Float32Array[]; sampleRate: number }[] = [];
  for (const c of clips) {
    const sr = 48000;
    const ac = new OfflineAudioContext(2, Math.round((c.seconds + SETTLE) * sr), sr);
    const engine = new AudioEngine(ac, { seed: 11 });
    if (raw) {
      // Bypass the master dynamics: measure what the limiter had to deal with.
      engine.master.disconnect();
      engine.master.connect(ac.destination);
    }
    // Sounds start after 0.5 s of silence so the master dynamics are in their running state.
    c.play(engine, SETTLE);
    const buf = await ac.startRendering();
    out.push({ data: [buf.getChannelData(0), buf.getChannelData(1)], sampleRate: sr });
  }
  return out;
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

export async function renderOfflineTest(): Promise<OfflineReport> {
  const t0 = performance.now();
  const final = await renderClips(CLIPS, false);
  const raw = await renderClips(CLIPS, true);
  const clips: ClipReport[] = CLIPS.map((c, i) => {
    const { data, sampleRate } = final[i]!;
    let peak = 0, nans = 0, clipped = 0, sum = 0, n = 0, last = 0;
    const k0 = Math.round(SETTLE * sampleRate);
    const rmsN = k0 + Math.round(0.25 * sampleRate);
    for (const ch of data) {
      for (let k = 0; k < ch.length; k++) {
        const x = ch[k]!;
        if (!Number.isFinite(x)) {
          nans++;
          continue;
        }
        const a = Math.abs(x);
        if (a > peak) peak = a;
        if (a >= 0.999) clipped++;
        if (a > 1e-3) last = Math.max(last, k);
        if (k >= k0 && k < rmsN) {
          sum += x * x;
          n++;
        }
      }
    }
    let rawPeak = 0;
    for (const ch of raw[i]!.data) for (let k = 0; k < ch.length; k++) rawPeak = Math.max(rawPeak, Math.abs(ch[k]!) || 0);
    return {
      name: c.name, peak, peakDbfs: db(peak), rmsDbfs: db(Math.sqrt(sum / Math.max(1, n))), rawPeakDbfs: db(rawPeak),
      nans, clipped, tail: Math.max(0, last / sampleRate - SETTLE),
    };
  });
  return { sampleRate: 48000, clips, renderMs: performance.now() - t0 };
}
