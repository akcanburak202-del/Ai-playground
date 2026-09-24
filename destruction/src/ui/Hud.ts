import type { Simulation } from '../app/Simulation.ts';
import type { BlastEvent, SceneDef, WeaponControllerApi, WeaponSpec } from '../app/contracts.ts';
import type { AmmoSpec, ImpactEvent } from '../physics/ballistics/types.ts';
import { bridgeOf, type Bridge, type HudHooks } from './bridge.ts';
import { Reticle, ScopeOverlay, reticleFor, scopeFor } from './crosshair.ts';
import { fmtDistance, fmtLength, fmtScale, fmtSpeed, num } from './format.ts';
import { CATEGORY_SHORT_TR, CATEGORY_TR, HELP_DESKTOP, HELP_TOUCH, NAME_TR, ROLE_TR, caliberTr, upperTr } from './i18n.ts';
import { Menu } from './menu.ts';
import { ensureFonts, ensureStyle } from './theme.ts';
import { HitGroups, ammoLine, blastRow, groupLine, impactRow, weaponSpecs, type ImpactRow } from './telemetry.ts';
import { buildSlots, slotOf, type Slot } from '../player/slots.ts';

export interface HudOptions {
  scenes: SceneDef[];
  onSelectScene(id: string): void | Promise<void>;
  container?: HTMLElement;
  /** Show the scene menu at install (default true) */
  startWithMenu?: boolean;
  /** Pause the simulation while the menu is open (default true) */
  pauseOnMenu?: boolean;
}

const ROWS = 5;
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
const REDUCED_MOTION = (): boolean => (reducedMq ??= matchMedia('(prefers-reduced-motion: reduce)')).matches;

/** Write text only when it changed (DOM writes are the HUD's main cost). */
function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

interface RowEls {
  root: HTMLDivElement;
  idx: HTMLSpanElement;
  ammo: HTMLSpanElement;
  mat: HTMLSpanElement;
  cnt: HTMLSpanElement;
  tag: HTMLSpanElement;
  v: HTMLSpanElement[];
}

/**
 * Heads-up display: sheet header with live status, telemetry of the last impacts and blasts,
 * the weapon card with real specifications, the weapon strip, weapon-specific reticles, help,
 * toasts and the scene menu. Everything is DOM over the canvas; per-frame work only touches
 * nodes whose text actually changed.
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
  private rows: RowEls[] = [];
  private emptyEl!: HTMLDivElement;
  private colsEl!: HTMLDivElement;
  private sumTr!: HTMLDivElement;
  private sumModel!: HTMLDivElement;
  private summary!: HTMLDivElement;
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
  // Weapon card
  private card!: HTMLDivElement;
  private cardCat!: HTMLSpanElement;
  private cardKey!: HTMLSpanElement;
  private wName!: HTMLDivElement;
  private wRole!: HTMLDivElement;
  private dimLabel!: HTMLSpanElement;
  private pills!: HTMLDivElement;
  private ammoLineEl!: HTMLDivElement;
  private specs!: HTMLDivElement;
  private firedEl!: HTMLSpanElement;
  private coolBar!: HTMLElement;
  private coolLbl!: HTMLSpanElement;
  private chargesEl!: HTMLDivElement;
  // Strip
  private strip!: HTMLDivElement;
  private slotEls = new Map<number, { root: HTMLDivElement; name: HTMLSpanElement; count: HTMLSpanElement }>();
  // Overlays
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
    this.slots = buildSlots(weapons.weapons);
    ensureStyle();
    ensureFonts();
    this.root = el('div', 'dx-root dx-hud');
    this.root.lang = 'tr';
    this.buildHeader();
    this.buildTelemetry();
    this.buildCard();
    this.buildStrip();
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
        this.lastBlast = { e, wall: performance.now() };
        this.fragmentHits = 0;
        this.blastDirty = true;
      }),
      ev.on('sceneLoaded', () => this.onScene()),
      ev.on('chargePlaced', () => (this.lastCharges = -1)),
      ev.on('chargeRemoved', () => (this.lastCharges = -1)),
      sim.onFrame((dt) => this.frame(dt)),
    );
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    const onResize = () => {
      this.layoutDirty = true;
      this.measure();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    this.unsub.push(() => {
      window.removeEventListener('keydown', onKey);
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
      if (document.pointerLockElement) document.exitPointerLock();
      this.menu.setMuted(this.sim.ctx.audio.muted);
    }
    if (this.opts.pauseOnMenu ?? true) this.sim.paused = show;
  }

  toggleHelp(): void {
    this.help.classList.toggle('dx-show');
  }

  reload(): void {
    const id = this.sim.currentScene?.id;
    if (!id) return;
    this.toast('Sahne yeniden kuruluyor');
    void this.load(id).catch((err) => console.error('scene reload failed', err));
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

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    clearTimeout(this.toastTimer);
    this.reticle.dispose();
    this.scope.dispose();
    this.menu.dispose();
    this.root.remove();
    if (this.bridge.hud === this) this.bridge.hud = null;
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
    el('span', 'dx-lbl', 'Son isabetler', head);
    const cols = el('div', 'dx-cols', undefined, p);
    for (const c of ['Çarpma hızı', 'Açı', 'Derinlik', 'Kalıntı hız', 'Enerji']) el('span', 'dx-lbl', c, cols);
    const rows = el('div', 'dx-rows', undefined, p);
    this.emptyEl = el('div', 'dx-empty', 'Henüz isabet yok. Bir yüzeye ateş et: çarpma hızı, geliş açısı, nüfuz derinliği, kalıntı hız ve soğurulan enerji burada.', rows);
    this.colsEl = cols;
    for (let i = 0; i < ROWS; i++) {
      const root = el('div', 'dx-row', undefined, rows);
      const l1 = el('div', 'dx-row-1', undefined, root);
      const idx = el('span', 'dx-num dx-dim', '', l1);
      const ammo = el('span', 'dx-ammo', '', l1);
      const mat = el('span', 'dx-mat', '', l1);
      const cnt = el('span', 'dx-cnt dx-num', '', l1);
      const tag = el('span', 'dx-tag', '', l1);
      const l2 = el('div', 'dx-row-2', undefined, root);
      const v: HTMLSpanElement[] = [];
      for (let k = 0; k < 5; k++) v.push(el('span', 'dx-v', '', l2));
      root.style.display = 'none';
      this.rows.push({ root, idx, ammo, mat, cnt, tag, v });
    }
    this.summary = el('div', 'dx-summary', undefined, p);
    this.sumTr = el('div', 'dx-tr', '', this.summary);
    this.groupEl = el('div', 'dx-group', undefined, this.summary);
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
    this.sumModel = el('div', 'dx-model', '', this.summary);
    this.summary.style.display = 'none';
    this.blastBox = el('div', 'dx-blast', undefined, p);
    const bh = el('div', 'dx-tele-head', undefined, this.blastBox);
    el('span', 'dx-title', 'Patlama · kamerada', bh);
    this.blastTitle = el('span', 'dx-lbl', '', bh);
    const grid = el('div', 'dx-blast-grid', undefined, this.blastBox);
    for (const l of ['TNT-e', 'Mesafe', 'Aşırı basınç', 'Varış', 'Ses basıncı']) el('span', 'dx-lbl', l, grid);
    for (let i = 0; i < 5; i++) this.blastVals.push(el('span', 'dx-v', '', grid));
    this.blastNote = el('div', 'dx-note', '', this.blastBox);
    this.blastBox.style.display = 'none';
  }

  private buildCard(): void {
    const c = el('div', 'dx-panel dx-card', undefined, this.root);
    this.card = c;
    const top = el('div', 'dx-card-top', undefined, c);
    this.cardCat = el('span', 'dx-lbl', '', top);
    const right = el('span', 'dx-stat', undefined, top);
    el('span', 'dx-lbl', 'Tuş', right);
    this.cardKey = el('span', 'dx-key', '', right);
    this.wName = el('div', 'dx-wname', '', c);
    this.wRole = el('div', 'dx-role', '', c);
    const dim = el('div', 'dx-dimline', undefined, c);
    el('i', undefined, undefined, dim);
    this.dimLabel = el('span', undefined, '', dim);
    el('i', undefined, undefined, dim);
    const ammoHead = el('div', 'dx-card-top', undefined, c);
    el('span', 'dx-lbl', 'Mühimmat', ammoHead);
    el('span', 'dx-lbl dx-hide-s', 'T · değiştir', ammoHead);
    this.pills = el('div', 'dx-ammo-pills', undefined, c);
    this.ammoLineEl = el('div', 'dx-ammo-line', '', c);
    this.specs = el('div', 'dx-specs', undefined, c);
    const foot = el('div', 'dx-foot', undefined, c);
    const fired = el('span', 'dx-stat', undefined, foot);
    el('span', 'dx-lbl', 'Atılan', fired);
    this.firedEl = el('span', 'dx-num dx-live', '0', fired);
    const cool = el('div', 'dx-cool', undefined, foot);
    this.coolBar = el('b', undefined, undefined, cool);
    for (const x of [0, 25, 50, 75, 100]) el('i', undefined, undefined, cool).style.left = `${x}%`;
    this.coolLbl = el('span', 'dx-num', 'Hazır', foot);
    this.chargesEl = el('div', 'dx-charges', '', c);
  }

  private buildStrip(): void {
    this.strip = el('div', 'dx-panel dx-strip', undefined, this.root);
    for (const s of this.slots) {
      const root = el('div', 'dx-slot', undefined, this.strip);
      el('span', 'dx-key', String(s.key), root);
      el('span', 'dx-lbl', CATEGORY_SHORT_TR[s.category] ?? s.category, root);
      const name = el('span', 'dx-sname', NAME_TR[s.weapons[0]!.id] ?? s.weapons[0]!.name, root);
      const count = el('span', 'dx-count', s.weapons.length > 1 ? `1/${s.weapons.length}` : '', root);
      this.slotEls.set(s.key, { root, name, count });
    }
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
    this.banner = el('div', 'dx-panel dx-banner', undefined, this.root);
    this.bannerText = el('span', undefined, '', this.banner);
    this.bannerAmmo = el('span', undefined, '', this.banner);
    this.bannerAmmo.lang = 'en';
    this.bannerNum = el('span', 'dx-num', '', this.banner);
    this.banner.style.display = 'none';
    this.toastEl = el('div', 'dx-panel dx-toast', '', this.root);
    this.lockHint = el('div', 'dx-panel dx-lockhint', 'Tıkla · fare kilidi', this.root);
    this.lockHint.style.display = 'none';
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
    el('div', 'dx-help-foot', 'Fizik: her isabet terminal balistik modeliyle çözülür; telemetri panelindeki sayılar modelin sonucudur, efekt için ayarlanmış değerler değildir.', this.help);
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
    this.menu.setLoading(true);
    void this.load(id).then(
      () => {
        this.menu.setLoading(false);
        this.showMenu(false);
      },
      (err) => {
        // Stay on the sheet: dropping the viewer into a half-built world helps nobody.
        console.error('scene load failed', err);
        this.menu.setLoading(false);
        if (document.pointerLockElement) document.exitPointerLock();
        this.toast('Sahne yüklenemedi', true);
      },
    );
  }

  /** Scene loader call that also turns a synchronous throw into a rejection. */
  private load(id: string): Promise<void> {
    return new Promise<void>((resolve) => resolve(this.opts.onSelectScene(id)));
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
    if (e.agent === 'fragment') {
      this.fragmentHits++;
      this.blastDirty = true;
      return;
    }
    // Rows are the latest distinct results: a burst on concrete is one row (×60) with the newest
    // numbers, so the rounds that went through and skipped off the ground behind do not push
    // the wall's own row out of the panel. While a spot is being worked, results elsewhere (those
    // same rounds landing behind it) go in under its row, so the top row and the description stay
    // with what the viewer is shooting at.
    // A dispersed weapon's burst is still one spot: its 95 % group radius (2.45 σ) at this range.
    const sigma = this.weapons.current.dispersionMOA * MOA;
    const g = this.groups.add(e, 2.45 * sigma * e.point.distanceTo(this.sim.ctx.camera.position));
    const cur = this.groups.current;
    const secondary = !!cur && g !== cur && cur.activityAt(e.time) > 1.5;
    const row = impactRow(e);
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
  }

  // ─── Per frame ─────────────────────────────────────────────────────────────────────────────

  private frame(realDt: number): void {
    const t0 = performance.now();
    const ctx = this.sim.ctx;
    if (realDt > 0 && realDt < 1) this.fps += (1 / realDt - this.fps) * Math.min(1, realDt * 3);
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
    this.updateWeapon();
    const nowMs = performance.now();
    // Telemetry at most ~20 Hz under a GAU-8 burst.
    if ((this.impactsDirty || this.blastDirty) && nowMs - this.lastRender > 50) {
      this.lastRender = nowMs;
      if (this.impactsDirty) this.renderImpacts();
      if (this.blastDirty) this.renderBlast();
    }
    if (this.lastBlast && nowMs - this.lastBlast.wall > 14000) {
      this.lastBlast = null;
      this.blastDirty = true;
    }
    this.updateReticle();
    this.updateOverlays();
    this.frameMs += (performance.now() - t0 - this.frameMs) * 0.05;
  }

  private updateWeapon(): void {
    const w = this.weapons.current;
    const a = this.weapons.currentAmmo;
    if (w !== this.lastWeapon || a !== this.lastAmmo) {
      const weaponChanged = w !== this.lastWeapon;
      this.lastWeapon = w;
      this.lastAmmo = a;
      this.renderCard(w, a, weaponChanged);
    }
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
        this.chargesEl.append(n > 0 ? ' · X: birlikte patlat · B: sırayla' : ' · sol tık: yüzeye yerleştir');
      }
      this.layoutDirty = true;
    }
    if (this.layoutDirty) {
      this.layoutDirty = false;
      this.layout();
    }
  }

  /** On narrow screens the telemetry stacks under the (variable-height) weapon card. */
  private layout(): void {
    const narrow = matchMedia('(max-width: 760px)').matches;
    const top = narrow ? `${this.card.offsetTop + this.card.offsetHeight + 8}px` : '';
    if (this.tele.style.top !== top) this.tele.style.top = top;
  }

  private renderCard(w: WeaponSpec, a: AmmoSpec, weaponChanged: boolean): void {
    const slot = slotOf(this.slots, w.id);
    setText(this.cardCat, CATEGORY_TR[w.category] ?? w.category);
    setText(this.cardKey, slot ? String(slot.key) : '');
    const trName = NAME_TR[w.id];
    setText(this.wName, trName ?? w.name);
    // Model designations are English words: keep the Turkish dotted İ out of their capitals.
    this.wName.lang = trName ? 'tr' : 'en';
    setText(this.wRole, ROLE_TR[w.id] ?? w.role);
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
    setText(this.ammoLineEl, ammoLine(a));
    this.specs.replaceChildren();
    for (const s of weaponSpecs(w, a)) {
      const row = el('div', `dx-spec${s.hi ? ' dx-hi' : ''}`, undefined, this.specs);
      el('span', 'dx-lbl', s.label, row);
      el('span', 'dx-num', s.value, row);
    }
    this.lastCharges = -1;
    this.layoutDirty = true;
    if (weaponChanged) {
      this.reticle.setKind(reticleFor(w));
      for (const [key, s] of this.slotEls) {
        const def = this.slots.find((x) => x.key === key)!;
        const on = def === slot;
        s.root.classList.toggle('dx-on', on);
        if (on) {
          setText(s.name, NAME_TR[w.id] ?? w.name);
          const i = def.weapons.findIndex((x) => x.id === w.id);
          setText(s.count, def.weapons.length > 1 ? `${i + 1}/${def.weapons.length}` : '');
        }
      }
    }
  }

  private renderImpacts(): void {
    this.impactsDirty = false;
    const list = this.impacts;
    // Arrival flash on the newest row (Web Animations: no forced reflow to restart it).
    if (list.length && !REDUCED_MOTION()) {
      this.rows[0]!.root.animate?.([{ backgroundColor: 'rgba(255, 181, 71, 0.2)' }, { backgroundColor: 'rgba(255, 181, 71, 0)' }], { duration: 450, easing: 'ease-out' });
    }
    this.emptyEl.style.display = list.length ? 'none' : '';
    this.colsEl.style.display = list.length ? '' : 'none';
    for (let i = 0; i < ROWS; i++) {
      const r = this.rows[i]!;
      const d = list[i];
      if (!d) {
        r.root.style.display = 'none';
        continue;
      }
      r.root.style.display = '';
      r.root.classList.toggle('dx-new', i === 0);
      setText(r.idx, String(i + 1).padStart(2, '0'));
      setText(r.ammo, d.ammo);
      setText(r.mat, d.material);
      setText(r.cnt, d.count > 1 ? `×${num(d.count, 0)}` : '');
      setText(r.tag, d.outcomeTr);
      r.tag.className = `dx-tag dx-${d.outcome}`;
      const vals = [d.speed, d.obliquity, d.depth, d.residual, d.energy];
      for (let k = 0; k < 5; k++) setText(r.v[k]!, vals[k]!);
    }
    const top = list[0];
    this.summary.style.display = top ? '' : 'none';
    if (top) {
      setText(this.sumTr, top.description);
      setText(this.sumModel, top.model);
    }
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
    const reach = (w as WeaponSpec & { placeRange?: number }).placeRange ?? 80;
    setText(this.rangeLbl, w.delivery === 'indirect' ? 'Hedef' : placed ? 'Şarj' : 'Mesafe');
    setText(this.rangeEl, Number.isFinite(range) ? (placed && range > reach ? `${fmtDistance(range)} · menzil dışı` : fmtDistance(range)) : '—');
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
  }

  private updateOverlays(): void {
    const p = this.bridge.player;
    const bc = p?.bulletCam ?? null;
    if (bc) {
      this.banner.style.display = '';
      setText(this.bannerText, bc.following ? 'Mermi kamerası · ' : 'Mermi kamerası · isabet');
      setText(this.bannerAmmo, bc.following ? bc.ammo.name : '');
      setText(this.bannerNum, bc.following ? `${fmtSpeed(bc.speed)} · ${fmtDistance(bc.distance)}` : '');
    } else if (p?.bulletCamArmed) {
      this.banner.style.display = '';
      setText(this.bannerText, 'Mermi kamerası hazır · roket, top mermisi veya bomba at');
      setText(this.bannerAmmo, '');
      setText(this.bannerNum, '');
    } else this.banner.style.display = 'none';
    const showHint = !!p && !p.locked && !p.touch && !this.menu.visible && this.hudVisible && !this.scoped && !bc;
    this.lockHint.style.display = showHint ? '' : 'none';
    if (showHint) setText(this.lockHint, upperTr(p!.lockUnavailable ? 'Sağ tuşla sürükle: bakış · sol tık: ateş' : 'Tıkla · fare kilidi'));
    this.root.classList.toggle('dx-is-touch', !!p?.touch);
  }
}
