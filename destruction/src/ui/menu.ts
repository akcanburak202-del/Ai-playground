import type { SceneDef } from '../app/contracts.ts';
import { artKindFor, sceneArt } from './sceneArt.ts';

/**
 * The start / scene menu, set like the cover of an architecture monograph: the live scene is the
 * cover photograph (the sheet darkens only where the type sits), the title and the physics it
 * stands on at the upper left, a plate caption naming the building behind, and the scenes as a
 * row of plates along the foot — elevation drawing, name, the architectural reference, a note.
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

/** Architectural reference of the known scenes (architect or model · place, date). */
const REFERENCE: Record<string, string> = {
  range: 'Kalibrasyon hattı · 25 m',
  chapel: 'Tadao Ando · İbaraki, 1989',
  pavilion: 'Mies van der Rohe · Barselona, 1929',
  tower: 'Çelik iskelet ve giydirme cephe',
  temple: 'Parthenon oranlarında · Dor düzeni',
};

export interface SceneReference {
  /** e.g. "Tadao Ando · İbaraki, 1989" ('' when unknown) */
  reference: string;
  /** The description without the reference it opened with */
  note: string;
}

/**
 * Split a scene blurb into its reference and its description. Blurbs that open with the source,
 * "Tadao Ando’dan (İbaraki, 1989): …", give "Tadao Ando · İbaraki, 1989"; known scenes use the
 * table above. Pure (unit-tested).
 */
export function sceneReference(id: string, blurb: string): SceneReference {
  const m = /^(.{3,60}?)[’']d[ae]n \(([^)]{3,40})\):\s*(.+)$/su.exec(blurb.trim());
  let note = blurb.trim();
  let reference = REFERENCE[id] ?? '';
  if (m) {
    reference ||= `${m[1]} · ${m[2]}`;
    note = m[3]!;
  }
  note = note.charAt(0).toLocaleUpperCase('tr-TR') + note.slice(1);
  return { reference, note };
}

export class Menu {
  readonly el: HTMLDivElement;
  selected = '';
  private cards = new Map<string, HTMLButtonElement>();
  private startBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private loadLine: HTMLDivElement;
  private loadText: HTMLSpanElement;
  private plateIdx: HTMLSpanElement;
  private plateName: HTMLSpanElement;
  private plateRef: HTMLSpanElement;
  private plate: HTMLDivElement;
  private cb: MenuCallbacks;
  private scenes: SceneDef[] = [];
  private current: string | null = null;
  private loading = false;

  constructor(parent: HTMLElement, scenes: readonly SceneDef[], cb: MenuCallbacks) {
    this.cb = cb;
    this.scenes = [...scenes];
    this.el = el('div', 'dx-menu');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Sahne seç');
    const sheet = el('div', 'dx-sheet', undefined, this.el);

    const intro = el('div', 'dx-intro', undefined, sheet);
    el('div', 'dx-over', 'Balistik · Malzeme · Yapı', intro);
    el('h1', 'dx-h1', 'Destruction', intro).lang = 'en';
    el('div', 'dx-h1-sub', 'Mimari yıkım laboratuvarı', intro);
    el('p', 'dx-lead', 'Seçkin mimariyi askeri silahlarla sına. Beton her isabette biraz daha derin oyulur ve donatısı açığa çıkar; çelik ezilir, bükülür, sonunda yırtılır; cam çatlar ya da bin parçaya ayrılır; taşıyıcısını yitiren yapı kademe kademe çöker. Ekrandaki her sayı yayımlanmış bir mühendislik modelinden gelir.', intro);
    const models = el('div', 'dx-models', undefined, intro);
    for (const [k, v] of [
      ['Beton', 'NDRC nüfuz · kavlama ve delinme sınırları'],
      ['Çelik', 'Lambert–Jonas · Lanz–Odermatt · plastik mafsal'],
      ['Patlama', 'Kingery–Bulmash (UFC 3-340-02)'],
      ['Cam', 'Temperli, tavlanmış ve lamine kırılma'],
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
    this.loadLine = el('div', 'dx-loadline', undefined, intro);
    this.loadText = el('span', undefined, '', this.loadLine);
    el('i', 'dx-sweep', undefined, this.loadLine);
    el('div', 'dx-hint', 'Başla: fare kilitlenir, ses açılır · Esc menü · H kontroller · ← → sahne', intro);

    // Plate caption for the cover photograph: the scene that is live behind the sheet.
    this.plate = el('div', 'dx-plate', undefined, sheet);
    el('span', 'dx-lbl', 'Kapak · canlı görüntü', this.plate);
    const pl = el('div', 'dx-plate-line', undefined, this.plate);
    this.plateIdx = el('span', 'dx-num', '', pl);
    this.plateName = el('span', 'dx-plate-name', '', pl);
    this.plateRef = el('span', 'dx-plate-ref', '', this.plate);

    const right = el('div', 'dx-scenes', undefined, sheet);
    const head = el('div', 'dx-scenes-head', undefined, right);
    el('span', 'dx-title', 'Sahneler', head);
    el('span', 'dx-lbl', `${scenes.length} yapı · çift tık: hemen başla`, head);
    const grid = el('div', 'dx-cards', undefined, right);
    this.scenes.forEach((s, i) => {
      const card = el('button', 'dx-scard', undefined, grid);
      card.type = 'button';
      card.innerHTML = sceneArt(artKindFor(s.id, s.name));
      const ref = sceneReference(s.id, s.blurbTr || s.blurb);
      const text = el('div', 'dx-stext', undefined, card);
      el('div', 'dx-idx', `A-${String(i + 1).padStart(2, '0')}`, text);
      el('div', 'dx-sname', s.nameTr || s.name, text);
      if (ref.reference) el('div', 'dx-sref', ref.reference, text);
      el('div', 'dx-sblurb', ref.note, text);
      card.title = s.blurbTr || s.blurb;
      card.addEventListener('click', () => this.select(s.id));
      card.addEventListener('dblclick', () => {
        this.select(s.id);
        this.cb.onStart(s.id);
      });
      this.cards.set(s.id, card);
    });
    if (this.scenes[0]) this.select(this.scenes[0].id);

    this.updatePlate();
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
      if (k === id && !tag) tag = el('span', 'dx-cur', 'Açık', c);
      else if (k !== id) tag?.remove();
    }
    if (id && this.cards.has(id)) this.select(id);
    this.updatePlate();
    this.updateStartLabel();
  }

  setMuted(m: boolean): void {
    this.muteBtn.textContent = m ? 'Ses: kapalı' : 'Ses: açık';
  }

  /** Scene build in progress: the start button waits and a line says what is being built. */
  setLoading(on: boolean, name?: string): void {
    this.loading = on;
    this.startBtn.disabled = on;
    this.el.classList.toggle('dx-loading-on', on);
    this.loadText.textContent = on ? `${(name || 'Sahne').toLocaleUpperCase('tr-TR')} KURULUYOR · ELEMANLAR, DONATI, TAŞIYICI SİSTEM` : '';
    this.el.setAttribute('aria-busy', String(on));
    if (on) this.startBtn.textContent = 'Kuruluyor…';
    else this.updateStartLabel();
  }

  /** Arrow keys move the selection, Enter starts. Returns true if handled. */
  key(code: string): boolean {
    if (this.loading) return code === 'Enter' || code === 'NumpadEnter';
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

  private updatePlate(): void {
    const i = this.scenes.findIndex((s) => s.id === this.current);
    const s = this.scenes[i];
    this.plate.style.display = s ? '' : 'none';
    if (!s) return;
    this.plateIdx.textContent = `A-${String(i + 1).padStart(2, '0')}`;
    this.plateName.textContent = s.nameTr || s.name;
    this.plateRef.textContent = sceneReference(s.id, s.blurbTr || s.blurb).reference;
  }

  private updateStartLabel(): void {
    if (this.startBtn.disabled) return;
    this.startBtn.textContent = this.current && this.current === this.selected ? 'Devam' : 'Başla';
  }

  dispose(): void {
    this.el.remove();
  }
}
