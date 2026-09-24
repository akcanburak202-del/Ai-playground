import { MATERIALS } from '../physics/materials.ts';
import type { Voice } from './engine.ts';
import type { ReportProfile } from './profiles.ts';

const STEEL = MATERIALS.steel_s355;

/**
 * Sound recipes. Each one schedules a handful of Web Audio nodes on a Voice, starting at `v.t`,
 * and returns the sound's length in seconds. Recipes are written in real-time units; the voice's
 * slow-motion rate ρ scales every frequency by ρ and every duration by 1/ρ (a tape-speed model),
 * so the same code plays the slowed, deeper version in bullet time. Gains are relative: a recipe
 * peaks near 1 before the voice gain (the physical loudness) is applied.
 */

type NoiseKind = 'white' | 'pink' | 'brown';

interface NoiseOpts {
  /** Start offset from v.t, s */
  at?: number;
  attack: number;
  /** Amplitude time constant of the decay, s (the sound lasts ≈ 7τ) */
  tau: number;
  gain: number;
  type?: BiquadFilterType;
  freq?: number;
  q?: number;
  /** Sweep the filter towards this frequency with time constant `sweep` */
  freqTo?: number;
  sweep?: number;
  /** Second filter in series (e.g. a high-pass under a low-pass) */
  type2?: BiquadFilterType;
  freq2?: number;
  /** Hold the peak for this long before decaying, s */
  hold?: number;
  /** Connect here instead of the voice output */
  dest?: AudioNode;
}

function filter(v: Voice, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = v.ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.min(20000, Math.max(20, freq * v.rate));
  f.Q.value = q;
  return f;
}

function envelope(v: Voice, g: GainNode, t0: number, attack: number, hold: number, tau: number, peak: number): number {
  const a = Math.max(1e-4, attack / v.rate);
  const h = Math.max(0, hold / v.rate);
  const k = Math.max(1e-4, tau / v.rate);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  if (h > 0) g.gain.setValueAtTime(peak, t0 + a + h);
  g.gain.setTargetAtTime(0, t0 + a + h, k);
  return t0 + a + h + 7 * k;
}

function noiseBuffer(v: Voice, kind: NoiseKind): AudioBuffer {
  return kind === 'white' ? v.bank.white : kind === 'pink' ? v.bank.pink : v.bank.brown;
}

/** Filtered noise burst with an attack / hold / exponential-decay envelope. Returns end time. */
export function noise(v: Voice, kind: NoiseKind, o: NoiseOpts): number {
  const ac = v.ac;
  const t0 = v.t + (o.at ?? 0) / v.rate;
  const src = ac.createBufferSource();
  const buf = noiseBuffer(v, kind);
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = v.rate;
  const g = ac.createGain();
  let head: AudioNode = src;
  if (o.type && o.freq) {
    const f = filter(v, o.type, o.freq, o.q);
    if (o.freqTo) f.frequency.setTargetAtTime(Math.min(20000, Math.max(20, o.freqTo * v.rate)), t0, Math.max(1e-3, (o.sweep ?? o.tau) / v.rate));
    head.connect(f);
    head = f;
  }
  if (o.type2 && o.freq2) {
    const f2 = filter(v, o.type2, o.freq2);
    head.connect(f2);
    head = f2;
  }
  head.connect(g).connect(o.dest ?? v.out);
  const end = envelope(v, g, t0, o.attack, o.hold ?? 0, o.tau, o.gain);
  src.start(t0, v.rng.range(0, buf.duration * 0.9));
  src.stop(end);
  v.track(src);
  return end;
}

interface ToneOpts {
  at?: number;
  type?: OscillatorType;
  f0: number;
  /** Exponential glide target and its time constant */
  f1?: number;
  glide?: number;
  attack: number;
  tau: number;
  gain: number;
  hold?: number;
  /** Pass through the soft saturator (adds harmonics so low thumps survive small speakers) */
  drive?: number;
}

export function tone(v: Voice, o: ToneOpts): number {
  const ac = v.ac;
  const t0 = v.t + (o.at ?? 0) / v.rate;
  const osc = ac.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f0 * v.rate, t0);
  if (o.f1) osc.frequency.setTargetAtTime(o.f1 * v.rate, t0, Math.max(1e-3, (o.glide ?? o.tau) / v.rate));
  const g = ac.createGain();
  let head: AudioNode = osc;
  if (o.drive) {
    const pre = ac.createGain();
    pre.gain.value = o.drive;
    const ws = ac.createWaveShaper();
    ws.curve = v.bank.saturator;
    head.connect(pre).connect(ws);
    head = ws;
  }
  head.connect(g).connect(v.out);
  const end = envelope(v, g, t0, o.attack, o.hold ?? 0, o.tau, o.gain);
  osc.start(t0);
  osc.stop(end);
  v.track(osc);
  return end;
}

interface SampleOpts {
  at?: number;
  gain: number;
  /** Fade-in, s (default 2 ms; 0 for pulses shorter than that, like the N-wave) */
  attack?: number;
  rate?: number;
  /** Random start offset within the buffer (textures) */
  randomOffset?: boolean;
  /** Play at most this long, with a fade over the last 30 % */
  dur?: number;
  type?: BiquadFilterType;
  freq?: number;
  q?: number;
}

export function sample(v: Voice, buffer: AudioBuffer, o: SampleOpts): number {
  const ac = v.ac;
  const t0 = v.t + (o.at ?? 0) / v.rate;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const rate = (o.rate ?? 1) * v.rate;
  src.playbackRate.value = rate;
  const g = ac.createGain();
  let head: AudioNode = src;
  if (o.type && o.freq) {
    const f = filter(v, o.type, o.freq, o.q);
    head.connect(f);
    head = f;
  }
  head.connect(g).connect(v.out);
  const full = buffer.duration / rate;
  const dur = Math.min(full, o.dur ? o.dur / v.rate : full);
  const attack = o.attack ?? 0.002;
  if (attack > 0) {
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(o.gain, t0 + attack);
  } else g.gain.setValueAtTime(o.gain, t0);
  if (o.dur) {
    g.gain.setValueAtTime(o.gain, t0 + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
  }
  const offset = o.randomOffset ? v.rng.range(0, Math.max(0, buffer.duration - dur * rate)) : 0;
  src.start(t0, offset);
  src.stop(t0 + dur + 0.01);
  v.track(src);
  return t0 + dur;
}

// ─── Weapon reports ──────────────────────────────────────────────────────────────────────────

/** A muzzle report: shock-front crack, noise body, low thump, mechanism, rolling tail, back-blast. */
export function gunshot(v: Voice, p: ReportProfile): number {
  let end = v.t;
  const e = (x: number) => (end = Math.max(end, x));
  if (p.crack > 0) e(noise(v, 'white', { attack: 0.0002, tau: 0.0013, gain: 0.9 * p.crack, type: 'highpass', freq: p.crackHp, q: 0.6 }));
  e(noise(v, 'pink', { attack: 0.0004, tau: p.tauBody, gain: 1, type: 'lowpass', freq: p.fBody * 2.2, q: 0.9, type2: 'highpass', freq2: p.fBody * 0.3 }));
  e(tone(v, { f0: p.thump.f0, f1: p.thump.f1, glide: p.thump.tau * 1.5, attack: 0.001, tau: p.thump.tau, gain: p.thump.gain, drive: 2.2 }));
  if (p.tail > 0) e(noise(v, 'brown', { at: 0.004, attack: 0.02, tau: p.tauBody * 5 + 0.2 * p.tail, gain: 0.55 * p.tail, type: 'lowpass', freq: Math.max(70, p.fBody * 0.7) }));
  if (p.backblast > 0) {
    e(noise(v, 'white', { attack: 0.003, tau: 0.16, gain: 0.5 * p.backblast, type: 'lowpass', freq: 2600, freqTo: 500, sweep: 0.25 }));
    e(noise(v, 'pink', { at: 0.01, attack: 0.02, tau: 0.3, gain: 0.22 * p.backblast, type: 'highpass', freq: 900 }));
  }
  switch (p.mech) {
    case 'bolt':
      e(noise(v, 'white', { at: 0.052, attack: 0.0004, tau: 0.003, gain: 0.07, type: 'bandpass', freq: 3300, q: 5 }));
      e(noise(v, 'white', { at: 0.083, attack: 0.0004, tau: 0.004, gain: 0.06, type: 'bandpass', freq: 2300, q: 4 }));
      break;
    case 'belt':
      e(noise(v, 'white', { at: 0.028, attack: 0.0005, tau: 0.005, gain: 0.045, type: 'bandpass', freq: 2700, q: 3 }));
      break;
    case 'break':
      e(noise(v, 'white', { at: 0.22, attack: 0.0004, tau: 0.004, gain: 0.08, type: 'bandpass', freq: 2000, q: 4 }));
      break;
    case 'breech': {
      // Breech opens and the spent stub case clanks down.
      const ring = v.bank.modalRing(STEEL, 0.35, 0.2, 0.015, 2e-4);
      e(sample(v, ring, { at: 0.9, gain: 0.14, rate: 0.9 }));
      e(sample(v, ring, { at: 1.35, gain: 0.09, rate: 1.25 }));
      break;
    }
    default:
      break;
  }
  return end - v.t;
}

/** The distant thud of a gun or howitzer kilometres away: only the low end survives the air. */
export function distantReport(v: Voice): number {
  const a = noise(v, 'brown', { attack: 0.015, tau: 0.35, gain: 0.8, type: 'lowpass', freq: 140 });
  const b = tone(v, { f0: 55, f1: 38, attack: 0.01, tau: 0.25, gain: 0.5 });
  return Math.max(a, b) - v.t;
}

/** A fast jet passing overhead: broadband roar sweeping through Doppler, rising then falling. */
export function jetPass(v: Voice, duration = 7): number {
  const ac = v.ac;
  const t0 = v.t;
  const T = duration / v.rate;
  const src = ac.createBufferSource();
  src.buffer = v.bank.pink;
  src.loop = true;
  const lp = filter(v, 'lowpass', 500, 0.8);
  lp.frequency.setValueAtTime(500 * v.rate, t0);
  lp.frequency.linearRampToValueAtTime(3200 * v.rate, t0 + T * 0.45);
  lp.frequency.linearRampToValueAtTime(700 * v.rate, t0 + T);
  const hp = filter(v, 'highpass', 90);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.35, t0 + T * 0.35);
  g.gain.linearRampToValueAtTime(1, t0 + T * 0.48);
  g.gain.linearRampToValueAtTime(0.25, t0 + T * 0.7);
  g.gain.linearRampToValueAtTime(0, t0 + T);
  src.connect(lp).connect(hp).connect(g).connect(v.out);
  src.start(t0, v.rng.range(0, 2));
  src.stop(t0 + T + 0.05);
  v.track(src);
  // Turbine whine, Doppler-shifted down as the jet passes.
  const osc = ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(3600 * v.rate, t0);
  osc.frequency.setTargetAtTime(2500 * v.rate, t0 + T * 0.45, T * 0.06);
  const og = ac.createGain();
  og.gain.setValueAtTime(0, t0);
  og.gain.linearRampToValueAtTime(0.04, t0 + T * 0.42);
  og.gain.linearRampToValueAtTime(0, t0 + T * 0.75);
  osc.connect(og).connect(v.out);
  osc.start(t0);
  osc.stop(t0 + T);
  v.track(osc);
  return T;
}

// ─── Explosions ──────────────────────────────────────────────────────────────────────────────

export interface BlastSound {
  /** Positive-phase duration at the listener, s (Kingery–Bulmash) */
  td: number;
  /** TNT-equivalent mass, kg */
  tntKg: number;
  thermobaric: boolean;
  /** Distance to the listener, m */
  distance: number;
}

/**
 * Explosion: the shock front's crack, a low boom whose pitch follows the positive-phase
 * duration (f ≈ 0.35 / t_d: bigger and farther blasts are deeper), a noise body, and a long
 * rolling rumble as the wave echoes off the surroundings, then debris raining down.
 */
export function explosion(v: Voice, b: BlastSound): number {
  const w3 = Math.cbrt(Math.max(b.tntKg, 1e-4));
  const td = Math.max(5e-4, b.td);
  const fBoom = Math.min(150, Math.max(22, 0.35 / td));
  let end = v.t;
  const e = (x: number) => (end = Math.max(end, x));
  let at = 0;
  if (b.thermobaric) {
    // Fuel-air dispersal and burn: a rising "fwoomp" before and a roaring fireball after.
    e(noise(v, 'pink', { attack: 0.03, tau: 0.07, gain: 0.45, type: 'bandpass', freq: 260, freqTo: 900, sweep: 0.06, q: 0.8 }));
    at = 0.045;
    e(noise(v, 'pink', { at: at + 0.04, attack: 0.08, tau: 0.5 * w3 + 0.3, gain: 0.4, type: 'lowpass', freq: 650 }));
  }
  const slow = b.thermobaric ? 1.6 : 1;
  e(noise(v, 'white', { at, attack: 0.0003, tau: Math.min(0.03, Math.max(0.0015, td * 0.6)), gain: 1, type: 'highpass', freq: Math.min(3000, Math.max(300, 0.8 / td)), q: 0.6 }));
  e(tone(v, { at, f0: fBoom * 2.4, f1: fBoom * 0.8, glide: 0.12 * slow, attack: 0.002, tau: Math.min(0.6, Math.max(0.05, td * 9)) * slow, gain: 1, drive: 2.5 }));
  e(noise(v, 'pink', { at, attack: 0.001, tau: Math.min(0.6, td * 6 + 0.04) * slow, gain: 0.9, type: 'lowpass', freq: Math.min(2600, Math.max(220, fBoom * 9)), q: 0.7 }));
  // Rolling rumble with a slow amplitude wobble (discrete echoes smearing together).
  // The rolling tail grows with the charge: ≈ 2 s for a 58 g shell, ≈ 4 s for 1 kg, ≈ 15 s for a 500 lb bomb.
  const rumbleTau = Math.min(2.2, 0.1 + 0.45 * w3) * slow;
  const ac = v.ac;
  const lfo = ac.createOscillator();
  lfo.frequency.value = v.rng.range(3, 6) * v.rate;
  const depth = ac.createGain();
  depth.gain.value = 0.35;
  const wob = ac.createGain();
  wob.gain.value = 1;
  lfo.connect(depth).connect(wob.gain);
  wob.connect(v.out);
  e(noise(v, 'brown', { at: at + 0.02, attack: 0.06, tau: rumbleTau, gain: 0.6, type: 'lowpass', freq: 170, dest: wob }));
  const t0 = v.t + at / v.rate;
  lfo.start(t0);
  lfo.stop(end + 0.05);
  v.track(lfo);
  // Debris falling back: a few seconds of chips and gravel for charges big enough to throw it.
  if (b.tntKg >= 0.25 && b.distance < 160) {
    e(sample(v, v.bank.gravel, { at: at + 0.55 + 0.25 * w3, gain: 0.22 * Math.min(1, w3 / 2.5), rate: 0.75, randomOffset: true, dur: Math.min(2.6, 0.8 + 0.4 * w3) }));
  }
  return end - v.t;
}

// ─── Impacts ─────────────────────────────────────────────────────────────────────────────────

/** Concrete, stone, brick: a sharp snap, a thud whose pitch falls with calibre, and crumbling chips. */
export function brittleImpact(v: Voice, o: { energy: number; diameter: number; crumble: number; hardness: number }): number {
  const e1 = noise(v, 'white', { attack: 0.0002, tau: 0.0014, gain: 1.1, type: 'highpass', freq: 2200 * o.hardness });
  const fThud = Math.min(2000, Math.max(140, 1500 * Math.pow(0.0057 / Math.max(o.diameter, 0.002), 0.4)));
  const tau = Math.min(0.09, Math.max(0.006, 0.008 * Math.pow(Math.max(o.energy, 1) / 1600, 1 / 6)));
  const e2 = noise(v, 'pink', { attack: 0.0005, tau, gain: 1.4, type: 'lowpass', freq: fThud * 2, type2: 'highpass', freq2: 70 });
  const e3 = sample(v, v.bank.gravel, { at: 0.008, gain: 0.45 * (0.4 + o.crumble), rate: v.rng.range(0.85, 1.2), randomOffset: true, dur: Math.min(1.3, 0.12 + 0.7 * o.crumble) });
  return Math.max(e1, e2, e3) - v.t;
}

/** Steel: a bright strike transient over the modal ring of the struck member. */
export function metalImpact(v: Voice, o: { ring: AudioBuffer; perforate: boolean; shatter: boolean; heavy: number }): number {
  let end = noise(v, 'white', { attack: 0.0001, tau: 0.0009, gain: 0.75, type: 'highpass', freq: 4200 });
  end = Math.max(end, sample(v, o.ring, { gain: 0.85, rate: v.rng.range(0.97, 1.03) }));
  if (o.heavy > 0) end = Math.max(end, tone(v, { f0: 120, f1: 45, glide: 0.1, attack: 0.001, tau: 0.08 + 0.2 * o.heavy, gain: 0.8 * o.heavy, drive: 3 }));
  if (o.perforate) end = Math.max(end, noise(v, 'white', { at: 0.001, attack: 0.001, tau: 0.012, gain: 0.35, type: 'bandpass', freq: 1800, q: 1.2 }));
  if (o.shatter) end = Math.max(end, sample(v, v.bank.tinkle, { at: 0.003, gain: 0.2, rate: 1.6, randomOffset: true, dur: 0.12 }));
  return end - v.t;
}

/** Ricochet whine: the tumbling round's Doppler-falling pitch, amplitude-modulated by its tumble rate. */
export function ricochet(v: Voice, o: { speed: number }): number {
  const ac = v.ac;
  const t0 = v.t + 0.004 / v.rate;
  const f0 = Math.min(3800, Math.max(1100, o.speed * 3.2));
  const osc = ac.createOscillator();
  osc.frequency.setValueAtTime(f0 * v.rate, t0);
  osc.frequency.exponentialRampToValueAtTime(f0 * 0.33 * v.rate, t0 + 0.5 / v.rate);
  const am = ac.createGain();
  am.gain.value = 0.55;
  const lfo = ac.createOscillator();
  lfo.frequency.value = v.rng.range(55, 120) * v.rate;
  const depth = ac.createGain();
  depth.gain.value = 0.45;
  lfo.connect(depth).connect(am.gain);
  const g = ac.createGain();
  osc.connect(am).connect(g).connect(v.out);
  const end = envelope(v, g, t0, 0.006, 0.05, 0.13, 1);
  osc.start(t0);
  lfo.start(t0);
  osc.stop(end);
  lfo.stop(end);
  v.track(osc);
  v.track(lfo);
  return end - v.t;
}

/** Glass struck: crack, bright partials of the pane, a little tinkle of chips. */
export function glassImpact(v: Voice, o: { ring: AudioBuffer }): number {
  const a = noise(v, 'white', { attack: 0.0002, tau: 0.002, gain: 0.8, type: 'highpass', freq: 1800 });
  const b = sample(v, o.ring, { gain: 0.45, rate: v.rng.range(0.95, 1.08) });
  const c = sample(v, v.bank.tinkle, { at: 0.01, gain: 0.25, randomOffset: true, dur: 0.3 });
  return Math.max(a, b, c) - v.t;
}

/** Soil: a dull thump and the hiss of thrown dirt. */
export function soilImpact(v: Voice, o: { energy: number }): number {
  const big = Math.min(1, Math.log10(Math.max(o.energy, 10) / 1000) / 3);
  const a = noise(v, 'brown', { attack: 0.001, tau: 0.025 + 0.05 * big, gain: 1, type: 'lowpass', freq: 240 });
  const b = noise(v, 'pink', { attack: 0.004, tau: 0.05 + 0.08 * big, gain: 0.3, type: 'bandpass', freq: 2200, q: 0.8 });
  return Math.max(a, b) - v.t;
}

/** Supersonic crack of a passing round: the N-wave itself plus a faint high "zip". */
export function ballisticCrack(v: Voice, o: { buffer: AudioBuffer }): number {
  const a = sample(v, o.buffer, { gain: 1, attack: 0 });
  const b = noise(v, 'white', { attack: 0.0005, tau: 0.004, gain: 0.12, type: 'bandpass', freq: 5000, q: 1.5 });
  return Math.max(a, b) - v.t;
}

// ─── Debris, glass, structure ────────────────────────────────────────────────────────────────

/** One piece of rubble landing: click pitch falls with size; big pieces add a thud. */
export function clatter(v: Voice, o: { size: number; kind: 'stone' | 'metal' | 'glass'; ring?: AudioBuffer }): number {
  const s = Math.max(0.01, o.size);
  if (o.kind === 'metal' && o.ring) return sample(v, o.ring, { gain: 0.7, rate: v.rng.range(0.9, 1.1) }) - v.t;
  if (o.kind === 'glass') return sample(v, v.bank.tinkle, { gain: 0.5, rate: v.rng.range(0.8, 1.3), randomOffset: true, dur: 0.15 + 0.3 * Math.min(1, s) }) - v.t;
  const f = Math.min(6000, Math.max(250, 900 / Math.sqrt(s)));
  let end = noise(v, 'white', { attack: 0.0003, tau: 0.004 * Math.sqrt(s / 0.05), gain: 0.6, type: 'bandpass', freq: f, q: 1.8 });
  if (s > 0.2) end = Math.max(end, noise(v, 'brown', { attack: 0.002, tau: 0.03 * Math.sqrt(s), gain: 0.9, type: 'lowpass', freq: Math.max(60, 220 / Math.sqrt(s)) }));
  return end - v.t;
}

/** A pane letting go: the crash, the cascade of shards, and their second clatter on the ground. */
export function shatterCascade(v: Voice, o: { area: number; type: 'tempered' | 'annealed' | 'laminated' }): number {
  const a = Math.max(0.05, o.area);
  let end = noise(v, 'white', { attack: 0.001, tau: 0.03, gain: 0.9, type: 'bandpass', freq: o.type === 'laminated' ? 1200 : 3500, q: 0.6 });
  if (o.type === 'laminated') {
    end = Math.max(end, sample(v, v.bank.gravel, { at: 0.01, gain: 0.5, rate: 1.4, randomOffset: true, dur: 0.35 }));
    return end - v.t;
  }
  const tex = o.type === 'tempered' ? v.bank.sizzle : v.bank.tinkle;
  const dur = Math.min(2.4, 0.5 + 0.5 * Math.sqrt(a));
  end = Math.max(end, sample(v, tex, { at: 0.015, gain: 0.65, randomOffset: true, dur }));
  end = Math.max(end, sample(v, tex, { at: 0.55, gain: 0.45, rate: 0.9, randomOffset: true, dur: dur * 0.8 }));
  return end - v.t;
}

/** Structure about to go: stick–slip groaning and cracking snaps, then the collapse rumble. */
export function structuralFailure(v: Voice, o: { mass: number; steel: boolean; fallTime: number }): number {
  const ac = v.ac;
  const t0 = v.t;
  const T = 1.4 / v.rate;
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  const base = (o.steel ? 95 : 62) * v.rate;
  // Stick–slip: the pitch wanders in small jumps as the joint grinds.
  const pts = new Float32Array(24);
  let f = base;
  for (let i = 0; i < pts.length; i++) {
    f = Math.max(base * 0.6, Math.min(base * 1.8, f * v.rng.range(0.9, 1.12)));
    pts[i] = f;
  }
  osc.frequency.setValueCurveAtTime(pts, t0, T);
  const bp1 = filter(v, 'bandpass', o.steel ? 380 : 520, 7);
  const bp2 = filter(v, 'bandpass', o.steel ? 1150 : 900, 5);
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.35, t0 + T * 0.4);
  g.gain.linearRampToValueAtTime(0.5, t0 + T * 0.8);
  g.gain.linearRampToValueAtTime(0, t0 + T);
  osc.connect(bp1).connect(g);
  osc.connect(bp2).connect(g);
  g.connect(v.out);
  osc.start(t0);
  osc.stop(t0 + T + 0.02);
  v.track(osc);
  let end = t0 + T;
  // Snaps: concrete cracking or bolts shearing.
  for (let i = 0; i < 5; i++) {
    end = Math.max(end, noise(v, 'white', { at: v.rng.range(0.1, 1.3), attack: 0.0002, tau: 0.002, gain: v.rng.range(0.3, 0.7), type: 'highpass', freq: o.steel ? 2500 : 1500 }));
  }
  // The fall and the landing: a long low rumble and a ground-shaking thud.
  const m = Math.max(1, o.mass);
  const land = 1.2 + o.fallTime;
  const tau = Math.min(4, 0.6 + 0.45 * Math.log10(m));
  end = Math.max(end, noise(v, 'brown', { at: 1.1, attack: 0.25, tau, gain: 0.9, type: 'lowpass', freq: 120 }));
  end = Math.max(end, tone(v, { at: land, f0: 55, f1: 28, glide: 0.2, attack: 0.004, tau: 0.3 + 0.1 * Math.log10(m), gain: 0.9, drive: 2 }));
  end = Math.max(end, noise(v, 'pink', { at: land, attack: 0.003, tau: 0.12, gain: 0.6, type: 'lowpass', freq: 900 }));
  end = Math.max(end, sample(v, v.bank.gravel, { at: land + 0.05, gain: 0.35, rate: 0.7, randomOffset: true, dur: Math.min(2.8, 1 + 0.3 * Math.log10(m)) }));
  if (o.steel) {
    const ring = v.bank.modalRing(STEEL, 4, 0.3, 0, 5e-4);
    end = Math.max(end, sample(v, ring, { at: land, gain: 0.5, rate: 0.8 }));
  }
  return end - v.t;
}

/** A chunk breaking away: a crack and a short crumble. */
export function fractureSnap(v: Voice, o: { volume: number }): number {
  const c = Math.min(1, Math.cbrt(Math.max(o.volume, 1e-6)) / 0.5);
  const a = noise(v, 'white', { attack: 0.0002, tau: 0.003, gain: 0.6, type: 'highpass', freq: 1400 });
  const b = noise(v, 'brown', { attack: 0.002, tau: 0.02 + 0.06 * c, gain: 0.6 * c, type: 'lowpass', freq: 300 });
  const d = sample(v, v.bank.gravel, { at: 0.01, gain: 0.25 + 0.2 * c, rate: 0.9, randomOffset: true, dur: 0.2 + 0.6 * c });
  return Math.max(a, b, d) - v.t;
}

/** Charge placed: tape tearing and the detonator clip. */
export function chargePlaced(v: Voice): number {
  const a = noise(v, 'white', { attack: 0.01, hold: 0.08, tau: 0.02, gain: 0.25, type: 'bandpass', freq: 1800, q: 0.9 });
  const b = noise(v, 'white', { at: 0.2, attack: 0.0003, tau: 0.003, gain: 0.3, type: 'bandpass', freq: 3000, q: 4 });
  return Math.max(a, b) - v.t;
}

// ─── Loops ───────────────────────────────────────────────────────────────────────────────────

export interface LoopHandle {
  /** Filter whose frequency follows Doppler */
  tune: BiquadFilterNode;
  baseFreq: number;
  sources: AudioScheduledSourceNode[];
}

/** Rocket motor: roaring broadband noise with a crackling amplitude flutter. Runs until released. */
export function rocketLoop(v: Voice): LoopHandle {
  const ac = v.ac;
  const t0 = v.t;
  const w = ac.createBufferSource();
  w.buffer = v.bank.white;
  w.loop = true;
  const bp = filter(v, 'bandpass', 800, 0.6);
  const b = ac.createBufferSource();
  b.buffer = v.bank.brown;
  b.loop = true;
  const lp = filter(v, 'lowpass', 320);
  const flutter = ac.createGain();
  flutter.gain.value = 0.8;
  const lfo = ac.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = v.rng.range(19, 27);
  const depth = ac.createGain();
  depth.gain.value = 0.18;
  lfo.connect(depth).connect(flutter.gain);
  const gw = ac.createGain();
  gw.gain.value = 0.7;
  w.connect(bp).connect(gw).connect(flutter);
  b.connect(lp).connect(flutter);
  flutter.connect(v.out);
  for (const s of [w, b, lfo]) {
    s.start(t0, 0);
    v.track(s);
  }
  return { tune: bp, baseFreq: 800, sources: [w, b, lfo] };
}

/** Air rushing past a heavy incoming shell or bomb. */
export function rushLoop(v: Voice): LoopHandle {
  const ac = v.ac;
  const src = ac.createBufferSource();
  src.buffer = v.bank.pink;
  src.loop = true;
  const bp = filter(v, 'bandpass', 420, 0.9);
  const g = ac.createGain();
  g.gain.value = 1;
  src.connect(bp).connect(g).connect(v.out);
  const hiss = ac.createBufferSource();
  hiss.buffer = v.bank.white;
  hiss.loop = true;
  const hp = filter(v, 'highpass', 2600);
  const hg = ac.createGain();
  hg.gain.value = 0.12;
  hiss.connect(hp).connect(hg).connect(v.out);
  for (const s of [src, hiss]) {
    s.start(v.t, v.rng.range(0, 1.5));
    v.track(s);
  }
  return { tune: bp, baseFreq: 420, sources: [src, hiss] };
}

/**
 * Rotary gun: a looped pulse train at the firing rate (the buzz), the fundamental as a sine for
 * weight, and a noise roar. `rate` is the loop's playback rate (1 = real time).
 */
export function rotaryLoopVoice(v: Voice, o: { buffer: AudioBuffer; rpm: number; lowpass: number; rate: number }): LoopHandle {
  const ac = v.ac;
  const src = ac.createBufferSource();
  src.buffer = o.buffer;
  src.loop = true;
  src.playbackRate.value = o.rate;
  const lp = filter(v, 'lowpass', o.lowpass, 0.9);
  const pre = ac.createGain();
  pre.gain.value = 1.6;
  const ws = ac.createWaveShaper();
  ws.curve = v.bank.saturator;
  const g = ac.createGain();
  g.gain.value = 0.85;
  src.connect(lp).connect(pre).connect(ws).connect(g).connect(v.out);
  const sub = ac.createOscillator();
  sub.frequency.value = (o.rpm / 60) * o.rate;
  const sg = ac.createGain();
  sg.gain.value = 0.35;
  sub.connect(sg).connect(v.out);
  const roar = ac.createBufferSource();
  roar.buffer = v.bank.pink;
  roar.loop = true;
  const rbp = filter(v, 'bandpass', 900, 0.7);
  const rg = ac.createGain();
  rg.gain.value = 0.25;
  roar.connect(rbp).connect(rg).connect(v.out);
  for (const s of [src, sub, roar]) {
    s.start(v.t, 0);
    v.track(s);
  }
  return { tune: lp, baseFreq: o.lowpass, sources: [src, sub, roar] };
}

/** The electric drive spooling down after the trigger is released (M134). */
export function spinDown(v: Voice): number {
  return tone(v, { type: 'sawtooth', f0: 430, f1: 85, glide: 0.5, attack: 0.01, hold: 0.15, tau: 0.35, gain: 0.05 }) - v.t;
}
