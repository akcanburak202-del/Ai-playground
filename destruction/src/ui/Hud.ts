import * as THREE from 'three';
import type { Simulation } from '../app/Simulation.ts';
import type { BlastEvent, SceneDef, WeaponControllerApi, WeaponSpec } from '../app/contracts.ts';
import type { AmmoSpec, ImpactEvent } from '../physics/ballistics/types.ts';
import { bridgeOf, type Bridge, type HudHooks } from './bridge.ts';
import { Reticle, ScopeOverlay, reticleFor, scopeFor } from './crosshair.ts';
import { fmtDistance, fmtLength, fmtScale, fmtSpeed, num } from './format.ts';
import { CATEGORY_SHORT_TR, CATEGORY_TR, HELP_DESKTOP, HELP_TOUCH, NAME_TR, ROLE_TR, caliberTr, keyHints, upperTr } from './i18n.ts';
import { Menu } from './menu.ts';
import { ensureFonts, ensureStyle } from './theme.ts';
import { HitGroups, ammoLine, blastRow, followThrough, groupLine, impactRow, weaponSpecs, weaponSummary, type ImpactRow } from './telemetry.ts';
import { buildSlots, slotOf, weaponForKey, type Slot } from '../player/slots.ts';
import { closestApproach } from '../audio/acoustics.ts';

export interface HudOptions {
  scenes: SceneDef[];
  onSelectScene(id: string): void | Promise<void>;
  container?: HTMLElement;
  /** Show the scene menu at install (default true) */
  startWithMenu?: boolean;
  /** Pause the simulation while the menu is open (default true) */
  pauseOnMenu?: boolean;
}

/** Telemetry rows kept: the newest (large) and the older ones under it (one line each, fading) */
const ROWS = 4;
/** The weapon list shows this long after a weapon change, ms */
const STRIP_MS = 2400;
/** The key hints show this long after play starts, ms */
const HINTS_MS = 14000;
/** Telemetry steps back after this long without a hit or blast, ms */
const IDLE_MS = 9000;
/** 1 MOA in radians */
const MOA = Math.PI / (180 * 60);
/** Depth-chart viewBox of the hit group */
const SPARK_W = 240;
const SPARK_H = 28;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

let reducedMq: MediaQueryList | null = null;
const _fwd = new THREE.Vector3();
const _ca = { s: 0, distance: 0 };

const REDUCED_MOTION = (): boolean => (reducedMq ??= matchMedia('(prefers-reduced-motion: reduce)')).matches;

/** Write text only when it changed (DOM writes are the HUD's main cost). */
function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

/**
 * Resolve after the next two animation frames (or 150 ms in a hidden tab), so that a loading
 * indicator paints before a scene build, which is synchronous work, blocks the page.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 150);
  });
}

function show(e: HTMLElement, on: boolean): void {
  const d = on ? '' : 'none';
  if (e.style.display !== d) e.style.display = d;
}

interface OlderRow {
  root: HTMLDivElement;
  ammo: HTMLSpanElement;
  mat: HTMLSpanElement;
  depth: HTMLSpanElement;
  cnt: HTMLSpanElement;
  tag: HTMLSpanElement;
}

interface SlotEls {
  root: HTMLDivElement;
  name: HTMLSpanElement;
  count: HTMLSpanElement;
  /** The slot's weapons, listed while it is the current one */
  subs: HTMLDivElement;
  subEls: Map<string, HTMLDivElement>;
}

/**
 * Heads-up display. The view is the product, so the play HUD stays small: a collapsed weapon card
 * (name, round, the numbers that define it) with the full specification on hold of I, a weapon
 * list that shows up on a weapon change, telemetry that leads with the newest impact and lets the
 * older ones fade, a key-hint line for the first seconds of play, weapon-specific reticles, help,
 * toasts, a loading chip and the scene menu. Everything is DOM over the canvas; per-frame work
 * only touches nodes whose text actually changed.
 */
export class Hud implements HudHooks {
  readonly root: HTMLDivElement;
  private readonly sim: Simulation;
  private readonly weapons: WeaponControllerApi;
  private readonly opts: HudOptions;
  private readonly bridge: Bridge;
  private readonly slots: Slot[];
  private readonly menu: Menu;
  private readonly reticle: Reticle;
  private readonly scope: ScopeOverlay;
  private unsub: (() => void)[] = [];

  // Header
  private sceneName!: HTMLSpanElement;
  private fpsEl!: HTMLSpanElement;
  private scaleEl!: HTMLSpanElement;
  private slowTag!: HTMLSpanElement;
  private bodiesEl!: HTMLSpanElement;
  private projEl!: HTMLSpanElement;
  private timeEl!: HTMLSpanElement;
  private muteEl!: HTMLSpanElement;
  // Telemetry
  private tele!: HTMLDivElement;
  private emptyEl!: HTMLDivElement;
  private latest!: HTMLDivElement;
  private lAmmo!: HTMLSpanElement;
  private lMat!: HTMLSpanElement;
  private lCnt!: HTMLSpanElement;
  private lTag!: HTMLSpanElement;
  private lFollow!: HTMLSpanElement;
  private lDepth!: HTMLElement;
  private lVals: HTMLSpanElement[] = [];
  private sumTr!: HTMLDivElement;
  private sumModel!: HTMLDivElement;
  private older: OlderRow[] = [];
  private olderBox!: HTMLDivElement;
  private groupEl!: HTMLDivElement;
  private groupHead!: HTMLSpanElement;
  private groupDepth!: HTMLSpanElement;
  private groupNote!: HTMLDivElement;
  private groupBand!: HTMLDivElement;
  private groupSvg!: SVGSVGElement;
  private readonly groups = new HitGroups();
  private blastBox!: HTMLDivElement;
  private blastVals: HTMLSpanElement[] = [];
  private blastNote!: HTMLDivElement;
  private blastTitle!: HTMLSpanElement;
  // Weapon card and list (docked bottom-left)
  private dock!: HTMLDivElement;
  private card!: HTMLDivElement;
  private slotCaps = new Map<number, HTMLSpanElement>();
  private cardCat!: HTMLSpanElement;
  private firedEl!: HTMLSpanElement;
  private wName!: HTMLDivElement;
  private ammoChip!: HTMLSpanElement;
  private ammoKey!: HTMLSpanElement;
  private sumLine!: HTMLSpanElement;
  private coolBar!: HTMLElement;
  private coolLbl!: HTMLSpanElement;
  private wRole!: HTMLDivElement;
  private dimLabel!: HTMLSpanElement;
  private pills!: HTMLDivElement;
  private ammoLineEl!: HTMLDivElement;
  private specs!: HTMLDivElement;
  private chargesEl!: HTMLDivElement;
  private strip!: HTMLDivElement;
  private slotEls = new Map<number, SlotEls>();
  // Overlays
  private keysEl!: HTMLDivElement;
  private readout!: HTMLDivElement;
  private rangeEl!: HTMLSpanElement;
  private rangeLbl!: HTMLSpanElement;
  private spreadLine!: HTMLDivElement;
  private spreadEl!: HTMLSpanElement;
  private banner!: HTMLDivElement;
  private bannerText!: HTMLSpanElement;
  private bannerAmmo!: HTMLSpanElement;
  private bannerNum!: HTMLSpanElement;
  private toastEl!: HTMLDivElement;
  private toastTimer = 0;
  private lockHint!: HTMLDivElement;
  private loadingEl!: HTMLDivElement;
  private loadingText!: HTMLSpanElement;
  private frameEl!: HTMLDivElement;
  private help!: HTMLDivElement;

  private impacts: ImpactRow[] = [];
  private impactsDirty = false;
  private fragmentHits = 0;
  private lastBlast: { e: BlastEvent; wall: number } | null = null;
  private blastDirty = false;
  private lastWeapon: WeaponSpec | null = null;
  private lastAmmo: AmmoSpec | null = null;
  private lastFired = -1;
  private lastCharges = -1;
  private coolMax = 0;
  private fps = 60;
  private statTimer = 0;
  private lastHitFlash = 0;
  private lastRender = 0;
  private lastScale = -1;
  private hudVisible = true;
  /**
   * The HUD's own clock, ms: rendered time (each frame counts at most 250 ms), so a stall (shader
   * compiles after a load, a hidden tab) does not use up the hints or the weapon list.
   */
  private clock = 0;
  /** HUD-clock ms of the latest impact or blast (telemetry idles after IDLE_MS) */
  private lastActivity = 0;
  private idle = false;
  /** Weapon list visible until (HUD clock, ms) */
  private stripUntil = 0;
  /** Key hints visible until (HUD clock, ms) */
  private hintsUntil = 0;
  private hintsKey = '';
  private played = false;
  /** Detail (full weapon card): I held, or toggled by a tap on touch screens */
  private detailHeld = false;
  private detailTouch = false;
  private detailOn = false;
  private loadingLabel: string | null = null;
  lite = false;
  /** Seconds of sustained slow frames (auto lite) */
  private slowFor = 0;
  private scoped = false;
  private layoutDirty = true;
  private vw = 1280;
  private vh = 720;
  private canvasH = 720;
  /** Wall-clock ms of the HUD's own per-frame work (exponential average) */
  frameMs = 0;

  constructor(sim: Simulation, weapons: WeaponControllerApi, opts: HudOptions) {
    this.sim = sim;
    this.weapons = weapons;
    this.opts = opts;
    this.bridge = bridgeOf(sim);
    this.bridge.weapons ??= weapons;
    this.slots = buildSlots(weapons.weapons);
    ensureStyle();
    ensureFonts();
    this.root = el('div', 'dx-root dx-hud');
    this.root.lang = 'tr';
    this.buildHeader();
    this.buildTelemetry();
    this.buildDock();
    this.reticle = new Reticle(this.root);
    this.buildReadout();
    this.scope = new ScopeOverlay(this.root);
    this.root.insertBefore(this.scope.el, this.root.firstChild);
    this.buildOverlays();
    this.buildHelp();
    this.menu = new Menu(this.root, opts.scenes, {
      onStart: (id) => this.start(id),
      onHelp: () => this.toggleHelp(),
      onMute: () => this.toggleMute(),
    });
    (opts.container ?? document.body).appendChild(this.root);

    const ev = sim.ctx.events;
    this.unsub.push(
      ev.on('impact', (e) => this.onImpact(e)),
      ev.on('blast', (e) => {
        this.lastBlast = { e, wall: this.clock };
        this.lastActivity = this.clock;
        this.fragmentHits = 0;
        this.blastDirty = true;
      }),
      ev.on('sceneLoaded', () => this.onScene()),
      ev.on('chargePlaced', () => (this.lastCharges = -1)),
      ev.on('chargeRemoved', () => (this.lastCharges = -1)),
      sim.onFrame((dt) => this.frame(dt)),
    );
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyI') this.detailHeld = false;
    };
    // Nothing stays held when the window loses focus or the tab is hidden.
    const onBlur = () => (this.detailHeld = false);
    const onVisibility = () => {
      if (document.hidden) this.detailHeld = false;
    };
    const onResize = () => {
      this.layoutDirty = true;
      this.measure();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    this.unsub.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
    });
    this.bridge.hud = this;
    this.measure();
    this.onScene();
    this.showMenu(opts.startWithMenu ?? true);
  }

  /**
   * Viewport and canvas size, read once per resize: reading layout in the per-frame path after
   * the frame's text writes would force a synchronous reflow every frame.
   */
  private measure(): void {
    this.vw = this.root.clientWidth || window.innerWidth;
    this.vh = this.root.clientHeight || window.innerHeight;
    this.canvasH = this.sim.ctx.renderer.domElement.clientHeight || this.vh;
  }

  // ─── HudHooks ──────────────────────────────────────────────────────────────────────────────

  get menuOpen(): boolean {
    return this.menu.visible;
  }

  get helpOpen(): boolean {
    return this.help.classList.contains('dx-show');
  }

  showMenu(show: boolean): void {
    this.menu.show(show);
    this.root.classList.toggle('dx-menu-open', show);
    if (show) {
      this.help.classList.remove('dx-show');
      this.weapons.setTrigger(false);
      this.detailHeld = false;
      if (document.pointerLockElement) document.exitPointerLock();
      this.menu.setMuted(this.sim.ctx.audio.muted);
    } else if (this.sim.currentScene) this.introduceKeys();
    if (this.opts.pauseOnMenu ?? true) this.sim.paused = show;
  }

  /** First time in play (menu closed over a built scene): the key hints introduce the controls. */
  private introduceKeys(): void {
    if (this.played) return;
    this.played = true;
    this.hintsUntil = this.clock + HINTS_MS;
  }

  toggleHelp(): void {
    this.help.classList.toggle('dx-show');
  }

  reload(): void {
    const id = this.sim.currentScene?.id;
    if (!id) return;
    const def = this.opts.scenes.find((s) => s.id === id);
    this.setLoading(def?.nameTr ?? def?.name ?? '');
    show(this.loadingEl, !this.menu.visible);
    void nextPaint()
      .then(() => this.load(id))
      .catch((err) => {
        console.error('scene reload failed', err);
        this.toast('Sahne kurulamadı', true);
      })
      .finally(() => this.setLoading(null));
  }

  toast(text: string, accent = false): void {
    setText(this.toastEl, upperTr(text));
    this.toastEl.classList.toggle('dx-accent', accent);
    this.toastEl.classList.add('dx-show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('dx-show'), 1500);
  }

  /** Hide / show the in-play HUD (menu and help stay available; the reticle stays). */
  setVisible(v: boolean): void {
    this.hudVisible = v;
    this.root.classList.toggle('dx-clean', !v);
    this.layoutDirty = true;
  }

  toggleHud(): void {
    this.setVisible(!this.hudVisible);
  }

  /**
   * Lite panels: solid smoked glass without the backdrop blur. The blur is recomputed by the
   * compositor every frame over the moving 3D view, the HUD's one real rendering cost; the app
   * can switch it off for its low quality level, and the HUD does so itself (once) when frames
   * stay slower than 40 fps for a few seconds.
   */
  setLite(on: boolean): void {
    this.lite = on;
    this.root.classList.toggle('dx-lite', on);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    clearTimeout(this.toastTimer);
    this.reticle.dispose();
    this.scope.dispose();
    this.menu.dispose();
    this.root.remove();
    if (this.bridge.hud === this) this.bridge.hud = null;
    if (this.bridge.weapons === this.weapons && !this.bridge.player) this.bridge.weapons = null;
    if (this.opts.pauseOnMenu ?? true) this.sim.paused = false;
  }

  // ─── Construction ──────────────────────────────────────────────────────────────────────────

  private buildHeader(): void {
    const top = el('div', 'dx-top', undefined, this.root);
    el('span', 'dx-brand', 'Destruction', top).lang = 'en';
    el('span', 'dx-sep dx-hide-s', undefined, top);
    this.sceneName = el('span', 'dx-scene dx-hide-s', '', top);
    el('span', 'dx-grow', undefined, top);
    this.slowTag = el('span', 'dx-slowmo-tag', '', top);
    const stat = (label: string, cls = '') => {
      const s = el('span', `dx-stat ${cls}`, undefined, top);
      el('span', 'dx-lbl', label, s);
      return el('span', 'dx-num', '—', s);
    };
    this.scaleEl = stat('Zaman');
    this.fpsEl = stat('FPS');
    this.bodiesEl = stat('Gövde', 'dx-hide-s');
    this.projEl = stat('Mermi', 'dx-hide-s');
    this.timeEl = stat('Süre', 'dx-hide-s');
    this.muteEl = el('span', 'dx-lbl', '', top);
    el('div', 'dx-ruler', undefined, this.root);
  }

  private buildTelemetry(): void {
    const p = el('div', 'dx-panel dx-tele', undefined, this.root);
    this.tele = p;
    const head = el('div', 'dx-tele-head', undefined, p);
    el('span', 'dx-title', 'Telemetri', head);
    el('span', 'dx-lbl', 'Son isabet', head);
    this.emptyEl = el('div', 'dx-empty', 'Bir yüzeye ateş et: çarpma hızı, açı, nüfuz, kalıntı hız ve soğurulan enerji burada belirir.', p);

    // The newest impact, large.
    this.latest = el('div', 'dx-latest', undefined, p);
    const l1 = el('div', 'dx-row-1', undefined, this.latest);
    this.lAmmo = el('span', 'dx-ammo', '', l1);
    this.lMat = el('span', 'dx-mat', '', l1);
    this.lCnt = el('span', 'dx-cnt dx-num', '', l1);
    this.lTag = el('span', 'dx-tag', '', l1);
    this.lFollow = el('span', 'dx-follow', '', this.latest);
    const big = el('div', 'dx-big', undefined, this.latest);
    const depth = el('div', 'dx-depth', undefined, big);
    el('span', 'dx-lbl', 'Nüfuz', depth);
    this.lDepth = el('b', undefined, '', depth);
    const vals = el('div', 'dx-vals', undefined, big);
    for (const label of ['Çarpma', 'Açı', 'Kalıntı', 'Enerji']) {
      const d = el('div', undefined, undefined, vals);
      el('span', 'dx-lbl', label, d);
      this.lVals.push(el('span', 'dx-num', '', d));
    }
    this.sumTr = el('div', 'dx-tr', '', this.latest);
    this.groupEl = el('div', 'dx-group', undefined, this.latest);
    const gh = el('div', 'dx-group-head', undefined, this.groupEl);
    this.groupHead = el('span', 'dx-lbl', '', gh);
    this.groupDepth = el('span', 'dx-num', '', gh);
    // Section through the spot: hatched material, the cavity cut into it (SVG), the back face.
    const sec = el('div', 'dx-section', undefined, this.groupEl);
    this.groupBand = el('div', 'dx-band', undefined, sec);
    this.groupSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.groupSvg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
    this.groupSvg.setAttribute('preserveAspectRatio', 'none');
    sec.appendChild(this.groupSvg);
    this.groupNote = el('div', 'dx-group-note', '', this.groupEl);
    this.groupEl.style.display = 'none';
    this.sumModel = el('div', 'dx-model', '', this.latest);
    this.latest.style.display = 'none';

    // Older results, one line each, fading with age.
    this.olderBox = el('div', 'dx-older', undefined, p);
    for (let i = 1; i < ROWS; i++) {
      const root = el('div', 'dx-orow', undefined, this.olderBox);
      const ammo = el('span', 'dx-ammo', '', root);
      const mat = el('span', 'dx-mat', '', root);
      const depthEl = el('span', 'dx-num', '', root);
      const cnt = el('span', 'dx-cnt dx-num', '', root);
      const tag = el('span', 'dx-tag', '', root);
      root.style.display = 'none';
      this.older.push({ root, ammo, mat, depth: depthEl, cnt, tag });
    }
    this.olderBox.style.display = 'none';

    this.blastBox = el('div', 'dx-blast', undefined, p);
    const bh = el('div', 'dx-tele-head', undefined, this.blastBox);
    el('span', 'dx-title', 'Patlama · kamerada', bh);
    this.blastTitle = el('span', 'dx-lbl', '', bh);
    const grid = el('div', 'dx-blast-grid', undefined, this.blastBox);
    for (const l of ['TNT-e', 'Mesafe', 'Aşırı basınç', 'Varış', 'Ses düzeyi']) {
      const c = el('div', undefined, undefined, grid);
      el('span', 'dx-lbl', l, c);
      this.blastVals.push(el('span', 'dx-v', '', c));
    }
    this.blastNote = el('div', 'dx-note', '', this.blastBox);
    this.blastBox.style.display = 'none';
  }

  private buildDock(): void {
    this.dock = el('div', 'dx-dock', undefined, this.root);
    this.buildStrip();
    this.buildCard();
  }

  private buildCard(): void {
    const c = el('div', 'dx-panel dx-card', undefined, this.dock);
    this.card = c;
    c.title = 'Ayrıntı: I tuşunu basılı tut';
    // Touch screens: a tap on the card opens / closes the full specification.
    c.addEventListener('click', () => {
      if (!this.bridge.player?.touch) return;
      this.detailTouch = !this.detailTouch;
    });
    const head = el('div', 'dx-card-head', undefined, c);
    const caps = el('span', 'dx-slotcaps', undefined, head);
    for (const s of this.slots) {
      const cap = el('span', 'dx-key', String(s.key), caps);
      cap.title = CATEGORY_TR[s.category] ?? s.category;
      // Touch screens: the group numbers are buttons (a second tap steps through the group).
      cap.addEventListener('click', (e) => {
        if (!this.bridge.player?.touch) return;
        e.stopPropagation();
        const id = weaponForKey(this.slots, s.key, this.weapons.current.id);
        if (id && id !== this.weapons.current.id) {
          this.weapons.setTrigger(false);
          this.weapons.select(id);
        }
      });
      this.slotCaps.set(s.key, cap);
    }
    this.cardCat = el('span', 'dx-cat', '', head);

    const main = el('div', 'dx-card-main', undefined, c);
    this.wName = el('div', 'dx-wname', '', main);
    const ammo = el('span', 'dx-card-ammo', undefined, main);
    this.ammoChip = el('span', 'dx-pill dx-on', '', ammo);
    this.ammoChip.lang = 'en';
    this.ammoKey = el('span', 'dx-key', 'T', ammo);
    this.ammoKey.title = 'Mühimmat değiştir';

    const sum = el('div', 'dx-card-sum', undefined, c);
    this.sumLine = el('span', 'dx-sumline', '', sum);
    this.coolLbl = el('span', 'dx-num', 'Hazır', sum);
    const line = el('div', 'dx-coolline', undefined, c);
    this.coolBar = el('b', undefined, undefined, line);
    this.chargesEl = el('div', 'dx-charges', '', c);

    // Full specification (I held, help open, or a tap on touch screens).
    const more = el('div', 'dx-card-more', undefined, c);
    const roleLine = el('div', 'dx-card-top', undefined, more);
    this.wRole = el('div', 'dx-role', '', roleLine);
    const fired = el('span', 'dx-stat', undefined, roleLine);
    el('span', 'dx-lbl', 'Atılan', fired);
    this.firedEl = el('span', 'dx-num dx-live', '0', fired);
    const dim = el('div', 'dx-dimline', undefined, more);
    el('i', undefined, undefined, dim);
    this.dimLabel = el('span', undefined, '', dim);
    el('i', undefined, undefined, dim);
    const ammoHead = el('div', 'dx-card-top', undefined, more);
    el('span', 'dx-lbl', 'Mühimmat', ammoHead);
    el('span', 'dx-lbl dx-hide-s', 'T · değiştir', ammoHead);
    this.pills = el('div', 'dx-ammo-pills', undefined, more);
    this.ammoLineEl = el('div', 'dx-ammo-line', '', more);
    this.specs = el('div', 'dx-specs', undefined, more);
  }

  private buildStrip(): void {
    this.strip = el('div', 'dx-panel dx-strip', undefined, this.dock);
    for (const s of this.slots) {
      const root = el('div', 'dx-slot', undefined, this.strip);
      el('span', 'dx-key', String(s.key), root);
      el('span', 'dx-lbl', CATEGORY_SHORT_TR[s.category] ?? s.category, root);
      const name = el('span', 'dx-sname', NAME_TR[s.weapons[0]!.id] ?? s.weapons[0]!.name, root);
      const count = el('span', 'dx-count', s.weapons.length > 1 ? `${s.weapons.length}` : '', root);
      const subs = el('div', 'dx-subs', undefined, this.strip);
      const subEls = new Map<string, HTMLDivElement>();
      if (s.weapons.length > 1) for (const w of s.weapons) subEls.set(w.id, el('div', 'dx-sub', NAME_TR[w.id] ?? w.name, subs));
      subs.style.display = 'none';
      this.slotEls.set(s.key, { root, name, count, subs, subEls });
    }
    const foot = el('div', 'dx-strip-foot', undefined, this.strip);
    foot.textContent = 'Aynı tuş: gruptaki sıradaki · tekerlek: tümü';
  }

  private buildReadout(): void {
    this.readout = el('div', 'dx-readout', undefined, this.root);
    const l1 = el('div', undefined, undefined, this.readout);
    this.rangeLbl = el('span', 'dx-lbl', 'Mesafe', l1);
    this.rangeEl = el('span', undefined, '—', l1);
    this.spreadLine = el('div', undefined, undefined, this.readout);
    el('span', 'dx-lbl', 'Ø95 %', this.spreadLine);
    this.spreadEl = el('span', undefined, '', this.spreadLine);
  }

  private buildOverlays(): void {
    this.frameEl = el('div', 'dx-frame', undefined, this.root);
    for (let i = 0; i < 4; i++) el('i', undefined, undefined, this.frameEl);
    this.keysEl = el('div', 'dx-keys', undefined, this.root);
    this.keysEl.style.display = 'none';
    this.banner = el('div', 'dx-panel dx-banner', undefined, this.root);
    this.bannerText = el('span', undefined, '', this.banner);
    this.bannerAmmo = el('span', undefined, '', this.banner);
    this.bannerAmmo.lang = 'en';
    this.bannerNum = el('span', 'dx-num', '', this.banner);
    this.banner.style.display = 'none';
    this.toastEl = el('div', 'dx-panel dx-toast', '', this.root);
    this.lockHint = el('div', 'dx-panel dx-lockhint', 'Tıkla · fare kilidi', this.root);
    this.lockHint.style.display = 'none';
    this.loadingEl = el('div', 'dx-panel dx-loading', undefined, this.root);
    this.loadingText = el('span', undefined, '', this.loadingEl);
    el('i', 'dx-sweep', undefined, this.loadingEl);
    this.loadingEl.style.display = 'none';
  }

  private buildHelp(): void {
    this.help = el('div', 'dx-panel dx-help', undefined, this.root);
    const head = el('div', 'dx-help-head', undefined, this.help);
    el('h2', undefined, 'Kontroller', head);
    const close = el('button', 'dx-btn', 'Kapat', head);
    close.type = 'button';
    close.addEventListener('click', () => this.help.classList.remove('dx-show'));
    const cols = el('div', 'dx-help-cols dx-help-desk', undefined, this.help);
    for (const group of HELP_DESKTOP) {
      const col = el('div', 'dx-help-col', undefined, cols);
      el('span', 'dx-lbl', group.title, col);
      for (const e of group.entries) this.helpRow(col, e.keys, e.label);
    }
    const touch = el('div', 'dx-help-cols dx-help-touch', undefined, this.help);
    const tcol = el('div', 'dx-help-col', undefined, touch);
    el('span', 'dx-lbl', 'Dokunmatik', tcol);
    for (const e of HELP_TOUCH) this.helpRow(tcol, e.keys, e.label);
    el('div', 'dx-help-foot', 'Her isabet terminal balistik modelleriyle çözülür (NDRC, Lambert–Jonas, Lanz–Odermatt, Kingery–Bulmash). Telemetrideki sayılar modelin sonucudur; gösteri için ayarlanmış değerler değildir.', this.help);
  }

  private helpRow(parent: HTMLElement, keys: string[], label: string): void {
    const row = el('div', 'dx-help-row', undefined, parent);
    el('span', undefined, label, row);
    const caps = el('div', 'dx-caps', undefined, row);
    for (const k of keys) el('span', 'dx-cap', k, caps);
  }

  // ─── Events ────────────────────────────────────────────────────────────────────────────────

  private start(id: string): void {
    const audio = this.sim.ctx.audio;
    audio.unlock();
    const p = this.bridge.player;
    if (p) p.requestLock();
    else if (!matchMedia('(pointer: coarse)').matches) {
      const r = this.sim.ctx.renderer.domElement.requestPointerLock?.() as Promise<void> | undefined;
      r?.catch?.(() => {});
    }
    const current = this.sim.currentScene?.id;
    if (!id || id === current) {
      this.showMenu(false);
      return;
    }
    const def = this.opts.scenes.find((s) => s.id === id);
    this.menu.setLoading(true, def?.nameTr ?? def?.name);
    void nextPaint().then(() => this.load(id)).then(
      () => {
        this.menu.setLoading(false);
        this.showMenu(false);
      },
      (err) => {
        // Stay on the sheet: dropping the viewer into a half-built world helps nobody.
        console.error('scene load failed', err);
        this.menu.setLoading(false);
        if (document.pointerLockElement) document.exitPointerLock();
        this.toast('Sahne kurulamadı', true);
      },
    );
  }

  /** Scene loader call that also turns a synchronous throw into a rejection. */
  private load(id: string): Promise<void> {
    return new Promise<void>((resolve) => resolve(this.opts.onSelectScene(id)));
  }

  private setLoading(label: string | null): void {
    this.loadingLabel = label;
    if (label !== null) setText(this.loadingText, upperTr(label ? `${label} kuruluyor` : 'Sahne kuruluyor'));
  }

  private toggleMute(): void {
    const a = this.sim.ctx.audio;
    a.unlock();
    a.setMuted(!a.muted);
    this.menu.setMuted(a.muted);
  }

  private onKey(e: KeyboardEvent): void {
    // Already handled by the player controls (they run first and mark what they consumed).
    if (e.defaultPrevented) return;
    if (this.help.classList.contains('dx-show') && (e.code === 'Escape' || (this.menu.visible && e.code === 'KeyH'))) {
      this.help.classList.remove('dx-show');
      e.preventDefault();
      return;
    }
    if (!this.menu.visible) {
      if (e.code === 'KeyI' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.detailHeld = true;
        return;
      }
      // Without player controls installed, Esc still opens the menu.
      if (!this.bridge.player && e.code === 'Escape') {
        this.showMenu(true);
        e.preventDefault();
      }
      return;
    }
    if (e.code === 'KeyH') {
      this.toggleHelp();
      e.preventDefault();
    } else if (e.code === 'KeyM') {
      this.toggleMute();
      e.preventDefault();
    } else if (e.code === 'Escape' && this.sim.currentScene) {
      this.start(this.sim.currentScene.id);
      e.preventDefault();
    } else if (this.menu.key(e.code)) {
      e.preventDefault();
    }
  }

  private onImpact(e: ImpactEvent): void {
    this.lastActivity = this.clock;
    if (e.agent === 'fragment') {
      this.fragmentHits++;
      this.blastDirty = true;
      return;
    }
    // Rows are the latest distinct results: a burst on concrete is one row (×60) with the newest
    // numbers. A round that has already gone through something lands behind the target (the
    // ground beyond a holed wall): its row goes in under the top one and it does not count as a
    // hit on a spot, so the top row, the description and the spot readout stay with what the
    // viewer is shooting at.
    const secondary = followThrough(e) ?? this.flewThrough(e);
    if (!secondary) {
      // A dispersed weapon's burst is still one spot: its 95 % group radius (2.45 σ) at this range.
      const sigma = this.weapons.current.dispersionMOA * MOA;
      const cam = this.sim.ctx.camera;
      const g = this.groups.add(e, 2.45 * sigma * e.point.distanceTo(cam.position));
      cam.getWorldDirection(_fwd);
      this.groups.select(e.time, cam.position, _fwd, g);
    }
    const row = impactRow(e, secondary);
    const i = this.impacts.findIndex((r) => r.key === row.key);
    if (i >= 0) {
      row.count = this.impacts[i]!.count + 1;
      this.impacts.splice(i, 1);
    }
    this.impacts.splice(secondary && this.impacts.length ? 1 : 0, 0, row);
    if (this.impacts.length > ROWS) this.impacts.length = ROWS;
    this.impactsDirty = true;
    const now = performance.now();
    if (e.agent === 'projectile' && !secondary && now - this.lastHitFlash > 60) {
      this.lastHitFlash = now;
      this.reticle.flashHit();
    }
  }

  /**
   * Fallback when the resolver does not report `priorPerforations`: did the round behind this
   * impact already go through something? The projectile is still in flight when its impact is
   * reported, with its perforation count not yet raised for this one, and the point lies on the
   * segment it flew this step.
   */
  private flewThrough(e: ImpactEvent): boolean {
    if (e.agent !== 'projectile') return false;
    for (const p of this.sim.ctx.projectiles.active) {
      if (p.perforations === 0 || p.ammo !== e.ammo) continue;
      if (e.projectileId !== undefined && p.id !== e.projectileId) continue;
      const a = p.previous, b = p.position, q = e.point;
      closestApproach(a.x, a.y, a.z, b.x, b.y, b.z, q.x, q.y, q.z, _ca);
      if (_ca.distance < 0.25) return true;
    }
    return false;
  }

  private onScene(): void {
    setText(this.sceneName, this.sim.currentScene?.nameTr ?? '');
    this.impacts = [];
    this.groups.reset();
    this.impactsDirty = true;
    this.lastBlast = null;
    this.blastDirty = true;
    this.lastFired = -1;
    this.lastCharges = -1;
    const id = this.sim.currentScene?.id ?? null;
    this.menu.setCurrent(this.opts.scenes.some((s) => s.id === id) ? id : null);
    if (id && !this.menu.visible) this.introduceKeys();
  }

  // ─── Per frame ─────────────────────────────────────────────────────────────────────────────

  private frame(realDt: number): void {
    const t0 = performance.now();
    const ctx = this.sim.ctx;
    if (realDt > 0) this.clock += Math.min(realDt, 0.25) * 1000;
    if (realDt > 0 && realDt < 1) {
      this.fps += (1 / realDt - this.fps) * Math.min(1, realDt * 3);
      // Not while the menu is up (paused, and the sheet has its own blur) or the tab stutters once.
      if (!this.lite && !this.menu.visible) {
        this.slowFor = realDt > 1 / 40 ? this.slowFor + realDt : Math.max(0, this.slowFor - 2 * realDt);
        if (this.slowFor > 4) this.setLite(true);
      }
    }
    this.statTimer -= realDt;
    const scale = ctx.time.scale;
    if (this.statTimer <= 0 || Math.abs(scale - this.lastScale) > 1e-3) {
      this.statTimer = 0.25;
      this.lastScale = scale;
      setText(this.fpsEl, num(this.fps, 0));
      setText(this.scaleEl, fmtScale(scale));
      this.scaleEl.classList.toggle('dx-live', scale < 0.999);
      setText(this.slowTag, scale < 0.999 ? 'Ağır çekim' : '');
      setText(this.bodiesEl, num(ctx.physics.dynamicCount, 0));
      setText(this.projEl, num(ctx.projectiles.active.length, 0));
      setText(this.timeEl, `${num(ctx.time.now, 1)} s`);
      setText(this.muteEl, ctx.audio.muted ? 'Ses kapalı' : '');
      this.frameEl.classList.toggle('dx-show', scale < 0.999);
    }
    const nowMs = this.clock;
    this.updateDetail(nowMs);
    this.updateWeapon(nowMs);
    // Telemetry at most ~20 Hz under a GAU-8 burst.
    const wall = performance.now();
    if ((this.impactsDirty || this.blastDirty) && wall - this.lastRender > 50) {
      this.lastRender = wall;
      if (this.impactsDirty) this.renderImpacts();
      if (this.blastDirty) this.renderBlast();
    }
    if (this.lastBlast && nowMs - this.lastBlast.wall > 14000) {
      this.lastBlast = null;
      this.blastDirty = true;
    }
    const idle = nowMs - this.lastActivity > IDLE_MS && !this.detailOn;
    if (idle !== this.idle) {
      this.idle = idle;
      this.tele.classList.toggle('dx-idle', idle);
    }
    this.updateReticle();
    this.updateOverlays(nowMs);
    this.frameMs += (performance.now() - t0 - this.frameMs) * 0.05;
  }

  /** Full weapon card while I is held, or (touch screens) after a tap on the card. */
  private updateDetail(nowMs: number): void {
    const on = !this.menu.visible && (this.detailHeld || this.detailTouch);
    if (on === this.detailOn) return;
    this.detailOn = on;
    this.card.classList.toggle('dx-detail', on);
    this.root.classList.toggle('dx-detailed', on);
    if (!on) this.stripUntil = Math.min(this.stripUntil, nowMs);
    this.layoutDirty = true;
  }

  private updateWeapon(nowMs: number): void {
    const w = this.weapons.current;
    const a = this.weapons.currentAmmo;
    if (w !== this.lastWeapon || a !== this.lastAmmo) {
      const weaponChanged = w !== this.lastWeapon;
      // The list shows up on a change of weapon (not at start, not on an ammunition change).
      if (weaponChanged && this.lastWeapon) this.stripUntil = nowMs + STRIP_MS;
      this.lastWeapon = w;
      this.lastAmmo = a;
      this.renderCard(w, a, weaponChanged);
    }
    const stripOn = !this.menu.visible && (nowMs < this.stripUntil || this.detailOn);
    if (stripOn !== this.strip.classList.contains('dx-show')) this.strip.classList.toggle('dx-show', stripOn);
    const fired = this.weapons.roundsFired;
    if (fired !== this.lastFired) {
      this.lastFired = fired;
      setText(this.firedEl, num(fired, 0));
    }
    const cd = this.weapons.cooldown;
    if (cd > this.coolMax + 1e-3) this.coolMax = cd;
    if (cd <= 0) this.coolMax = 0;
    const frac = this.coolMax > 0 ? cd / this.coolMax : 0;
    const width = `${Math.round((1 - frac) * 100)}%`;
    if (this.coolBar.style.width !== width) this.coolBar.style.width = width;
    setText(this.coolLbl, cd > 0.05 ? `${num(cd, 1)} s` : 'Hazır');
    this.coolLbl.classList.toggle('dx-live', cd <= 0.05);
    const n = this.weapons.charges.length;
    if (n !== this.lastCharges) {
      this.lastCharges = n;
      const placed = w.delivery === 'placed' || n > 0;
      this.chargesEl.style.display = placed ? '' : 'none';
      this.chargesEl.replaceChildren();
      if (placed) {
        this.chargesEl.append('Yerleştirilen şarj ');
        el('b', undefined, String(n), this.chargesEl);
        this.chargesEl.append(n > 0 ? ' · X: hepsi birden · B: sırayla' : ' · sol tık: yüzeye yerleştir');
      }
      this.hintsKey = '';
      this.layoutDirty = true;
    }
    if (this.layoutDirty) {
      this.layoutDirty = false;
      this.layout();
    }
  }

  /** On narrow screens the weapon card sits along the top and the telemetry stacks under it. */
  private layout(): void {
    const narrow = matchMedia('(max-width: 760px)').matches;
    const top = narrow ? `${this.dock.offsetTop + this.dock.offsetHeight + 8}px` : '';
    if (this.tele.style.top !== top) this.tele.style.top = top;
  }

  private renderCard(w: WeaponSpec, a: AmmoSpec, weaponChanged: boolean): void {
    const slot = slotOf(this.slots, w.id);
    setText(this.cardCat, caliberTr(a.caliber));
    for (const [key, cap] of this.slotCaps) cap.classList.toggle('dx-on', slot?.key === key);
    const trName = NAME_TR[w.id];
    setText(this.wName, trName ?? w.name);
    // Model designations are English words: keep the Turkish dotted İ out of their capitals.
    this.wName.lang = trName ? 'tr' : 'en';
    setText(this.ammoChip, a.name);
    show(this.ammoKey, w.ammo.length > 1);
    // Values keep their units on the same line: the line breaks only between them.
    setText(this.sumLine, weaponSummary(w, a).replace(/(?<! ·) (?!· )/g, '\u00a0'));
    const inSlot = slot && slot.weapons.length > 1 ? ` · grupta ${slot.weapons.findIndex((x) => x.id === w.id) + 1}/${slot.weapons.length}` : '';
    setText(this.wRole, `${CATEGORY_TR[w.category] ?? w.category}${inSlot} — ${ROLE_TR[w.id] ?? w.role}`);
    setText(this.dimLabel, caliberTr(a.caliber));
    this.pills.replaceChildren();
    for (const id of w.ammo) {
      let name = id;
      try {
        name = this.sim.ctx.ammo(id).name;
      } catch {
        /* unknown ammo id: show the id */
      }
      el('span', `dx-pill${id === a.id ? ' dx-on' : ''}`, name, this.pills);
    }
    setText(this.ammoLineEl, `${ammoLine(a)} — ${a.note}`);
    this.specs.replaceChildren();
    for (const s of weaponSpecs(w, a)) {
      const row = el('div', `dx-spec${s.hi ? ' dx-hi' : ''}`, undefined, this.specs);
      el('span', 'dx-lbl', s.label, row);
      el('span', 'dx-num', s.value, row);
    }
    this.lastCharges = -1;
    this.hintsKey = '';
    this.layoutDirty = true;
    if (weaponChanged) {
      this.reticle.setKind(reticleFor(w));
      for (const [key, s] of this.slotEls) {
        const def = this.slots.find((x) => x.key === key)!;
        const on = def === slot;
        s.root.classList.toggle('dx-on', on);
        show(s.subs, on && s.subEls.size > 0);
        if (on) {
          setText(s.name, NAME_TR[w.id] ?? w.name);
          for (const [id, sub] of s.subEls) sub.classList.toggle('dx-on', id === w.id);
        }
      }
    }
  }

  private renderImpacts(): void {
    this.impactsDirty = false;
    const list = this.impacts;
    const top = list[0];
    show(this.emptyEl, !top);
    show(this.latest, !!top);
    if (top) {
      // Arrival flash on the newest result (Web Animations: no forced reflow to restart it).
      if (!REDUCED_MOTION()) this.latest.animate?.([{ backgroundColor: 'rgba(255, 181, 71, 0.16)' }, { backgroundColor: 'rgba(255, 181, 71, 0)' }], { duration: 450, easing: 'ease-out' });
      setText(this.lAmmo, top.ammo);
      setText(this.lMat, top.material);
      setText(this.lCnt, top.count > 1 ? `×${num(top.count, 0)}` : '');
      setText(this.lTag, top.outcomeTr);
      this.lTag.className = `dx-tag dx-${top.outcome}`;
      setText(this.lFollow, top.follow ? `↳ ${top.follow} · mermi önceki hedefi delip geldi` : '');
      show(this.lFollow, !!top.follow);
      setText(this.lDepth, top.depth);
      const vals = [top.speed, top.obliquity, top.residual, top.energy];
      for (let k = 0; k < 4; k++) setText(this.lVals[k]!, vals[k]!);
      setText(this.sumTr, top.description);
      setText(this.sumModel, top.model);
    }
    let shown = 0;
    for (let i = 0; i < this.older.length; i++) {
      const r = this.older[i]!;
      const d = list[i + 1];
      show(r.root, !!d);
      if (!d) continue;
      shown++;
      setText(r.ammo, d.follow ? `↳ ${d.follow}` : d.ammo);
      r.ammo.classList.toggle('dx-followed', !!d.follow);
      setText(r.mat, d.material);
      setText(r.depth, d.depth);
      setText(r.cnt, d.count > 1 ? `×${num(d.count, 0)}` : '');
      setText(r.tag, d.outcomeTr);
      r.tag.className = `dx-tag dx-${d.outcome}`;
    }
    show(this.olderBox, shown > 0);
    this.tele.classList.toggle('dx-none', !top && !this.lastBlast);
    this.renderGroup();
  }

  /**
   * The hit group as a section drawing through the spot: hatched material under the original
   * surface (the top rule), the cavity cut into it stepping down round by round from left (first
   * hit) to right (latest), and the member's back face as a dashed rule once a round went through.
   */
  private renderGroup(): void {
    const g = this.groups.current;
    const line = groupLine(g);
    this.groupEl.style.display = line ? '' : 'none';
    if (!line || !g) return;
    setText(this.groupHead, line.head);
    setText(this.groupDepth, line.depth);
    setText(this.groupNote, line.note);
    this.groupNote.style.display = line.note ? '' : 'none';
    const prof = g.profile;
    const thick = Number.isFinite(g.thickness) ? g.thickness : 0;
    const scale = Math.max(g.deepest, thick, 1e-3) * 1.12;
    const top = 1, H = SPARK_H - top;
    const y = (d: number) => (top + (d / scale) * H).toFixed(2);
    // Material band: down to the back face when known, else fading out below the cavity.
    const band = thick > 0 ? `${((top + (thick / scale) * H) / SPARK_H) * 100}%` : '100%';
    if (this.groupBand.style.height !== band) this.groupBand.style.height = band;
    this.groupBand.classList.toggle('dx-back', thick > 0);
    let px = 0;
    let d = `M0 ${top}`;
    for (let j = 0; j < prof.length; j++) {
      const x = (Math.min((j + 1) * g.stride, g.count) / g.count) * SPARK_W;
      d += `L${px.toFixed(1)} ${y(prof[j]!)}L${x.toFixed(1)} ${y(prof[j]!)}`;
      px = x;
    }
    this.groupSvg.innerHTML = `<path class="c" d="${d}L${SPARK_W} ${top}Z"/><path class="p" d="${d}"/><path class="s" d="M0 ${top}H${SPARK_W}"/>`;
  }

  private renderBlast(): void {
    this.blastDirty = false;
    const b = this.lastBlast;
    this.blastBox.style.display = b ? '' : 'none';
    this.tele.classList.toggle('dx-none', !b && !this.impacts.length);
    if (!b) return;
    const row = blastRow(b.e, this.sim.ctx.camera.position);
    const vals = [row.tnt, row.distance, row.overpressure, row.arrival, row.spl];
    for (let i = 0; i < 5; i++) setText(this.blastVals[i]!, vals[i]!);
    const frag = this.fragmentHits > 0 ? ` · ${this.fragmentHits} parça isabeti` : '';
    setText(this.blastNote, row.note + frag);
    this.blastNote.classList.toggle('dx-warn', row.warn);
    setText(this.blastTitle, row.label || b.e.source?.name || '');
  }

  private updateReticle(): void {
    const w = this.weapons.current;
    const cam = this.sim.ctx.camera;
    const pxPerRad = this.canvasH / 2 / Math.tan((cam.fov * Math.PI) / 360);
    // 2σ ring: 86 % of rounds (circular normal) land inside.
    const sigma = w.dispersionMOA * MOA;
    this.reticle.setSpread(2 * sigma * pxPerRad);
    this.reticle.setCooldown(this.coolMax > 0.2 ? this.weapons.cooldown / this.coolMax : 0);
    const aim = this.weapons.aimPoint;
    const range = aim ? aim.distanceTo(cam.position) : NaN;
    const placed = w.delivery === 'placed';
    const reach = w.placeRange ?? 80;
    setText(this.rangeLbl, w.delivery === 'indirect' ? 'Hedef' : placed ? 'Şarj' : 'Mesafe');
    setText(this.rangeEl, Number.isFinite(range) ? (placed && range > reach ? `${fmtDistance(range)} · erişim dışı` : fmtDistance(range)) : '—');
    const showSpread = w.delivery === 'direct' && w.dispersionMOA > 0 && Number.isFinite(range);
    this.spreadLine.style.display = showSpread ? '' : 'none';
    // Diameter holding 95 % of rounds: 2 · 2.45 σ · R (circular normal, Rayleigh radius).
    if (showSpread) setText(this.spreadEl, fmtLength(2 * 2.45 * sigma * range));
    const p = this.bridge.player;
    const ads = p?.ads ?? 0;
    const scopeKind = scopeFor(w);
    this.scope.update(scopeKind, ads, this.vw, this.vh, cam.fov, Number.isFinite(range) ? `${fmtDistance(range)} · ${num(w.zoom, 0)}×` : `${num(w.zoom, 0)}×`);
    const scoped = !!scopeKind && ads > 0.6;
    this.scoped = scoped;
    this.root.classList.toggle('dx-scoped', scoped);
    this.reticle.setVisible(!scoped && !(p?.bulletCam));
    this.readout.style.display = p?.bulletCam || scoped ? 'none' : '';
    // A render-only recoil kick lifts the picture, not the aim: the reticle stays on the aimed
    // point, which appears kp·(px/rad) below and ky·(px/rad) right of the centre (small angles).
    const kx = p && !scoped ? p.kick.yaw * pxPerRad : 0;
    const ky = p && !scoped ? p.kick.pitch * pxPerRad : 0;
    const tr = Math.abs(kx) + Math.abs(ky) > 0.25 ? `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)` : '';
    if (this.reticle.el.style.transform !== tr) this.reticle.el.style.transform = tr;
  }

  private updateOverlays(nowMs: number): void {
    const p = this.bridge.player;
    const bc = p?.bulletCam ?? null;
    if (bc) {
      this.banner.style.display = '';
      setText(this.bannerText, bc.following ? 'Mermi kamerası · ' : 'Mermi kamerası · isabet');
      setText(this.bannerAmmo, bc.following ? bc.ammo.name : '');
      setText(this.bannerNum, bc.following ? `${fmtSpeed(bc.speed)} · ${fmtDistance(bc.distance)}` : '');
    } else if (p?.bulletCamArmed) {
      this.banner.style.display = '';
      setText(this.bannerText, 'Mermi kamerası hazır · roket, top mermisi ya da bomba at');
      setText(this.bannerAmmo, '');
      setText(this.bannerNum, '');
    } else this.banner.style.display = 'none';
    const showHint = !!p && !p.locked && !p.touch && !this.menu.visible && this.hudVisible && !this.scoped && !bc;
    this.lockHint.style.display = showHint ? '' : 'none';
    if (showHint) setText(this.lockHint, upperTr(p!.lockUnavailable ? 'Sağ tuşla sürükle: bakış · sol tık: ateş' : 'Tıkla · fare kilidi'));
    this.root.classList.toggle('dx-is-touch', !!p?.touch);
    // Key hints: the first seconds of play and while the detail is open; never on touch screens.
    const hints = !p?.touch && !this.menu.visible && this.hudVisible && !this.scoped && !bc && (nowMs < this.hintsUntil || this.detailOn);
    show(this.keysEl, hints);
    if (hints) this.renderKeys();
    show(this.loadingEl, this.loadingLabel !== null && !this.menu.visible);
  }

  private renderKeys(): void {
    const w = this.weapons.current;
    const key = `${w.delivery}|${w.ammo.length}|${this.weapons.charges.length > 0}`;
    if (key === this.hintsKey) return;
    this.hintsKey = key;
    this.keysEl.replaceChildren();
    for (const h of keyHints(w.delivery, w.ammo.length, this.weapons.charges.length)) {
      const item = el('span', 'dx-khint', undefined, this.keysEl);
      for (const k of h.keys) el('span', 'dx-cap', k, item);
      el('span', undefined, h.label, item);
    }
  }
}
