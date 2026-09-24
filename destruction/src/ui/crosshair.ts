import type { WeaponSpec } from '../app/contracts.ts';

/**
 * Reticles. Each weapon family gets the sight its crews actually use, drawn as SVG in tracer
 * amber over a dark outline so it reads on bright sky and in smoke:
 *  - cross: rifles and machine guns, with a dashed ring at the 2σ dispersion cone
 *  - pipper: aircraft gun (GAU-8) — ring and centre dot
 *  - mildot: sniper / anti-materiel rifle; scoped, a mil-dot reticle calibrated to the true FOV
 *  - chevron: launchers and tank gun — rangefinder chevron with stadia ticks
 *  - box: indirect fire — target box around the aim point
 *  - charge: demolition — placement ring
 */

export type ReticleKind = 'cross' | 'pipper' | 'mildot' | 'chevron' | 'box' | 'charge';
export type ScopeKind = 'rifle' | 'clu' | null;

export function reticleFor(w: WeaponSpec): ReticleKind {
  if (w.delivery === 'placed') return 'charge';
  if (w.delivery === 'indirect') return 'box';
  if (w.category === 'sniper') return 'mildot';
  if (w.category === 'launcher') return 'chevron';
  if (w.category === 'cannon') return w.fireMode === 'auto' ? 'pipper' : 'chevron';
  return 'cross';
}

export function scopeFor(w: WeaponSpec): ScopeKind {
  if (w.category === 'sniper') return 'rifle';
  if (w.id === 'javelin' || /javelin/i.test(w.name)) return 'clu';
  return null;
}

/**
 * The sights' published true fields (vertical) at a reference magnification. An eyepiece shows a
 * fixed apparent field, so at magnification Z: tan(true/2) = tan(apparent/2) / Z with
 * tan(apparent/2) = Z_ref · tan(true_ref/2). Riflescope: a 4.5–14× tactical scope at 10× sees
 * 10.4 ft at 100 yd = 2.17° (Leupold Mark 4 LR/T data). Javelin CLU day sight: 4× with a
 * 6.40° × 4.80° field (FM 3-22.37, Javelin Medium Antiarmor Weapon System).
 */
export const SIGHT_TRUE_FIELD: Record<Exclude<ScopeKind, null>, { deg: number; zoom: number }> = {
  rifle: { deg: 2.17, zoom: 10 },
  clu: { deg: 4.8, zoom: 4 },
};

/**
 * Fraction of the viewport height the sight's aperture covers: the round eyepiece is 0.92 of the
 * shorter side; the CLU display is 0.74 of the height, or 0.62 of the width on narrow screens.
 * ScopeOverlay draws exactly these apertures.
 */
export function scopeAperture(kind: Exclude<ScopeKind, null>, aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return kind === 'rifle' ? 0.92 * Math.min(1, a) : Math.min(0.74, 0.62 * a);
}

/**
 * Vertical camera field of view (degrees) at which the sight's aperture spans its real true
 * field. With the aperture filling a fraction k of the screen height, tan(φ/2) = tan(true/2) / k,
 * so the scene and the reticle stay in real proportion (1 mil on the reticle = 1 mrad).
 */
export function scopeFov(kind: Exclude<ScopeKind, null>, zoom: number, aspect: number): number {
  const ref = SIGHT_TRUE_FIELD[kind];
  const tanApparent = ref.zoom * Math.tan((ref.deg * Math.PI) / 360);
  const t = tanApparent / Math.max(1, zoom) / scopeAperture(kind, aspect);
  return (Math.atan(t) * 360) / Math.PI;
}

const NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent?.appendChild(e);
  return e;
}

/** Outline + amber stroke pair for one path */
function stroke(parent: Element, d: string): SVGPathElement {
  svgEl('path', { class: 'o', d }, parent);
  return svgEl('path', { class: 'a', d }, parent);
}

function crossPath(gap: number, len: number): string {
  return `M${-gap - len} 0H${-gap}M${gap} 0H${gap + len}M0 ${-gap - len}V${-gap}M0 ${gap}V${gap + len}`;
}

export class Reticle {
  readonly el: HTMLDivElement;
  private svg: SVGSVGElement;
  private kind: ReticleKind | null = null;
  private spread: SVGCircleElement | null = null;
  private arms: SVGPathElement[] = [];
  private cool: SVGPathElement;
  private coolO: SVGPathElement;
  private gap = -1;
  private lastCool = -1;
  private hitEl: HTMLDivElement;
  private hitTimer = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'dx-reticle';
    this.svg = svgEl('svg', { width: 240, height: 240, viewBox: '-120 -120 240 240', style: 'left:-120px;top:-120px' });
    this.el.appendChild(this.svg);
    this.coolO = svgEl('path', { class: 'o', d: '' });
    this.cool = svgEl('path', { class: 'a', d: '' });
    parent.appendChild(this.el);
    this.hitEl = document.createElement('div');
    this.hitEl.className = 'dx-hit';
    const hs = svgEl('svg', { width: 40, height: 40, viewBox: '-20 -20 40 40', style: 'position:absolute;left:-20px;top:-20px;overflow:visible' });
    stroke(hs, 'M-11 -11l5 5M11 -11l-5 5M-11 11l5 -5M11 11l-5 -5');
    this.hitEl.appendChild(hs);
    parent.appendChild(this.hitEl);
  }

  setKind(kind: ReticleKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.svg.replaceChildren();
    this.arms = [];
    this.spread = null;
    this.gap = -1;
    const g = this.svg;
    switch (kind) {
      case 'cross':
        this.spread = svgEl('circle', { class: 's', r: 6, cx: 0, cy: 0 }, g);
        this.arms = [svgEl('path', { class: 'o', d: crossPath(6, 8) }, g), svgEl('path', { class: 'a', d: crossPath(6, 8) }, g)];
        svgEl('circle', { class: 'af', r: 1.3, cx: 0, cy: 0 }, g);
        break;
      case 'pipper':
        this.spread = svgEl('circle', { class: 's', r: 6, cx: 0, cy: 0 }, g);
        svgEl('circle', { class: 'o', r: 20 }, g);
        svgEl('circle', { class: 'a', r: 20 }, g);
        stroke(g, 'M0 -20v-6M0 20v6M-20 0h-6M20 0h6');
        svgEl('circle', { class: 'af', r: 1.8 }, g);
        break;
      case 'mildot':
        stroke(g, 'M-26 0H-5M5 0H26M0 5V26M0 -26V-5');
        svgEl('circle', { class: 'af', r: 1.2 }, g);
        break;
      case 'chevron':
        // Rangefinder chevron: the tip is the aim point; stadia ticks below for holdover.
        stroke(g, 'M-14 13L0 0L14 13');
        stroke(g, 'M-3 22h6M-5 30h10M-3 38h6');
        stroke(g, 'M-34 0h-12M34 0h12');
        break;
      case 'box':
        stroke(g, 'M-18 -12V-18H-12M12 -18H18V-12M18 12V18H12M-12 18H-18V12');
        stroke(g, 'M-5 -5L5 5M5 -5L-5 5');
        break;
      case 'charge':
        svgEl('circle', { class: 'o', r: 10 }, g);
        svgEl('circle', { class: 'a', r: 10 }, g);
        stroke(g, 'M0 -16v-6M0 16v6M-16 0h-6M16 0h6');
        svgEl('circle', { class: 'af', r: 1.5 }, g);
        break;
    }
    g.append(this.coolO, this.cool);
    this.lastCool = -1;
  }

  /** Radius of the 2σ dispersion ring in px; the cross arms open with it. */
  setSpread(px: number): void {
    const r = Math.round(Math.max(2.5, Math.min(90, px)) * 2) / 2;
    if (!this.spread || r === this.gap) return;
    this.gap = r;
    this.spread.setAttribute('r', String(r));
    if (this.arms.length) {
      const d = crossPath(Math.max(5, r + 2), 8);
      for (const a of this.arms) a.setAttribute('d', d);
    }
  }

  /** Reload / cycling arc (0 = ready) */
  setCooldown(frac: number): void {
    const f = frac > 0.005 ? Math.round(Math.min(1, frac) * 90) / 90 : 0;
    if (f === this.lastCool) return;
    this.lastCool = f;
    let d = '';
    if (f > 0) {
      const R = 30, a0 = -Math.PI / 2, a1 = a0 + (1 - f) * 2 * Math.PI;
      const x0 = R * Math.cos(a0), y0 = R * Math.sin(a0);
      const x1 = R * Math.cos(a1), y1 = R * Math.sin(a1);
      d = 1 - f < 1e-3 ? '' : `M${x0.toFixed(2)} ${y0.toFixed(2)}A${R} ${R} 0 ${1 - f > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
      d += `M${(R - 3) * Math.cos(a0)} ${(R - 3) * Math.sin(a0)}L${(R + 3) * Math.cos(a0)} ${(R + 3) * Math.sin(a0)}`;
    }
    this.cool.setAttribute('d', d);
    this.coolO.setAttribute('d', d);
  }

  flashHit(): void {
    this.hitEl.classList.add('dx-show');
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => this.hitEl.classList.remove('dx-show'), 70);
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? '' : 'none';
  }

  dispose(): void {
    clearTimeout(this.hitTimer);
    this.el.remove();
    this.hitEl.remove();
  }
}

/**
 * Scope overlays: a rifle scope (round eyepiece, mil-dot reticle scaled to the current field of
 * view so 1 mil on the reticle is 1 mrad in the world) and the Javelin CLU (rectangular day-sight
 * field with a track gate).
 */
export class ScopeOverlay {
  readonly el: HTMLDivElement;
  private svg: SVGSVGElement;
  private key = '';
  private label: SVGTextElement | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'dx-scope';
    this.svg = svgEl('svg', {});
    this.el.appendChild(this.svg);
    parent.appendChild(this.el);
  }

  /** Redraws only when the kind, viewport or FOV bucket changes. */
  update(kind: ScopeKind, amount: number, w: number, h: number, fovDeg: number, info: string): void {
    // The eyepiece comes up with the zoom rather than on a timer.
    const o = kind ? Math.min(1, Math.max(0, (amount - 0.5) / 0.4)) : 0;
    const op = o > 0 ? (o * o * (3 - 2 * o)).toFixed(3) : '0';
    if (this.el.style.opacity !== op) this.el.style.opacity = op;
    this.el.style.display = o > 0 ? 'block' : 'none';
    if (!(o > 0) || !kind) return;
    const key = `${kind}|${w}|${h}|${fovDeg.toFixed(2)}`;
    if (key !== this.key) {
      this.key = key;
      this.draw(kind, w, h, fovDeg);
    }
    if (this.label && this.label.textContent !== info) this.label.textContent = info;
  }

  private draw(kind: ScopeKind, w: number, h: number, fovDeg: number): void {
    const s = this.svg;
    s.replaceChildren();
    s.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const cx = w / 2, cy = h / 2;
    // Pixels per milliradian at the current vertical field of view.
    const pxPerMil = (0.001 / Math.tan((fovDeg * Math.PI) / 360)) * (h / 2);
    const ink = 'rgba(8,8,8,0.92)';
    if (kind === 'rifle') {
      const R = (scopeAperture('rifle', w / h) * h) / 2;
      svgEl('path', { d: `M0 0H${w}V${h}H0Z M${cx - R} ${cy}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0Z`, fill: 'rgb(6,6,5)', 'fill-rule': 'evenodd' }, s);
      const defs = svgEl('defs', {}, s);
      const grad = svgEl('radialGradient', { id: 'dx-vig', cx: '50%', cy: '50%', r: '50%' }, defs);
      svgEl('stop', { offset: '0.82', 'stop-color': 'rgb(0,0,0)', 'stop-opacity': 0 }, grad);
      svgEl('stop', { offset: '1', 'stop-color': 'rgb(0,0,0)', 'stop-opacity': 0.85 }, grad);
      svgEl('circle', { cx, cy, r: R + 1, fill: 'url(#dx-vig)' }, s);
      // Thick posts outside ±5 mil, fine crosshair and dots at every mil inside.
      const post = 5 * pxPerMil;
      svgEl('path', { d: `M${cx - R} ${cy}H${cx - post}M${cx + post} ${cy}H${cx + R}M${cx} ${cy + post}V${cy + R}`, stroke: ink, 'stroke-width': 4 }, s);
      svgEl('path', { d: `M${cx - post} ${cy}H${cx + post}M${cx} ${cy - R}V${cy + post}`, stroke: ink, 'stroke-width': 1 }, s);
      const dot = Math.max(1.4, pxPerMil * 0.15);
      for (let i = -4; i <= 4; i++) {
        if (i === 0) continue;
        svgEl('circle', { cx: cx + i * pxPerMil, cy, r: dot, fill: ink }, s);
        svgEl('circle', { cx, cy: cy + i * pxPerMil, r: dot, fill: ink }, s);
      }
      svgEl('circle', { cx, cy, r: 1.6, fill: '#ffb547' }, s);
      // Range and magnification, lower left inside the eyepiece (clear of the touch buttons on the right).
      this.label = svgEl('text', { x: cx - R * 0.62, y: cy + R * 0.62, fill: '#ffb547', 'font-family': 'Martian Mono, monospace', 'font-size': 11, 'font-stretch': '87.5%' }, s);
    } else {
      // Javelin CLU day sight: 6.4° × 4.8° field (4:3), black surround, track gate brackets.
      const fh = scopeAperture('clu', w / h) * h, fw = fh * (4 / 3);
      const x0 = cx - fw / 2, y0 = cy - fh / 2;
      svgEl('path', { d: `M0 0H${w}V${h}H0Z M${x0} ${y0}h${fw}v${fh}h${-fw}Z`, fill: 'rgb(8,9,8)', 'fill-rule': 'evenodd' }, s);
      svgEl('rect', { x: x0, y: y0, width: fw, height: fh, fill: 'rgba(120,150,110,0.06)', stroke: 'rgba(239,233,223,0.3)' }, s);
      const g = 34, b = 12;
      const amber = '#ffb547';
      svgEl('path', { d: `M${cx - g} ${cy - g + b}V${cy - g}H${cx - g + b}M${cx + g - b} ${cy - g}H${cx + g}V${cy - g + b}M${cx + g} ${cy + g - b}V${cy + g}H${cx + g - b}M${cx - g + b} ${cy + g}H${cx - g}V${cy + g - b}`, stroke: amber, 'stroke-width': 2, fill: 'none' }, s);
      svgEl('path', { d: `M${x0 + 12} ${cy}H${cx - g - 10}M${cx + g + 10} ${cy}H${x0 + fw - 12}M${cx} ${y0 + 12}V${cy - g - 10}M${cx} ${cy + g + 10}V${y0 + fh - 12}`, stroke: 'rgba(239,233,223,0.55)', 'stroke-width': 1 }, s);
      const txt = (x: number, y: number, t: string, anchor = 'start') => {
        const e = svgEl('text', { x, y, fill: 'rgba(239,233,223,0.8)', 'font-family': 'Martian Mono, monospace', 'font-size': 11, 'text-anchor': anchor }, s);
        e.textContent = t;
        return e;
      };
      txt(x0 + 14, y0 + 22, 'GÜNDÜZ NİŞANGAHI · 6,4° × 4,8°');
      txt(x0 + fw - 14, y0 + 22, 'TEPEDEN VURUŞ', 'end');
      this.label = txt(x0 + fw - 14, y0 + fh - 14, '', 'end');
      this.label.setAttribute('fill', amber);
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
