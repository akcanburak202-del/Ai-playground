import { SPEED_OF_SOUND } from '../core/units.ts';
import type { Rng } from '../core/rng.ts';

/**
 * Sample generators for the audio engine: coloured noise, granular textures (gravel crumble,
 * glass tinkle), the ballistic N-wave, one period of a rotary gun's firing pulse and the outdoor
 * reverb impulse response. Pure functions over Float32Arrays so they are unit-testable and can
 * be computed once per AudioContext and shared by every voice.
 */

export function whiteNoise(out: Float32Array, rng: Rng): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

/** Pink (−3 dB/oct) noise: Paul Kellet's refined 7-pole filter of white noise ("pink noise", musicdsp.org, 1999). */
export function pinkNoise(out: Float32Array, rng: Rng): Float32Array {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return normalise(out, 0.95);
}

/** Brown (−6 dB/oct) noise: leaky integral of white noise. */
export function brownNoise(out: Float32Array, rng: Rng): Float32Array {
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y = (y + 0.02 * (rng.next() * 2 - 1)) * 0.998;
    out[i] = y;
  }
  return normalise(out, 0.95);
}

export function normalise(out: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]!));
  if (max > 0) {
    const g = peak / max;
    for (let i = 0; i < out.length; i++) out[i]! *= g;
  }
  return out;
}

export interface GrainOptions {
  /** Grains per second at the start */
  rate: number;
  /** Grain centre frequency range, Hz */
  fLo: number;
  fHi: number;
  /** Grain ring time (T60), s */
  ring: number;
  /** Exponential time constant of the grain rate / amplitude envelope over the texture, s */
  envelope: number;
  /** Fraction of grains that are noisy clicks rather than tonal pings (0..1) */
  noisy: number;
}

/**
 * Granular texture: Poisson-distributed grains, each a short damped sinusoid (a pebble or glass
 * shard ringing briefly) or a filtered click. Rate and amplitude decay over the texture, so any
 * window of it sounds like debris settling. Played from a random offset for variety.
 */
export function grainTexture(out: Float32Array, sampleRate: number, rng: Rng, o: GrainOptions): Float32Array {
  out.fill(0);
  const dur = out.length / sampleRate;
  let t = 0;
  while (t < dur) {
    const env = Math.exp(-t / o.envelope);
    t += -Math.log(1 - rng.next() * 0.999) / Math.max(1, o.rate * (0.25 + 0.75 * env));
    const start = Math.floor(t * sampleRate);
    if (start >= out.length) break;
    const f = o.fLo * (o.fHi / o.fLo) ** rng.next();
    const amp = (0.2 + 0.8 * rng.next() ** 2) * (0.3 + 0.7 * env);
    const ring = o.ring * rng.range(0.5, 1.5);
    const n = Math.min(out.length - start, Math.ceil(ring * sampleRate));
    const k = Math.exp(-6.9 / (ring * sampleRate));
    if (rng.next() < o.noisy) {
      // Click: decaying noise, crudely band-limited by a one-pole low-pass at f.
      const a = Math.exp((-2 * Math.PI * f) / sampleRate);
      let y = 0, g = amp;
      for (let i = 0; i < n; i++) {
        y = (1 - a) * (rng.next() * 2 - 1) + a * y;
        out[start + i]! += y * g * 2.5;
        g *= k;
      }
    } else {
      const w = (2 * Math.PI * f) / sampleRate;
      let g = amp;
      for (let i = 0; i < n; i++) {
        out[start + i]! += Math.sin(w * i) * g;
        g *= k;
      }
    }
  }
  return normalise(out, 0.9);
}

/**
 * Ballistic N-wave of duration T (see acoustics.ballisticShock): a near-instant rise to +1, a
 * linear fall to −1 over T and a near-instant return, with ~15 µs rise times (real shock
 * fronts are a few µs; the rise is band-limited here) and a short ringing tail of the ear/mic.
 */
export function nWave(out: Float32Array, sampleRate: number, T: number): Float32Array {
  out.fill(0);
  const rise = Math.max(1, Math.round(15e-6 * sampleRate));
  const n = Math.max(2, Math.round(T * sampleRate));
  const pad = 2;
  for (let i = 0; i < rise && pad + i < out.length; i++) out[pad + i] = (i + 1) / rise;
  for (let i = 0; i <= n && pad + rise + i < out.length; i++) out[pad + rise + i] = 1 - (2 * i) / n;
  const back = pad + rise + n + 1;
  for (let i = 0; i < rise && back + i < out.length; i++) out[back + i] = -1 + (i + 1) / rise;
  return out;
}

/**
 * One loop of a rotary gun: `periods` firing pulses spaced at `period` seconds. Each pulse is a
 * sharp transient plus a short decaying noise body; small per-round variations keep the loop from
 * sounding synthetic. Played looped, a 3 900 rpm GAU-8 becomes the 65 Hz tone it really is.
 */
export function rotaryLoop(sampleRate: number, period: number, periods: number, rng: Rng, bodyTau: number): Float32Array {
  const out = new Float32Array(Math.max(periods, Math.round(period * periods * sampleRate)));
  const P = out.length / periods;
  for (let k = 0; k < periods; k++) {
    const start = Math.floor(k * P + rng.range(0, 0.04) * P);
    const amp = rng.range(0.8, 1);
    const n = Math.min(out.length - start, Math.floor(P * 1.6));
    const kd = Math.exp(-1 / (bodyTau * sampleRate));
    let g = amp, y = 0;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % out.length;
      const w = rng.next() * 2 - 1;
      y = 0.6 * y + 0.4 * w;
      const transient = i < 6 ? (1 - i / 6) * 1.6 : 0;
      out[idx]! += (y + transient) * g;
      g *= kd;
    }
  }
  return normalise(out, 0.9);
}

export interface Reflection {
  /** Extra path length of the reflection relative to the direct sound, m */
  path: number;
  /** Amplitude relative to the direct sound (spreading and absorption applied by the caller) */
  gain: number;
  /** −1 (left) … +1 (right) */
  pan: number;
}

export interface ImpulseOptions {
  duration: number;
  /** Diffuse-tail reverberation time at low and high frequencies, s */
  rt60Low: number;
  rt60High: number;
  reflections: Reflection[];
  /** Level of the diffuse tail relative to the discrete reflections */
  tail: number;
}

/**
 * Outdoor impulse response: discrete early reflections (slap-back off façades, delay = extra
 * path / 343 m/s, each a short filtered burst so it sounds like a surface and not a digital echo)
 * plus a sparse-to-dense diffuse tail with frequency-dependent decay (high frequencies die first,
 * as in the air and off rough stone). Stereo, normalised to unit energy.
 */
export function outdoorImpulse(sampleRate: number, rng: Rng, o: ImpulseOptions): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.round(o.duration * sampleRate));
  const L = new Float32Array(n), R = new Float32Array(n);
  // Early reflections.
  for (const r of o.reflections) {
    const t = r.path / SPEED_OF_SOUND;
    const start = Math.round(t * sampleRate);
    if (start >= n) continue;
    // Longer paths are duller (air) and more smeared (scattering off façade relief).
    const smear = Math.max(8, Math.round(sampleRate * (0.0008 + r.path * 0.00001)));
    const a = Math.exp((-2 * Math.PI * Math.max(900, 15000 - r.path * 60)) / sampleRate);
    const gl = r.gain * Math.sqrt(0.5 * (1 - r.pan)), gr = r.gain * Math.sqrt(0.5 * (1 + r.pan));
    let y = 0;
    for (let i = 0; i < smear * 4 && start + i < n; i++) {
      y = (1 - a) * (rng.next() * 2 - 1) + a * y;
      const e = Math.exp(-i / smear) * 3;
      L[start + i]! += y * e * gl;
      R[start + i]! += y * e * gr;
    }
  }
  // Diffuse tail: two bands with their own decay rates, onset after the first reflections.
  const onset = Math.round(0.012 * sampleRate);
  const kLo = -6.907755 / (o.rt60Low * sampleRate), kHi = -6.907755 / (o.rt60High * sampleRate);
  const aLo = Math.exp((-2 * Math.PI * 700) / sampleRate);
  let lL = 0, lR = 0;
  for (let i = onset; i < n; i++) {
    const t = i - onset;
    // Echo density builds up over the first ~80 ms (sparse at first, like a street canyon).
    const density = Math.min(1, t / (0.08 * sampleRate));
    const wL = rng.next() < 0.1 + 0.9 * density ? rng.next() * 2 - 1 : 0;
    const wR = rng.next() < 0.1 + 0.9 * density ? rng.next() * 2 - 1 : 0;
    lL = (1 - aLo) * wL + aLo * lL;
    lR = (1 - aLo) * wR + aLo * lR;
    const eLo = Math.exp(kLo * t), eHi = Math.exp(kHi * t);
    const fade = Math.min(1, t / (0.02 * sampleRate));
    L[i]! += o.tail * fade * (lL * 2.2 * eLo + (wL - lL) * 0.5 * eHi);
    R[i]! += o.tail * fade * (lR * 2.2 * eLo + (wR - lR) * 0.5 * eHi);
  }
  let e = 0;
  for (let i = 0; i < n; i++) e += L[i]! * L[i]! + R[i]! * R[i]!;
  const g = e > 0 ? 1 / Math.sqrt(e / 2) : 1;
  for (let i = 0; i < n; i++) {
    L[i]! *= g;
    R[i]! *= g;
  }
  return [L, R];
}

/**
 * Early reflections for a listener with façades at the given horizontal distances and bearings
 * (from ray casts against the scene). The ground bounce is always there; open directions fall
 * back to a distant tree line / terrain edge. Reflection gain = R_coef / (extra-path spreading).
 */
export function reflectionsFor(walls: { distance: number; pan: number }[], openRange = 220): Reflection[] {
  const out: Reflection[] = [{ path: 2.2, gain: 0.55, pan: 0 }];
  for (const w of walls) {
    const d = Number.isFinite(w.distance) ? w.distance : openRange;
    const path = 2 * d;
    const coef = Number.isFinite(w.distance) ? 0.8 : 0.35;
    out.push({ path, gain: coef / (1 + path / 12), pan: w.pan });
    // A second-order bounce (façade → ground → listener, or across a street) arrives later and weaker.
    if (Number.isFinite(w.distance) && d < 60) out.push({ path: path * 1.9 + 3, gain: (coef * 0.45) / (1 + (path * 1.9) / 12), pan: -w.pan * 0.5 });
  }
  return out;
}
