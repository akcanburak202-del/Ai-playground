import { Rng } from '../core/rng.ts';
import { MATERIALS, type MaterialProps } from '../physics/materials.ts';
import {
  brownNoise, grainTexture, nWave, outdoorImpulse, pinkNoise, reflectionsFor, rotaryLoop, whiteNoise, type Reflection,
} from './buffers.ts';
import { beamFrequencies, buildModes, plateFrequencies, renderModes } from './modal.ts';

/**
 * The Web Audio graph. Every sound plays through one of a fixed pool of voice buses
 * (input → air-absorption low-pass → stereo pan → dry to the master / wet to the reverb), so the
 * spatial chain is built once and reused, and the pool size is the voice limit. The master chain
 * is gain (mute) → slow-motion low-pass → compressor → limiter → soft clipper. Works on any
 * BaseAudioContext, so an OfflineAudioContext can render the exact same sounds for tests.
 */

export interface Spatial {
  /** Stereo position −1 … +1 */
  pan: number;
  /** Low-pass corner standing in for air absorption and head shadow, Hz */
  cutoff: number;
  /** Direct-path gain */
  dry: number;
  /** Send to the reverb */
  wet: number;
}

export class Bus {
  readonly input: GainNode;
  readonly lp: BiquadFilterNode;
  readonly pan: StereoPannerNode;
  readonly dry: GainNode;
  readonly wet: GainNode;
  busyUntil = 0;
  priority = 0;
  /** Per-sound nodes feeding `input` (disconnected when the bus is reused) */
  heads: AudioNode[] = [];
  sources: AudioScheduledSourceNode[] = [];

  constructor(ac: BaseAudioContext, master: AudioNode, reverb: AudioNode) {
    this.input = ac.createGain();
    this.lp = ac.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.5;
    this.pan = ac.createStereoPanner();
    this.dry = ac.createGain();
    this.wet = ac.createGain();
    this.input.connect(this.lp).connect(this.pan);
    this.pan.connect(this.dry).connect(master);
    this.pan.connect(this.wet).connect(reverb);
  }

  /** Stop everything scheduled on this bus and detach it from the graph. */
  clear(at: number, fade: boolean): void {
    for (const s of this.sources) {
      try {
        s.stop(at + (fade ? 0.03 : 0));
      } catch {
        /* never started or already stopped */
      }
    }
    if (fade) {
      for (const h of this.heads) {
        if (h instanceof GainNode) {
          h.gain.cancelScheduledValues(at);
          h.gain.setTargetAtTime(0, at, 0.006);
        }
      }
      const heads = this.heads;
      setTimeout(() => heads.forEach((h) => h.disconnect()), 80);
    } else {
      for (const h of this.heads) h.disconnect();
    }
    this.heads = [];
    this.sources = [];
  }

  setSpatial(s: Spatial, at: number, tc = 0): void {
    const set = (p: AudioParam, v: number) => {
      if (!Number.isFinite(v)) return;
      if (tc > 0) p.setTargetAtTime(v, at, tc);
      else {
        p.cancelScheduledValues(at);
        p.setValueAtTime(v, at);
      }
    };
    set(this.pan.pan, Math.max(-1, Math.min(1, s.pan)));
    set(this.lp.frequency, Math.max(40, Math.min(20000, s.cutoff)));
    set(this.dry.gain, Math.max(0, s.dry));
    set(this.wet.gain, Math.max(0, s.wet));
  }
}

/** A sound being built on a bus: recipes connect their nodes to `out` starting at time `t`. */
export class Voice {
  readonly ac: BaseAudioContext;
  readonly out: GainNode;
  readonly t: number;
  /** Slow-motion pitch factor ρ ∈ (0, 1]: frequencies × ρ, durations ÷ ρ */
  readonly rate: number;
  readonly bank: SampleBank;
  readonly rng: Rng;
  readonly bus: Bus;

  constructor(engine: AudioEngine, bus: Bus, t: number, rate: number, gain: number) {
    this.ac = engine.ac;
    this.bank = engine.bank;
    this.rng = engine.rng;
    this.bus = bus;
    this.t = t;
    this.rate = rate;
    this.out = engine.ac.createGain();
    this.out.gain.value = gain;
    this.out.connect(bus.input);
    bus.heads.push(this.out);
  }

  track(src: AudioScheduledSourceNode): void {
    this.bus.sources.push(src);
  }

  /** The sound's real end time (recipes return it); the bus is free again after that. */
  hold(until: number): void {
    if (Number.isFinite(until)) this.bus.busyUntil = until + 0.02;
  }
}

const NWAVE_US = [60, 90, 130, 190, 270, 380, 540];

/**
 * Samples computed once per context: coloured noise, granular debris textures, N-waves, the
 * soft-clip curve, and caches of modal ring buffers and rotary-gun loops.
 */
export class SampleBank {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  /** Gravel / concrete chips settling */
  readonly gravel: AudioBuffer;
  /** Glass shards, a few centimetres, ringing briefly */
  readonly tinkle: AudioBuffer;
  /** Tempered-glass dice: dense, fine, bright */
  readonly sizzle: AudioBuffer;
  readonly saturator: Float32Array<ArrayBuffer>;
  private readonly nwaves: AudioBuffer[];
  private readonly modal = new Map<string, AudioBuffer>();
  private readonly rotary = new Map<string, AudioBuffer>();
  private readonly ac: BaseAudioContext;
  private readonly rng: Rng;

  constructor(ac: BaseAudioContext, rng: Rng) {
    this.ac = ac;
    this.rng = rng;
    const sr = ac.sampleRate;
    const buf = (seconds: number, fill: (a: Float32Array) => void, channels = 1) => {
      const b = ac.createBuffer(channels, Math.max(1, Math.round(seconds * sr)), sr);
      for (let c = 0; c < channels; c++) fill(b.getChannelData(c));
      return b;
    };
    this.white = buf(2, (a) => whiteNoise(a, rng));
    this.pink = buf(3, (a) => pinkNoise(a, rng));
    this.brown = buf(4, (a) => brownNoise(a, rng));
    this.gravel = buf(3, (a) => grainTexture(a, sr, rng, { rate: 140, fLo: 900, fHi: 7000, ring: 0.012, envelope: 0.8, noisy: 0.75 }));
    this.tinkle = buf(3, (a) => grainTexture(a, sr, rng, { rate: 90, fLo: 2500, fHi: 11000, ring: 0.05, envelope: 1.0, noisy: 0.2 }));
    this.sizzle = buf(2.5, (a) => grainTexture(a, sr, rng, { rate: 900, fLo: 4000, fHi: 14000, ring: 0.012, envelope: 0.7, noisy: 0.35 }));
    this.nwaves = NWAVE_US.map((us) => buf(0.004, (a) => nWave(a, sr, us * 1e-6)));
    // Soft clipper: linear to 0.8, smooth knee into ±0.99.
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const ax = Math.abs(x);
      const y = ax < 0.8 ? ax : 0.8 + 0.19 * Math.tanh((ax - 0.8) / 0.19);
      curve[i] = Math.sign(x) * y;
    }
    this.saturator = curve;
  }

  /** N-wave closest to duration T, s */
  nwave(T: number): AudioBuffer {
    let best = 0;
    for (let i = 1; i < NWAVE_US.length; i++) if (Math.abs(NWAVE_US[i]! * 1e-6 - T) < Math.abs(NWAVE_US[best]! * 1e-6 - T)) best = i;
    return this.nwaves[best]!;
  }

  /**
   * Ring of a struck plate (a × b × h) or beam (length a, depth b; h = 0), quantised so repeated
   * hits on one element reuse the buffer. LRU-bounded.
   */
  modalRing(material: MaterialProps, a: number, b: number, h: number, contactTime: number): AudioBuffer {
    const q = (x: number) => (x <= 0 ? 0 : Math.round(Math.log(x) * 8));
    const key = `${material.id}|${q(a)}|${q(b)}|${q(h)}|${q(contactTime)}`;
    const hit = this.modal.get(key);
    if (hit) {
      this.modal.delete(key);
      this.modal.set(key, hit);
      return hit;
    }
    const glass = material.class === 'glass';
    const freqs = h > 0
      ? glass
        ? plateFrequencies(material, a, b, h, 14, 1500, 12000)
        : plateFrequencies(material, a, b, h, 12, 60, 9000)
      : beamFrequencies(material, a, b, 8).concat(plateFrequencies(material, b, b * 0.8, Math.max(0.006, b * 0.05), 5, 300, 6000));
    const eta = glass ? 0.012 : h > 0 ? 0.004 : 0.008;
    const modes = buildModes({ frequencies: freqs, eta, contactTime, jitter: 0.02, maxT60: glass ? 0.5 : 2.2 }, this.rng);
    const len = Math.min(2.4, Math.max(0.15, ...modes.map((m) => m.t60 * 1.1)));
    const buffer = this.ac.createBuffer(1, Math.round(len * this.ac.sampleRate), this.ac.sampleRate);
    renderModes(buffer.getChannelData(0), this.ac.sampleRate, modes, 0.9);
    this.modal.set(key, buffer);
    if (this.modal.size > 48) this.modal.delete(this.modal.keys().next().value!);
    return buffer;
  }

  /** Looping firing pulse train of a rotary gun, 12 rounds long. */
  rotaryLoop(rpm: number, bodyTau: number): AudioBuffer {
    const key = `${rpm}|${bodyTau}`;
    let b = this.rotary.get(key);
    if (!b) {
      const data = rotaryLoop(this.ac.sampleRate, 60 / rpm, 12, this.rng, bodyTau);
      b = this.ac.createBuffer(1, data.length, this.ac.sampleRate);
      b.getChannelData(0).set(data);
      this.rotary.set(key, b);
    }
    return b;
  }

  /** Default ring for a material when the struck element's size is unknown. */
  defaultRing(material: MaterialProps): AudioBuffer {
    if (material.class === 'glass') return this.modalRing(material, 1.2, 0.9, 0.008, 3e-5);
    return this.modalRing(material.id === 'rebar_b500' ? MATERIALS.rebar_b500 : material, 1.2, 0.8, 0.012, 3e-5);
  }
}

export interface EngineOptions {
  voices?: number;
  seed?: number;
  /** Output node (defaults to the context destination) */
  destination?: AudioNode;
}

export class AudioEngine {
  readonly ac: BaseAudioContext;
  readonly rng: Rng;
  readonly bank: SampleBank;
  readonly master: GainNode;
  readonly slowLp: BiquadFilterNode;
  readonly compressor: DynamicsCompressorNode;
  readonly limiter: DynamicsCompressorNode;
  readonly clipper: WaveShaperNode;
  readonly reverb: ConvolverNode;
  readonly reverbIn: GainNode;
  readonly reverbOut: GainNode;
  readonly buses: Bus[] = [];
  readonly stats = { started: 0, dropped: 0, stolen: 0 };
  private volume = 0.9;
  private muted = false;

  constructor(ac: BaseAudioContext, o: EngineOptions = {}) {
    this.ac = ac;
    this.rng = new Rng(o.seed ?? 7919);
    this.bank = new SampleBank(ac, this.rng);
    this.master = ac.createGain();
    this.master.gain.value = this.volume;
    this.slowLp = ac.createBiquadFilter();
    this.slowLp.type = 'lowpass';
    this.slowLp.frequency.value = 20000;
    this.slowLp.Q.value = 0.6;
    // Glue compressor: gentle 2:1 above −12 dBFS, so a blast ducks the gunfire a little without
    // flattening the difference between them. (The node adds its own makeup gain, ≈ +3.6 dB
    // here: (1 / full-range gain)^0.6 per the Web Audio spec.)
    this.compressor = ac.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 2;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.3;
    // Brick-wall-ish limiter, then a soft clipper that catches what its look-ahead misses.
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.15;
    this.clipper = ac.createWaveShaper();
    this.clipper.curve = this.bank.saturator;
    this.master.connect(this.slowLp).connect(this.compressor).connect(this.limiter).connect(this.clipper).connect(o.destination ?? ac.destination);

    this.reverbIn = ac.createGain();
    this.reverb = ac.createConvolver();
    this.reverb.normalize = false;
    this.reverbOut = ac.createGain();
    this.reverbOut.gain.value = 0.55;
    this.reverbIn.connect(this.reverb).connect(this.reverbOut).connect(this.master);
    this.setReflections(reflectionsFor([{ distance: 40, pan: -0.6 }, { distance: 65, pan: 0.7 }, { distance: Infinity, pan: 0 }]));

    const n = o.voices ?? 48;
    for (let i = 0; i < n; i++) this.buses.push(new Bus(ac, this.master, this.reverbIn));
  }

  get now(): number {
    return this.ac.currentTime;
  }

  get activeVoices(): number {
    const now = this.now;
    let n = 0;
    for (const b of this.buses) if (b.busyUntil > now) n++;
    return n;
  }

  /** Regenerate the reverb impulse response for a new set of façade reflections. */
  setReflections(reflections: Reflection[], rt60Low = 2.2, rt60High = 0.9): void {
    const [L, R] = outdoorImpulse(this.ac.sampleRate, this.rng, { duration: 2.8, rt60Low, rt60High, reflections, tail: 0.18 });
    const b = this.ac.createBuffer(2, L.length, this.ac.sampleRate);
    b.getChannelData(0).set(L);
    b.getChannelData(1).set(R);
    this.reverb.buffer = b;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    const g = this.master.gain;
    g.cancelScheduledValues(this.now);
    g.setTargetAtTime(m ? 0 : this.volume, this.now, 0.03);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (!this.muted) this.setMuted(false);
  }

  /** Slow motion dulls the world a little (and recipes pitch down): cutoff eases from 20 kHz to ~4 kHz. */
  setSlowMotion(scale: number): void {
    const s = Math.max(0, Math.min(1, scale));
    const f = 4000 * Math.pow(5, Math.min(1, (s - 0.1) / 0.9) * 1);
    this.slowLp.frequency.setTargetAtTime(s >= 0.999 ? 20000 : Math.min(20000, f), this.now, 0.08);
  }

  /**
   * Reserve a bus for a sound starting at `t` and lasting `duration` s. When every bus is busy the
   * lowest-priority sound that finishes soonest is faded out, unless the new sound matters less.
   */
  voice(priority: number, t: number, duration: number, spatial: Spatial, gain: number, rate = 1): Voice | null {
    const now = this.now;
    let free: Bus | null = null;
    let victim: Bus | null = null;
    for (const b of this.buses) {
      if (b.busyUntil <= now) {
        free = b;
        break;
      }
      if (!victim || b.priority < victim.priority || (b.priority === victim.priority && b.busyUntil < victim.busyUntil)) victim = b;
    }
    let bus = free;
    if (!bus) {
      if (!victim || victim.priority > priority) {
        this.stats.dropped++;
        return null;
      }
      victim.clear(now, true);
      this.stats.stolen++;
      bus = victim;
    } else if (bus.heads.length) {
      bus.clear(now, false);
    }
    bus.priority = priority;
    bus.busyUntil = t + duration;
    bus.setSpatial(spatial, now);
    this.stats.started++;
    return new Voice(this, bus, t, rate, gain);
  }

  /** End a long-running (looping) voice: fade over `release` s and free the bus afterwards. */
  release(v: Voice, release = 0.15): void {
    const now = this.now;
    v.out.gain.cancelScheduledValues(now);
    v.out.gain.setValueAtTime(v.out.gain.value, now);
    v.out.gain.setTargetAtTime(0, now, release / 4);
    for (const s of v.bus.sources) {
      try {
        s.stop(now + release + 0.05);
      } catch {
        /* already stopped */
      }
    }
    v.bus.busyUntil = now + release + 0.06;
  }

  /** Detach finished voices so their node graphs can be collected. */
  sweep(): void {
    const now = this.now;
    for (const b of this.buses) if (b.busyUntil <= now && b.heads.length) b.clear(now, false);
  }

  dispose(): void {
    for (const b of this.buses) b.clear(this.now, false);
    this.master.disconnect();
    this.reverbOut.disconnect();
  }
}
