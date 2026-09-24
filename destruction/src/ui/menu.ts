import type { SceneDef } from '../app/contracts.ts';
import { artKindFor, sceneArt } from './sceneArt.ts';

/**
 * The start / scene menu, laid out as a drawing sheet: title and the physics it stands on at the
 * left, the scenes as elevation drawings at the right, a title block in the corner.
 */

export interface MenuCallbacks {
  onStart(sceneId: string): void;
  onHelp(): void;
  onMute(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export class Menu {
  readonly el: HTMLDivElement;
  selected = '';
  private cards = new Map<string, HTMLButtonElement>();
  private startBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private cb: MenuCallbacks;
  private scenes: SceneDef[] = [];
  private current: string | null = null;

  constructor(parent: HTMLElement, scenes: readonly SceneDef[], cb: MenuCallbacks) {
    this.cb = cb;
    this.el = el('div', 'dx-menu');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Sahne seç');
    const sheet = el('div', 'dx-sheet', undefined, this.el);

    const intro = el('div', 'dx-intro', undefined, sheet);
    el('div', 'dx-over', 'Balistik · Malzeme · Yapı', intro);
    el('h1', 'dx-h1', 'Destruction', intro).lang = 'en';
    el('div', 'dx-h1-sub', 'Mimari yıkım laboratuvarı', intro);
    el('p', 'dx-lead', 'Seçkin mimariyi askeri silahlarla sına: beton her isabette biraz daha derin oyulur, çelik göçer, bükülür ve sonunda yırtılır; cam çatlar ya da tanelenir; yapılar taşıyıcılarını kaybedince çöker. Ekrandaki her sayı yayımlanmış bir mühendislik modelinden gelir.', intro);
    const models = el('div', 'dx-models', undefined, intro);
    for (const [k, v] of [
      ['Beton', 'NDRC nüfuz · kavlama sınırları'],
      ['Çelik', 'Lambert–Jonas · Lanz–Odermatt'],
      ['Patlama', 'Kingery–Bulmash (UFC 3-340-02)'],
      ['Cam', 'Temperli / tavlanmış / lamine kırılma'],
    ] as const) {
      el('span', 'dx-lbl', k, models);
      el('span', undefined, v, models);
    }
    const actions = el('div', 'dx-actions', undefined, intro);
    this.startBtn = el('button', 'dx-btn dx-primary', 'Başla', actions);
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => this.cb.onStart(this.selected));
    const help = el('button', 'dx-btn', 'Kontroller', actions);
    help.type = 'button';
    help.addEventListener('click', () => this.cb.onHelp());
    this.muteBtn = el('button', 'dx-btn', 'Ses: açık', actions);
    this.muteBtn.type = 'button';
    this.muteBtn.addEventListener('click', () => this.cb.onMute());
    el('div', 'dx-hint', 'Başla’ya bas: fare kilitlenir, ses açılır. Esc menüye döner · H kontroller.', intro);

    const right = el('div', 'dx-scenes', undefined, sheet);
    const head = el('div', 'dx-scenes-head', undefined, right);
    el('span', 'dx-title', 'Sahne seç', head);
    el('span', 'dx-lbl', `${scenes.length} sahne`, head);
    const grid = el('div', 'dx-cards', undefined, right);
    this.scenes = [...scenes];
    this.scenes.forEach((s, i) => {
      const card = el('button', 'dx-scard', undefined, grid);
      card.type = 'button';
      card.innerHTML = sceneArt(artKindFor(s.id, s.name));
      el('div', 'dx-idx', `A-${String(i + 1).padStart(2, '0')}`, card);
      el('div', 'dx-sname', s.nameTr || s.name, card);
      el('div', 'dx-sblurb', s.blurbTr || s.blurb, card);
      card.addEventListener('click', () => this.select(s.id));
      card.addEventListener('dblclick', () => {
        this.select(s.id);
        this.cb.onStart(s.id);
      });
      this.cards.set(s.id, card);
    });
    if (this.scenes[0]) this.select(this.scenes[0].id);

    const tb = el('div', 'dx-titleblock', undefined, sheet);
    for (const [k, v] of [['Proje', 'DESTRUCTION'], ['Pafta', 'A-00 / SAHNELER'], ['Ölçek', '1:1'], ['Birim', 'SI · m, kg, s']] as const) {
      const c = el('div', undefined, undefined, tb);
      el('span', 'dx-lbl', k, c);
      el('span', 'dx-num', v, c);
    }
    parent.appendChild(this.el);
  }

  get visible(): boolean {
    return this.el.classList.contains('dx-show');
  }

  show(on: boolean): void {
    this.el.classList.toggle('dx-show', on);
    if (on) (this.cards.get(this.selected) ?? this.startBtn).focus({ preventScroll: true });
  }

  select(id: string): void {
    if (!this.cards.has(id)) return;
    this.selected = id;
    for (const [k, c] of this.cards) {
      c.classList.toggle('dx-on', k === id);
      c.setAttribute('aria-pressed', String(k === id));
    }
    this.updateStartLabel();
  }

  /** Mark the scene that is loaded (its card says so; Başla then resumes). */
  setCurrent(id: string | null): void {
    this.current = id;
    for (const [k, c] of this.cards) {
      let tag = c.querySelector('.dx-cur');
      if (k === id && !tag) tag = el('span', 'dx-cur', 'Yüklü', c);
      else if (k !== id) tag?.remove();
    }
    if (id && this.cards.has(id)) this.select(id);
    this.updateStartLabel();
  }

  setMuted(m: boolean): void {
    this.muteBtn.textContent = m ? 'Ses: kapalı' : 'Ses: açık';
  }

  setLoading(on: boolean): void {
    this.startBtn.disabled = on;
    if (on) this.startBtn.textContent = 'Yükleniyor…';
    else this.updateStartLabel();
  }

  /** Arrow keys move the selection, Enter starts. Returns true if handled. */
  key(code: string): boolean {
    const ids = this.scenes.map((s) => s.id);
    const i = ids.indexOf(this.selected);
    if (code === 'ArrowRight' || code === 'ArrowDown') {
      this.select(ids[(i + 1) % ids.length]!);
      this.cards.get(this.selected)?.focus({ preventScroll: false });
      return true;
    }
    if (code === 'ArrowLeft' || code === 'ArrowUp') {
      this.select(ids[(i - 1 + ids.length) % ids.length]!);
      this.cards.get(this.selected)?.focus({ preventScroll: false });
      return true;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      // Enter on another focused button (Kontroller, Ses) is that button's click, not a start.
      const a = document.activeElement;
      if (a instanceof HTMLButtonElement && a !== this.startBtn && ![...this.cards.values()].includes(a)) return false;
      if (a === this.startBtn) return false;
      for (const [id, c] of this.cards) if (c === a) this.select(id);
      this.cb.onStart(this.selected);
      return true;
    }
    return false;
  }

  private updateStartLabel(): void {
    if (this.startBtn.disabled) return;
    this.startBtn.textContent = this.current && this.current === this.selected ? 'Devam' : 'Başla';
  }

  dispose(): void {
    this.el.remove();
  }
}
