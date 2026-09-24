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
  const [L, R] = diffuseTail(sampleRate, rng, o);
  addReflections(L, R, sampleRate, rng, o.reflections);
  normaliseEnergy(L, R);
  return [L, R];
}

/**
 * The diffuse tail alone (two bands, each with its own RT60; onset after the first reflections,
 * echo density building up over ~80 ms). It does not depend on where the façades are, so callers
 * that rebuild the response as the listener moves compute it once and add the reflections to a
 * copy. Decay per sample exp(−6.91 / (RT60·fs)) applied multiplicatively (Sabine-type exponential
 * decay: −60 dB over RT60).
 */
export function diffuseTail(sampleRate: number, rng: Rng, o: Omit<ImpulseOptions, 'reflections'>): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.round(o.duration * sampleRate));
  const L = new Float32Array(n), R = new Float32Array(n);
  const onset = Math.round(0.012 * sampleRate);
  const dLo = Math.exp(-6.907755 / (o.rt60Low * sampleRate)), dHi = Math.exp(-6.907755 / (o.rt60High * sampleRate));
  const aLo = Math.exp((-2 * Math.PI * 700) / sampleRate);
  const densityN = 0.08 * sampleRate, fadeN = 0.02 * sampleRate;
  let lL = 0, lR = 0, eLo = 1, eHi = 1;
  for (let i = onset; i < n; i++) {
    const t = i - onset;
    // Echo density builds up over the first ~80 ms (sparse at first, like a street canyon).
    const density = t < densityN ? t / densityN : 1;
    const wL = rng.next() < 0.1 + 0.9 * density ? rng.next() * 2 - 1 : 0;
    const wR = rng.next() < 0.1 + 0.9 * density ? rng.next() * 2 - 1 : 0;
    lL = (1 - aLo) * wL + aLo * lL;
    lR = (1 - aLo) * wR + aLo * lR;
    const fade = t < fadeN ? t / fadeN : 1;
    L[i] = o.tail * fade * (lL * 2.2 * eLo + (wL - lL) * 0.5 * eHi);
    R[i] = o.tail * fade * (lR * 2.2 * eLo + (wR - lR) * 0.5 * eHi);
    eLo *= dLo;
    eHi *= dHi;
  }
  return [L, R];
}

/**
 * Add discrete early reflections (see outdoorImpulse) into a stereo response, in place. Returns
 * the energy this added (Σ new² − old² over the touched samples, both channels), so a caller that
 * knows the energy it started from can normalise with a gain instead of a pass over the buffer.
 */
export function addReflections(L: Float32Array, R: Float32Array, sampleRate: number, rng: Rng, reflections: readonly Reflection[]): number {
  const n = L.length;
  let dE = 0;
  for (const r of reflections) {
    const t = r.path / SPEED_OF_SOUND;
    const start = Math.round(t * sampleRate);
    if (start >= n) continue;
    // Longer paths are duller (air) and more smeared (scattering off façade relief).
    const smear = Math.max(8, Math.round(sampleRate * (0.0008 + r.path * 0.00001)));
    const a = Math.exp((-2 * Math.PI * Math.max(900, 15000 - r.path * 60)) / sampleRate);
    const gl = r.gain * Math.sqrt(0.5 * (1 - r.pan)), gr = r.gain * Math.sqrt(0.5 * (1 + r.pan));
    const k = Math.exp(-1 / smear);
    let y = 0, e = 3;
    for (let i = 0; i < smear * 4 && start + i < n; i++) {
      y = (1 - a) * (rng.next() * 2 - 1) + a * y;
      const j = start + i;
      const l0 = L[j]!, r0 = R[j]!;
      const l1 = l0 + y * e * gl, r1 = r0 + y * e * gr;
      L[j] = l1;
      R[j] = r1;
      dE += l1 * l1 - l0 * l0 + r1 * r1 - r0 * r0;
      e *= k;
    }
  }
  return dE;
}

/** Total energy of a stereo response, Σ L² + R². */
export function stereoEnergy(L: Float32Array, R: Float32Array): number {
  let e = 0;
  for (let i = 0; i < L.length; i++) e += L[i]! * L[i]! + R[i]! * R[i]!;
  return e;
}

/** Scale a stereo response to unit energy per channel (mean of the two). */
export function normaliseEnergy(L: Float32Array, R: Float32Array): void {
  const e = stereoEnergy(L, R);
  const g = e > 0 ? 1 / Math.sqrt(e / 2) : 1;
  for (let i = 0; i < L.length; i++) {
    L[i]! *= g;
    R[i]! *= g;
  }
}

/**
 * Early reflections for a listener with façades at the given horizontal distances and bearings
 * (from ray casts against the scene). The ground bounce is always there: for a sound made at the
 * listener it travels down and back up, an extra path of 2·h for a listener h metres above the
 * ground (image-source model; 2.2 m at eye height). Open directions fall back to a distant tree
 * line / terrain edge. Reflection gain = R_coef / (extra-path spreading).
 */
export function reflectionsFor(walls: { distance: number; pan: number }[], openRange = 220, groundPath = 2.2): Reflection[] {
  const gp = Number.isFinite(groundPath) ? Math.max(0.5, groundPath) : 2.2;
  const out: Reflection[] = [{ path: gp, gain: 0.55 / (1 + Math.max(0, gp - 2.2) / 12), pan: 0 }];
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

/**
 * Coarse signature of a set of façade distances (5 m bins, open = −1) and the listener height
 * (2 m bins): the reverb is rebuilt only when this changes, not for every step of a fly-past.
 */
export function reflectionSignature(distances: readonly number[], height: number): string {
  const d = distances.map((x) => (Number.isFinite(x) ? Math.round(x / 5) : -1)).join(',');
  return `${d}|${Math.round(Math.max(0, height) / 2)}`;
}
