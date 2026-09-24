import { ensureStyle } from '../ui/theme.ts';

/**
 * Phone controls: a floating stick under the left thumb, drag-to-look on the right half, a big
 * fire button, and buttons for weapon, ammunition, sights, slow motion, climb / descend, the
 * bullet camera, detonation and the menu. Multi-touch through pointer events (one pointer per
 * control), so moving, looking and firing work at the same time.
 */

export interface TouchActions {
  fire(down: boolean): void;
  nextWeapon(): void;
  cycleAmmo(): void;
  slowMo(): void;
  ads(): void;
  detonate(): void;
  bulletCam(): void;
  menu(): void;
  unlockAudio(): void;
  state(): { slowMo: boolean; ads: boolean; charges: number; placed: boolean; hidden: boolean; bulletCam: boolean };
}

const STICK_RADIUS = 52;

const CHEVRON_UP = '<svg viewBox="0 0 16 16"><path d="M3 10.5L8 5.5L13 10.5"/></svg>';
const CHEVRON_DOWN = '<svg viewBox="0 0 16 16"><path d="M3 5.5L8 10.5L13 5.5"/></svg>';

export class TouchControls {
  readonly root: HTMLDivElement;
  /** Stick deflection: x right, y forward, each −1…1 */
  readonly move = { x: 0, y: 0 };
  up = false;
  down = false;
  private lookX = 0;
  private lookY = 0;
  private stickId = -1;
  private lookId = -1;
  private stickOrigin = { x: 0, y: 0 };
  private lookLast = { x: 0, y: 0 };
  private stick: HTMLDivElement;
  private knob: HTMLElement;
  private buttons: { el: HTMLElement; on?: () => boolean; visible?: () => boolean }[] = [];
  private fireBtn: HTMLElement;
  private firePointer = -1;
  private readonly a: TouchActions;

  constructor(actions: TouchActions) {
    this.a = actions;
    ensureStyle();
    this.root = document.createElement('div');
    this.root.className = 'dx-root dx-is-touch';
    this.root.lang = 'tr';
    this.root.style.zIndex = '19';
    const layer = document.createElement('div');
    layer.className = 'dx-touch';
    this.root.appendChild(layer);

    const look = this.zone(layer, 'dx-look-zone');
    look.addEventListener('pointerdown', (e) => {
      if (this.lookId >= 0) return;
      this.a.unlockAudio();
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      look.setPointerCapture(e.pointerId);
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      this.lookX += e.clientX - this.lookLast.x;
      this.lookY += e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    const endLook = (e: PointerEvent) => {
      if (e.pointerId === this.lookId) this.lookId = -1;
    };
    look.addEventListener('pointerup', endLook);
    look.addEventListener('pointercancel', endLook);

    const stickZone = this.zone(layer, 'dx-stick-zone');
    this.stick = document.createElement('div');
    this.stick.className = 'dx-stick';
    this.knob = document.createElement('b');
    this.stick.appendChild(this.knob);
    layer.appendChild(this.stick);
    stickZone.addEventListener('pointerdown', (e) => {
      if (this.stickId >= 0) return;
      this.a.unlockAudio();
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.stick.classList.add('dx-show');
      stickZone.setPointerCapture(e.pointerId);
      this.setStick(0, 0);
    });
    stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.setStick(e.clientX - this.stickOrigin.x, e.clientY - this.stickOrigin.y);
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.setStick(0, 0);
      this.stick.classList.remove('dx-show');
    };
    stickZone.addEventListener('pointerup', endStick);
    stickZone.addEventListener('pointercancel', endStick);

    // Fire: held while the finger stays down.
    this.fireBtn = this.button(layer, 'Ateş', 'dx-fire', 'right:18px;bottom:104px', () => {});
    this.fireBtn.addEventListener('pointerdown', (e) => {
      this.a.unlockAudio();
      this.firePointer = e.pointerId;
      this.fireBtn.setPointerCapture(e.pointerId);
      this.fireBtn.classList.add('dx-on');
      this.a.fire(true);
    });
    const endFire = (e: PointerEvent) => {
      if (e.pointerId !== this.firePointer) return;
      this.firePointer = -1;
      this.fireBtn.classList.remove('dx-on');
      this.a.fire(false);
    };
    this.fireBtn.addEventListener('pointerup', endFire);
    this.fireBtn.addEventListener('pointercancel', endFire);

    const bottom = 'bottom:calc(18px + env(safe-area-inset-bottom))';
    this.button(layer, 'Silah', '', `right:18px;${bottom};width:84px`, () => this.a.nextWeapon());
    this.button(layer, 'Mühimmat', '', `right:110px;${bottom}`, () => this.a.cycleAmmo());
    this.button(layer, 'Nişan', '', 'right:116px;bottom:128px', () => this.a.ads(), () => this.a.state().ads);
    this.button(layer, 'Ağır çekim', '', 'right:116px;bottom:174px', () => this.a.slowMo(), () => this.a.state().slowMo);
    this.button(layer, 'Patlat', '', 'right:18px;bottom:202px;width:86px', () => this.a.detonate(), undefined, () => this.a.state().charges > 0 || this.a.state().placed);
    const upBtn = this.button(layer, CHEVRON_UP, '', 'right:62px;bottom:250px;width:40px', () => {}, () => this.up, undefined, true);
    const downBtn = this.button(layer, CHEVRON_DOWN, '', 'right:18px;bottom:250px;width:40px', () => {}, () => this.down, undefined, true);
    this.hold(upBtn, (v) => (this.up = v));
    this.hold(downBtn, (v) => (this.down = v));
    // Right column above climb / descend, clear of the panels along the top.
    // Lit while the bullet camera waits for a round or rides one (a second tap cancels it).
    this.button(layer, 'Kamera', '', 'right:18px;bottom:296px;width:84px', () => this.a.bulletCam(), () => this.a.state().bulletCam);
    this.button(layer, 'Menü', '', 'right:110px;bottom:296px', () => this.a.menu());

    document.body.appendChild(this.root);
  }

  private zone(parent: HTMLElement, cls: string): HTMLDivElement {
    const z = document.createElement('div');
    z.className = cls;
    parent.appendChild(z);
    return z;
  }

  private button(parent: HTMLElement, label: string, cls: string, style: string, tap: () => void, on?: () => boolean, visible?: () => boolean, html = false): HTMLElement {
    const b = document.createElement('div');
    b.className = `dx-tbtn ${cls}`;
    b.setAttribute('role', 'button');
    if (html) b.innerHTML = label;
    else b.textContent = label;
    b.style.cssText = style;
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.a.unlockAudio();
      tap();
    });
    parent.appendChild(b);
    this.buttons.push({ el: b, on, visible });
    return b;
  }

  private hold(b: HTMLElement, set: (v: boolean) => void): void {
    b.addEventListener('pointerdown', (e) => {
      b.setPointerCapture(e.pointerId);
      set(true);
    });
    const off = () => set(false);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
  }

  private setStick(dx: number, dy: number): void {
    const d = Math.hypot(dx, dy);
    const k = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
    const x = dx * k, y = dy * k;
    this.knob.style.transform = `translate(${x}px, ${y}px)`;
    // Small dead zone; forward is up the screen.
    const nx = x / STICK_RADIUS, ny = -y / STICK_RADIUS;
    const m = Math.hypot(nx, ny);
    const s = m < 0.12 ? 0 : (m - 0.12) / (0.88 * m);
    this.move.x = nx * s;
    this.move.y = ny * s;
  }

  /** Accumulated look drag since the last call, px */
  takeLook(): { x: number; y: number } | null {
    if (this.lookX === 0 && this.lookY === 0) return null;
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = this.lookY = 0;
    return out;
  }

  /** Sync toggle states and conditional buttons (called by the player a few times a second). */
  refresh(): void {
    const hidden = this.a.state().hidden;
    this.root.classList.toggle('dx-touch-hidden', hidden);
    if (hidden) {
      this.release();
      return;
    }
    for (const b of this.buttons) {
      if (b.on) b.el.classList.toggle('dx-on', b.on());
      if (b.visible) b.el.style.display = b.visible() ? '' : 'none';
    }
  }

  release(): void {
    this.move.x = this.move.y = 0;
    this.up = this.down = false;
    this.lookX = this.lookY = 0;
    this.stickId = this.lookId = -1;
    if (this.firePointer >= 0) {
      this.firePointer = -1;
      this.fireBtn.classList.remove('dx-on');
    }
    this.stick.classList.remove('dx-show');
  }

  dispose(): void {
    this.root.remove();
  }
}
