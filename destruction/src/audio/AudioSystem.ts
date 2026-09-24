import * as THREE from 'three';
import type { Simulation } from '../app/Simulation.ts';
import type {
  AudioApi, BlastEvent, ChargeEvent, DebrisContactEvent, FractureEvent, Projectile, ShatterEvent, ShotEvent, SimContext,
  StructuralFailureEvent, System,
} from '../app/contracts.ts';
import type { Destructible } from '../destructibles/Destructible.ts';
import type { ImpactEvent } from '../physics/ballistics/types.ts';
import type { MaterialProps } from '../physics/materials.ts';
import { blastAt, hemisphericalCharge } from '../physics/ballistics/blast.ts';
import { G, SPEED_OF_SOUND, clamp } from '../core/units.ts';
import {
  airAbsorptionCutoff, ballisticShock, closestApproach, dopplerFactor, impactLevelAt1m, propagationDelay, receivedSpl,
  shockArrivalAfterPassing, splFromPressure, splToGain,
} from './acoustics.ts';
import { reflectionsFor } from './buffers.ts';
import { AudioEngine, type Spatial, type Voice } from './engine.ts';
import { reportProfile, type ReportProfile } from './profiles.ts';
import * as S from './synth.ts';

/** Scheduling slack between "now" and the first sample of a new sound, s. */
const LOOKAHEAD = 0.03;
const PRIORITY = { debris: 1, fragment: 1, impact: 2, crack: 3, shot: 3, shatter: 3, loop: 4, structure: 4, blast: 5 } as const;
/** Minimum spacing of impact sounds per material class (audio seconds); the rest are merged. */
const IMPACT_SPACING = 0.016;
const FRAGMENT_SPACING = 0.035;
const DEBRIS_SPACING = 0.018;
const CRACK_SPACING = 0.02;
const MAX_LOOPS = 6;

interface Track {
  id: number;
  x: number;
  y: number;
  z: number;
  own: boolean;
  cracked: boolean;
  seen: number;
}

interface Loop {
  id: number;
  voice: Voice;
  handle: S.LoopHandle;
  kind: 'rocket' | 'rush';
  seen: number;
  levelAt1m: number;
}

interface Rotary {
  weaponId: string;
  voice: Voice;
  handle: S.LoopHandle;
  profile: ReportProfile;
  /** Audio time of the latest round */
  lastShot: number;
  interval: number;
  gau8: boolean;
  /** Time scale the loop was last tuned to */
  scale: number;
}

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _ca = { s: 0, distance: 0 };
const _hits: Destructible[] = [];
const _size = new THREE.Vector3();

/**
 * Procedural sound for the simulation. Listens to the event bus (shots, impacts, blasts, debris,
 * glass, structural failures), follows flying projectiles for supersonic cracks, rocket motors
 * and incoming shells, and places every sound in space: delayed by distance / 343 m/s (Kingery–
 * Bulmash arrival time for blasts), attenuated by spreading, dulled by air absorption, panned
 * around the camera and sent to a reverb built from the scene's façades.
 *
 * Sim time → audio time: every event carries its simulation time; it is mapped to the audio clock
 * through the last frame's (sim, audio) pair, so rounds fired inside one fixed step (a 3 900 rpm
 * GAU-8) keep their true spacing, and in slow motion delays stretch with the picture.
 */
export class AudioSystem implements AudioApi, System {
  readonly name = 'audio';
  muted = false;
  /** Per-frame CPU cost of this system, ms (exponential average) */
  frameMs = 0;
  private readonly ctx: SimContext;
  private readonly sim: Simulation;
  private ac: AudioContext | null = null;
  engine: AudioEngine | null = null;
  private unsub: (() => void)[] = [];
  private simRef = 0;
  private audioRef = 0;
  private scale = 1;
  private rate = 1;
  private readonly listener = new THREE.Vector3();
  private readonly spatial: Spatial = { pan: 0, cutoff: 20000, dry: 1, wet: 0.3 };
  private readonly lastByClass = new Map<string, number>();
  private lastFragment = 0;
  private lastDebris = 0;
  private lastCrack = 0;
  private lastFracture = 0;
  private lastStructure = 0;
  private readonly tracks = new Map<number, Track>();
  private readonly trackPool: Track[] = [];
  private readonly loops = new Map<number, Loop>();
  private rotary: Rotary | null = null;
  private readonly profiles = new Map<string, ReportProfile>();
  private frame = 0;
  /** Rebuild the reverb from the scene's façades on the next frame (scene load, unlock) */
  private reflectPending = true;
  private readonly onVisibility = () => this.syncRunning();
  private lastSmallBlast = -1;
  private suspended = false;
  private unlocked = false;
  private disposed = false;

  /** Audio runs only while the page is visible and the simulation is not paused (menu). */
  private syncRunning(): void {
    if (!this.ac || !this.unlocked) return;
    const hold = (typeof document !== 'undefined' && document.hidden) || this.sim.paused;
    if (hold && !this.suspended) {
      this.suspended = true;
      this.stopLoops();
      void this.ac.suspend();
    } else if (!hold && this.suspended) {
      this.suspended = false;
      void this.ac.resume();
    }
  }

  constructor(sim: Simulation) {
    this.sim = sim;
    this.ctx = sim.ctx;
    const ev = this.ctx.events;
    this.unsub.push(
      ev.on('shot', (e) => this.onShot(e)),
      ev.on('impact', (e) => this.onImpact(e)),
      ev.on('blast', (e) => this.onBlast(e)),
      ev.on('debrisContact', (e) => this.onDebris(e)),
      ev.on('shatter', (e) => this.onShatter(e)),
      ev.on('fracture', (e) => this.onFracture(e)),
      ev.on('structuralFailure', (e) => this.onStructure(e)),
      ev.on('chargePlaced', (e) => this.onCharge(e)),
      ev.on('sceneLoaded', () => this.onScene()),
    );
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  // ─── AudioApi ──────────────────────────────────────────────────────────────────────────────

  unlock(): void {
    if (this.disposed) return;
    this.unlocked = true;
    if (!this.ac) {
      try {
        this.ac = new AudioContext({ latencyHint: 'interactive' });
        this.engine = new AudioEngine(this.ac, { seed: 20260924 });
        this.engine.setMuted(this.muted);
        this.reflectPending = true;
      } catch (err) {
        console.warn('audio: Web Audio unavailable', err);
        this.ac = null;
        this.engine = null;
        return;
      }
    }
    this.suspended = false;
    if (this.ac.state !== 'running') void this.ac.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.engine?.setMuted(muted);
    if (muted) this.stopLoops();
  }

  /** Master volume 0..1 */
  setVolume(v: number): void {
    this.engine?.setVolume(v);
  }

  get ready(): boolean {
    return !!this.engine && this.ac?.state === 'running' && !this.muted;
  }

  stats(): Record<string, number> {
    const e = this.engine;
    return {
      voices: e?.activeVoices ?? 0,
      started: e?.stats.started ?? 0,
      dropped: e?.stats.dropped ?? 0,
      stolen: e?.stats.stolen ?? 0,
      loops: this.loops.size + (this.rotary ? 1 : 0),
      tracked: this.tracks.size,
      frameMs: this.frameMs,
    };
  }

  // ─── System ────────────────────────────────────────────────────────────────────────────────

  frameUpdate(_simDt: number, _realDt: number): void {
    if (this.disposed) return;
    const t0 = performance.now();
    this.frame++;
    this.syncRunning();
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    cam.getWorldPosition(this.listener);
    _right.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    _fwd.setFromMatrixColumn(cam.matrixWorld, 2).negate().normalize();
    const scale = clamp(this.ctx.time.scale, 0.01, 1);
    if (this.engine && Math.abs(scale - this.scale) > 1e-3) this.engine.setSlowMotion(scale);
    this.scale = scale;
    // Tape-speed model for slow motion: an octave down at ×0.1.
    this.rate = Math.pow(scale, 0.3);
    if (this.ready) {
      this.followProjectiles();
      this.updateRotary();
      if (this.reflectPending) {
        this.reflectPending = false;
        this.updateReflections();
      }
      if ((this.frame & 15) === 0) this.engine!.sweep();
    }
    this.simRef = this.ctx.time.now;
    this.audioRef = this.ac?.currentTime ?? 0;
    this.frameMs += (performance.now() - t0 - this.frameMs) * 0.05;
  }

  reset(): void {
    this.stopLoops();
    this.recycleTracks(true);
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unsub) u();
    this.unsub = [];
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopLoops();
    this.engine?.dispose();
    void this.ac?.close();
    this.ac = null;
    this.engine = null;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────────────────────

  /** Audio-clock time at which something that happened at simulation time `simTime` is heard, plus a propagation delay (sim seconds). */
  private timeFor(simTime: number, delaySim = 0): number {
    const now = this.ac!.currentTime;
    const s = this.scale;
    const base = clamp(this.audioRef + (simTime - this.simRef) / s, now, now + 0.2);
    return base + LOOKAHEAD + Math.min(delaySim / s, 30);
  }

  /** Fill this.spatial for a source at p; returns the distance. */
  private place(p: THREE.Vector3, wetBase: number): number {
    _d.subVectors(p, this.listener);
    const r = _d.length();
    const sp = this.spatial;
    if (r > 1e-4) {
      _d.divideScalar(r);
      sp.pan = clamp(_d.dot(_right) * 0.9, -0.95, 0.95);
      // Sources behind the head lose some treble (head shadow / pinna).
      const behind = _d.dot(_fwd) < -0.2 ? 0.55 : 1;
      sp.cutoff = airAbsorptionCutoff(r) * behind;
    } else {
      sp.pan = 0;
      sp.cutoff = 20000;
    }
    sp.dry = 1;
    // Direct sound falls as 1/r, the diffuse reverberant field hardly at all.
    sp.wet = clamp(wetBase * (0.6 + r / 60), 0, 1.6);
    return r;
  }

  private profileFor(e: ShotEvent): ReportProfile {
    const key = `${e.weapon.id}|${e.ammo.id}`;
    let p = this.profiles.get(key);
    if (!p) {
      p = reportProfile(e.weapon, e.ammo);
      this.profiles.set(key, p);
    }
    return p;
  }

  // ─── Event handlers ────────────────────────────────────────────────────────────────────────

  private onShot(e: ShotEvent): void {
    if (!this.ready) return;
    const engine = this.engine!;
    const p = this.profileFor(e);
    if (p.rotary) {
      this.rotaryShot(e, p);
      return;
    }
    if (p.distant) {
      const t = this.timeFor(e.time);
      this.spatial.pan = 0;
      this.spatial.cutoff = 900;
      this.spatial.dry = 1;
      this.spatial.wet = 1.2;
      const v = engine.voice(PRIORITY.shot, t, 2, this.spatial, 0.1, this.rate);
      if (v) v.hold(t + S.distantReport(v));
      if (p.jet) {
        const j = engine.voice(PRIORITY.shot, t + 0.3, 8, this.spatial, 0.22, this.rate);
        if (j) {
          j.bus.setSpatial({ pan: -0.5, cutoff: 12000, dry: 1, wet: 0.8 }, engine.now);
          j.bus.pan.pan.linearRampToValueAtTime(0.6, t + 7);
          j.hold(t + 0.3 + S.jetPass(j));
        }
      }
      return;
    }
    const r = this.place(e.origin, 0.45);
    const gain = splToGain(receivedSpl(p.levelAt1m, r));
    const t = this.timeFor(e.time, propagationDelay(r));
    const v = engine.voice(PRIORITY.shot, t, 1, this.spatial, gain, this.rate);
    if (v) v.hold(t + S.gunshot(v, p));
  }

  private rotaryShot(e: ShotEvent, p: ReportProfile): void {
    const engine = this.engine!;
    const t = this.timeFor(e.time);
    const rot = p.rotary!;
    if (this.rotary && this.rotary.weaponId === e.weapon.id) {
      this.rotary.lastShot = Math.max(this.rotary.lastShot, t);
      return;
    }
    if (this.rotary) this.endRotary();
    const r = this.place(e.origin, 0.5);
    // A continuous stream of reports sums louder than one round: +3 dB.
    const gain = splToGain(receivedSpl(p.levelAt1m + 3, r));
    const v = engine.voice(PRIORITY.loop, t, 3600, this.spatial, 0, this.rate);
    if (!v) return;
    v.out.gain.setValueAtTime(0, t);
    v.out.gain.linearRampToValueAtTime(gain, t + 0.012);
    const buffer = engine.bank.rotaryLoop(rot.rpm, rot.bodyTau);
    const handle = S.rotaryLoopVoice(v, { buffer, rpm: rot.rpm, lowpass: rot.lowpass, rate: this.scale });
    this.rotary = { weaponId: e.weapon.id, voice: v, handle, profile: p, lastShot: t, interval: 60 / rot.rpm, gau8: e.weapon.sound === 'gau8', scale: this.scale };
  }

  private updateRotary(): void {
    const rot = this.rotary;
    if (!rot) return;
    const now = this.ac!.currentTime;
    // Follow the time scale (the loop is the rounds' real spacing); only schedule on a change.
    if (Math.abs(this.scale - rot.scale) > 1e-3) {
      rot.scale = this.scale;
      (rot.handle.sources[0] as AudioBufferSourceNode).playbackRate.setTargetAtTime(this.scale, now, 0.05);
      (rot.handle.sources[1] as OscillatorNode).frequency.setTargetAtTime(this.scale / rot.interval, now, 0.05);
    }
    // Stop once no round has come for a few firing intervals (in real time at this time scale).
    if (now > rot.lastShot + Math.max(0.07, (3 * rot.interval) / this.scale)) this.endRotary();
  }

  private endRotary(): void {
    const rot = this.rotary;
    if (!rot || !this.engine) return;
    this.rotary = null;
    const engine = this.engine;
    engine.release(rot.voice, 0.09);
    const t = engine.now + 0.06;
    this.spatial.pan = 0;
    this.spatial.cutoff = 6000;
    this.spatial.dry = 1;
    this.spatial.wet = 1.4;
    const gain = rot.voice.out.gain.value;
    const v = engine.voice(PRIORITY.shot, t, 2, this.spatial, gain * 0.6, this.rate);
    if (!v) return;
    // The burst's echo rolls back off the surroundings; the M134's motor spools down.
    let end = S.noise(v, 'brown', { attack: 0.01, tau: rot.gau8 ? 0.45 : 0.2, gain: 0.7, type: 'lowpass', freq: rot.gau8 ? 260 : 600 });
    if (!rot.gau8) end = Math.max(end, v.t + S.spinDown(v));
    v.hold(end);
  }

  private onImpact(e: ImpactEvent): void {
    if (!this.ready) return;
    const engine = this.engine!;
    const now = engine.now;
    const cls = e.material.class;
    if (e.agent === 'fragment') {
      if (now - this.lastFragment < FRAGMENT_SPACING) return;
      this.lastFragment = now;
    } else if (e.agent === 'jet') {
      return; // the shaped-charge blast carries this one
    } else {
      const last = this.lastByClass.get(cls) ?? -1;
      if (now - last < IMPACT_SPACING) return;
      this.lastByClass.set(cls, now);
    }
    const r = this.place(e.point, 0.35);
    const E = Math.max(e.energyAbsorbed, e.outcome === 'ricochet' ? e.kineticEnergy * 0.2 : 0, 1);
    let gain = splToGain(receivedSpl(impactLevelAt1m(E), r));
    if (e.agent === 'fragment') gain *= 0.6;
    const t = this.timeFor(e.time, propagationDelay(r));
    const prio = e.agent === 'fragment' ? PRIORITY.fragment : PRIORITY.impact;
    if (e.outcome === 'ricochet') {
      const w = engine.voice(prio, t, 1, this.spatial, gain * 0.8, this.rate);
      if (w) w.hold(t + S.ricochet(w, { speed: e.residualSpeed }));
      gain *= 0.6;
    }
    const v = engine.voice(prio, t, 1.5, this.spatial, gain, this.rate);
    if (!v) return;
    let len = 0.2;
    switch (cls) {
      case 'brittle': {
        const vol = (Math.PI / 3) * e.craterRadius * e.craterRadius * Math.max(e.craterDepth, 1e-4) + (e.spallRadius > 0 ? Math.PI * e.spallRadius ** 2 * e.spallDepth : 0);
        const crumble = clamp(Math.log10(Math.max(vol, 1e-9) / 1e-6) / 3, 0, 1);
        len = S.brittleImpact(v, { energy: E, diameter: e.ammo.diameter, crumble, hardness: hardness(e.material) });
        break;
      }
      case 'ductile': {
        const contact = clamp(e.ammo.length / Math.max(e.speed, 1), 1e-5, 2e-3);
        const ring = this.ringFor(e.material, e.point, e.outcome === 'perforate' ? e.depth * Math.cos(e.obliquity) : 0, contact);
        const heavy = clamp(Math.log10(E / 1e5) / 1.5, 0, 1);
        len = S.metalImpact(v, { ring, perforate: e.outcome === 'perforate', shatter: e.outcome === 'shatter', heavy });
        break;
      }
      case 'glass':
        len = S.glassImpact(v, { ring: this.ringFor(e.material, e.point, 0, 3e-5) });
        break;
      default:
        len = S.soilImpact(v, { energy: E });
        break;
    }
    v.hold(v.t + len);
  }

  /** Modal ring for the struck element, sized from the destructible under the point. */
  private ringFor(m: MaterialProps, point: THREE.Vector3, thickness: number, contact: number): AudioBuffer {
    const bank = this.engine!.bank;
    _hits.length = 0;
    this.ctx.registry.querySphere(point, 0.05, _hits);
    const d = _hits.find((x) => x.kind === 'plate' || x.kind === 'beam' || x.kind === 'rebar' || x.kind === 'glass');
    if (!d) return bank.defaultRing(m);
    d.bounds.getSize(_size);
    const dims = [_size.x, _size.y, _size.z].sort((a, b) => b - a) as [number, number, number];
    if (d.kind === 'rebar') return bank.modalRing(m, 1.2, 0.02, 0, contact);
    if (d.kind === 'beam') return bank.modalRing(m, dims[0], Math.max(0.1, dims[1]), 0, contact);
    const h = thickness > 0 ? thickness : m.class === 'glass' ? 0.008 : m.id === 'rha' ? 0.02 : 0.012;
    return bank.modalRing(m, Math.max(0.2, dims[0]), Math.max(0.2, dims[1]), clamp(h, 0.002, 0.08), contact);
  }

  private onBlast(e: BlastEvent): void {
    if (!this.ready) return;
    // A stream of small shells (GAU-8 HEI at 13 rounds/s) is heard as a crackle, not 13
    // separate full explosions a second: small blasts closer than 60 ms merge.
    if (e.tntKg < 0.25) {
      const now = this.engine!.now;
      if (now - this.lastSmallBlast < 0.06) return;
      this.lastSmallBlast = now;
    }
    const thermo = e.kind === 'thermobaric';
    const onSurface = !!e.normal || e.kind === 'contact' || e.kind === 'hesh';
    const W = hemisphericalCharge(e.tntKg, e.center.y, onSurface);
    const r = this.place(e.center, 0.8);
    const bp = blastAt(W, Math.max(r, 0.5), thermo);
    const gain = splToGain(splFromPressure(bp.ps));
    // Kingery–Bulmash arrival time: faster than sound close in (shock), → r / c far away.
    const t = this.timeFor(e.time, Number.isFinite(bp.ta) ? bp.ta : r / SPEED_OF_SOUND);
    const v = this.engine!.voice(PRIORITY.blast, t, 3, this.spatial, gain, this.rate);
    if (v) v.hold(t + S.explosion(v, { td: bp.td, tntKg: e.tntKg, thermobaric: thermo, distance: r }));
  }

  private onDebris(e: DebrisContactEvent): void {
    if (!this.ready || e.impulse < 0.3) return;
    const engine = this.engine!;
    const now = engine.now;
    if (now - this.lastDebris < DEBRIS_SPACING) return;
    this.lastDebris = now;
    const r = this.place(e.position, 0.3);
    // Impact noise of a falling piece grows with the contact impulse: L1 ≈ 90 + 15·log10(J / 1 N·s) dB (fit).
    const gain = splToGain(receivedSpl(90 + 15 * Math.log10(Math.max(e.impulse, 0.1)), r));
    const t = this.timeFor(e.time, propagationDelay(r));
    const v = engine.voice(PRIORITY.debris, t, 0.6, this.spatial, gain, this.rate);
    if (!v) return;
    const cls = e.material.class;
    const kind = cls === 'ductile' ? 'metal' : cls === 'glass' ? 'glass' : 'stone';
    const s = Math.max(0.02, e.size);
    const ring = kind === 'metal' ? (s > 1.5 ? engine.bank.modalRing(e.material, s, 0.25, 0, 5e-4) : engine.bank.modalRing(e.material, s, s * 0.6, clamp(s * 0.05, 0.004, 0.03), 3e-4)) : undefined;
    v.hold(v.t + S.clatter(v, { size: s, kind, ring }));
  }

  // Source levels at 1 m for glass, fracture and collapse are engineering estimates (fits to
  // recorded demolition audio, ±5 dB), scaled with the physical quantity the event reports.

  private onShatter(e: ShatterEvent): void {
    if (!this.ready) return;
    const r = this.place(e.position, 0.5);
    const gain = splToGain(receivedSpl(118 + 10 * Math.log10(Math.max(e.area, 0.05)), r));
    const t = this.timeFor(e.time, propagationDelay(r));
    const v = this.engine!.voice(PRIORITY.shatter, t, 3, this.spatial, gain, this.rate);
    const type = e.material.id === 'glass_tempered' ? 'tempered' : e.material.id === 'glass_laminated' ? 'laminated' : 'annealed';
    if (v) v.hold(v.t + S.shatterCascade(v, { area: e.area, type }));
  }

  private onFracture(e: FractureEvent): void {
    if (!this.ready) return;
    const now = this.engine!.now;
    if (now - this.lastFracture < 0.04) return;
    this.lastFracture = now;
    const r = this.place(e.position, 0.5);
    const gain = splToGain(receivedSpl(112 + 10 * Math.log10(Math.max(e.volume * 1000, 0.01)), r));
    const t = this.timeFor(e.time, propagationDelay(r));
    const v = this.engine!.voice(PRIORITY.impact, t, 1, this.spatial, gain, this.rate);
    if (v) v.hold(v.t + S.fractureSnap(v, { volume: e.volume }));
  }

  private onStructure(e: StructuralFailureEvent): void {
    if (!this.ready) return;
    const now = this.engine!.now;
    if (now - this.lastStructure < 0.15) return;
    this.lastStructure = now;
    const r = this.place(e.position, 0.9);
    const gain = splToGain(receivedSpl(112 + 10 * Math.log10(Math.max(e.mass, 1)), r));
    const t = this.timeFor(e.time, propagationDelay(r));
    const v = this.engine!.voice(PRIORITY.structure, t, 6, this.spatial, gain, this.rate);
    if (!v) return;
    const steel = e.cause === 'buckling' || /steel|beam|girder|çelik|kiriş|truss/i.test(e.label);
    const fallTime = Math.sqrt((2 * Math.max(0.5, e.position.y)) / G);
    v.hold(v.t + S.structuralFailure(v, { mass: e.mass, steel, fallTime }));
  }

  private onCharge(e: ChargeEvent): void {
    if (!this.ready) return;
    const r = this.place(e.position, 0.2);
    const t = this.timeFor(e.time, propagationDelay(r));
    const v = this.engine!.voice(PRIORITY.impact, t, 0.5, this.spatial, splToGain(receivedSpl(95, r)), this.rate);
    if (v) v.hold(v.t + S.chargePlaced(v));
  }

  private onScene(): void {
    this.stopLoops();
    this.recycleTracks(true);
    this.reflectPending = true;
  }

  // ─── Projectiles in flight ─────────────────────────────────────────────────────────────────

  private followProjectiles(): void {
    const L = this.listener;
    const frame = this.frame;
    const active: readonly Projectile[] = this.ctx.projectiles.active;
    for (let i = 0; i < active.length; i++) {
      const p = active[i]!;
      if (!p.alive) continue;
      let tr = this.tracks.get(p.id);
      if (!tr) {
        tr = this.trackPool.pop() ?? { id: 0, x: 0, y: 0, z: 0, own: false, cracked: false, seen: 0 };
        tr.id = p.id;
        tr.x = p.previous.x;
        tr.y = p.previous.y;
        tr.z = p.previous.z;
        // Rounds that start at the camera are the viewer's own: their crack is part of the report.
        tr.own = p.previous.distanceTo(L) < 4;
        tr.cracked = false;
        this.tracks.set(p.id, tr);
      }
      tr.seen = frame;
      const speed = p.velocity.length();
      if (!tr.own && !tr.cracked && speed > SPEED_OF_SOUND * 1.03) this.checkCrack(p, tr, speed);
      tr.x = p.position.x;
      tr.y = p.position.y;
      tr.z = p.position.z;
      this.followLoop(p, speed);
    }
    this.recycleTracks(false);
    for (const [id, loop] of this.loops) {
      if (loop.seen !== frame) {
        this.engine!.release(loop.voice, loop.kind === 'rocket' ? 0.12 : 0.25);
        this.loops.delete(id);
      }
    }
  }

  private checkCrack(p: Projectile, tr: Track, speed: number): void {
    const L = this.listener;
    closestApproach(tr.x, tr.y, tr.z, p.position.x, p.position.y, p.position.z, L.x, L.y, L.z, _ca);
    // Only once the round has passed its closest point, and close enough to matter.
    if (_ca.s <= 0 || _ca.s >= 1 || _ca.distance > 40) return;
    tr.cracked = true;
    const engine = this.engine!;
    if (engine.now - this.lastCrack < CRACK_SPACING) return;
    this.lastCrack = engine.now;
    const mach = speed / SPEED_OF_SOUND;
    const d = Math.max(_ca.distance, 0.2);
    const shock = ballisticShock(mach, p.ammo.diameter, Math.max(p.ammo.length, p.ammo.diameter), d);
    if (shock.peakPa <= 0) return;
    // Time since the closest point: distance travelled past it / speed.
    _p.set(tr.x, tr.y, tr.z).lerp(p.position, _ca.s);
    const since = _p.distanceTo(p.position) / speed;
    const t = this.timeFor(this.ctx.time.now - since, shockArrivalAfterPassing(d, mach));
    this.place(_p, 0.3);
    const v = engine.voice(PRIORITY.crack, t, 0.3, this.spatial, splToGain(splFromPressure(shock.peakPa)), this.rate);
    if (v) v.hold(v.t + S.ballisticCrack(v, { buffer: engine.bank.nwave(shock.duration) }));
  }

  private followLoop(p: Projectile, speed: number): void {
    const a = p.ammo;
    const rocket = !!a.rocket && p.burning;
    const L = this.listener;
    const dist = p.position.distanceTo(L);
    // Heavy shells and bombs coming in: audible rush within a few hundred metres.
    const rush = !a.rocket && a.mass >= 5 && speed > 120 && dist < 500;
    let loop = this.loops.get(p.id);
    if (!rocket && !rush) {
      if (loop) {
        this.engine!.release(loop.voice, 0.15);
        this.loops.delete(p.id);
      }
      return;
    }
    const engine = this.engine!;
    if (!loop) {
      if (this.loops.size >= MAX_LOOPS) return;
      this.place(p.position, 0.4);
      const t = engine.now + LOOKAHEAD;
      const v = engine.voice(PRIORITY.loop, t, 3600, this.spatial, 0, 1);
      if (!v) return;
      const handle = rocket ? S.rocketLoop(v) : S.rushLoop(v);
      // Rocket motors ≈ 150 dB at 1 m; air rushing past a shell grows with its size.
      const levelAt1m = rocket ? 150 : 128 + 10 * Math.log10(a.mass);
      loop = { id: p.id, voice: v, handle, kind: rocket ? 'rocket' : 'rush', seen: this.frame, levelAt1m };
      this.loops.set(p.id, loop);
    }
    loop.seen = this.frame;
    const r = this.place(p.position, 0.4);
    const now = engine.now;
    // Doppler from the radial speed (positive = approaching).
    _d.subVectors(L, p.position);
    const vr = r > 1e-3 ? p.velocity.dot(_d) / r : 0;
    const f = dopplerFactor(vr);
    loop.handle.tune.frequency.setTargetAtTime(clamp(loop.handle.baseFreq * f * this.rate, 40, 18000), now, 0.03);
    loop.voice.out.gain.setTargetAtTime(splToGain(receivedSpl(loop.levelAt1m, r)), now, 0.04);
    loop.voice.bus.setSpatial(this.spatial, now, 0.03);
  }

  private recycleTracks(all: boolean): void {
    for (const [id, tr] of this.tracks) {
      if (all || tr.seen !== this.frame) {
        this.tracks.delete(id);
        this.trackPool.push(tr);
      }
    }
  }

  private stopLoops(): void {
    if (this.engine) {
      for (const loop of this.loops.values()) this.engine.release(loop.voice, 0.05);
      if (this.rotary) this.engine.release(this.rotary.voice, 0.05);
    }
    this.loops.clear();
    this.rotary = null;
  }

  // ─── Reverb from the surroundings ──────────────────────────────────────────────────────────

  /**
   * Cast eight horizontal rays from the viewer's spawn point; façades that answer become discrete
   * slap-back reflections in the impulse response. Once per scene: rebuilding the convolution
   * buffer costs tens of milliseconds, too much to repeat while flying around.
   */
  private updateReflections(): void {
    const engine = this.engine;
    if (!engine) return;
    const walls: { distance: number; pan: number }[] = [];
    const o = _p.copy(this.listener);
    o.y = Math.max(o.y, 1.2);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      _d.set(Math.sin(a), 0, Math.cos(a));
      const hit = this.ctx.registry.raycast(o, _d, 200);
      walls.push({ distance: hit ? hit.distance : Infinity, pan: clamp(_d.dot(_right), -1, 1) });
    }
    engine.setReflections(reflectionsFor(walls));
  }
}

function hardness(m: MaterialProps): number {
  switch (m.id) {
    case 'granite':
      return 1.5;
    case 'marble':
    case 'onyx':
    case 'concrete_hs':
      return 1.25;
    case 'brick':
      return 0.7;
    case 'travertine':
      return 0.9;
    default:
      return 1;
  }
}

