/**
 * Visual language of the overlay: an architectural drawing sheet crossed with firing-range
 * telemetry. Hairline rules, dimension lines with end ticks, letter-spaced small capitals,
 * tabular numerals, smoked-glass panels, one accent — tracer amber — for live values.
 * CSS and web fonts are injected once per document.
 */

export const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@400;500;600&family=Archivo:wght@400;500;600&family=Big+Shoulders+Display:wght@500;700;800&family=Martian+Mono:wdth,wght@75..112.5,300..600&display=swap';

const STYLE_ID = 'dx-ui-style';
const FONT_ID = 'dx-ui-fonts';

export function ensureFonts(doc: Document = document, bust = ''): void {
  if (!doc.getElementById('dx-ui-preconnect')) {
    for (const [href, cross] of [['https://fonts.googleapis.com', false], ['https://fonts.gstatic.com', true]] as const) {
      const l = doc.createElement('link');
      l.rel = 'preconnect';
      l.href = href;
      if (cross) l.crossOrigin = 'anonymous';
      if (!cross) l.id = 'dx-ui-preconnect';
      doc.head.appendChild(l);
    }
  }
  const old = doc.getElementById(FONT_ID);
  if (old && !bust) return;
  old?.remove();
  const link = doc.createElement('link');
  link.id = FONT_ID;
  link.rel = 'stylesheet';
  link.href = bust ? `${FONT_HREF}&v=${encodeURIComponent(bust)}` : FONT_HREF;
  doc.head.appendChild(link);
}

export function ensureStyle(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

const CSS = /* css */ `
.dx-root {
  --ink: #efe9df;
  --ink-2: rgba(239, 233, 223, 0.72);
  --ink-3: rgba(239, 233, 223, 0.46);
  --ink-4: rgba(239, 233, 223, 0.26);
  --rule: rgba(239, 233, 223, 0.15);
  --rule-2: rgba(239, 233, 223, 0.3);
  --glass: rgba(27, 24, 21, 0.6);
  --glass-2: rgba(18, 16, 14, 0.78);
  --amber: #ffb547;
  --amber-2: rgba(255, 181, 71, 0.55);
  --amber-3: rgba(255, 181, 71, 0.16);
  --warn: #ff7a45;
  --f-display: 'Big Shoulders Display', 'Oswald', 'Bebas Neue', 'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif;
  --f-label: 'Archivo Narrow', 'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif;
  --f-text: 'Archivo', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif;
  --f-mono: 'Martian Mono', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
  --pad: 16px;
  position: fixed; inset: 0; z-index: 20; pointer-events: none; overflow: hidden;
  color: var(--ink); font-family: var(--f-text); font-size: 12px; line-height: 1.35;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
}
.dx-root *, .dx-root *::before, .dx-root *::after { box-sizing: border-box; }
.dx-root button { font: inherit; color: inherit; }

/* ── Type ─────────────────────────────────────────────────────────────── */
.dx-lbl {
  font-family: var(--f-label); font-weight: 500; font-size: 10px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--ink-3); white-space: nowrap;
}
.dx-num {
  font-family: var(--f-mono); font-stretch: 87.5%; font-weight: 400; font-size: 11px;
  font-variant-numeric: tabular-nums; letter-spacing: -0.01em; white-space: nowrap;
}
.dx-live { color: var(--amber); }
.dx-dim { color: var(--ink-3); }

/* ── Panels: smoked glass with registration corners ───────────────────── */
.dx-panel {
  position: absolute; background: var(--glass); border: 1px solid var(--rule);
  -webkit-backdrop-filter: blur(14px) saturate(1.15); backdrop-filter: blur(14px) saturate(1.15);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
}
.dx-panel::before, .dx-panel::after {
  content: ''; position: absolute; width: 7px; height: 7px; pointer-events: none;
  border-color: var(--rule-2); border-style: solid;
}
.dx-panel::before { top: -4px; left: -4px; border-width: 1px 0 0 1px; }
.dx-panel::after { bottom: -4px; right: -4px; border-width: 0 1px 1px 0; }
.dx-hr { height: 1px; background: var(--rule); margin: 8px 0; }

/* Dimension line: |<—— label ——>| */
.dx-dimline { position: relative; display: flex; align-items: center; gap: 8px; height: 12px; margin: 6px 0 8px; }
.dx-dimline::before, .dx-dimline::after { content: ''; flex: 1; height: 1px; background: var(--rule-2); }
.dx-dimline > span { font-family: var(--f-mono); font-stretch: 87.5%; font-size: 10px; color: var(--ink-2); white-space: nowrap; }
.dx-dimline > i { position: absolute; top: 1px; width: 1px; height: 10px; background: var(--rule-2); }
.dx-dimline > i:first-of-type { left: 0; }
.dx-dimline > i:last-of-type { right: 0; }

/* ── Sheet header (status bar) ─────────────────────────────────────────── */
.dx-top {
  position: absolute; left: 0; right: 0; top: 0; height: 30px; display: flex; align-items: center;
  padding: 0 var(--pad); gap: 14px;
  background: linear-gradient(rgba(14, 12, 10, 0.55), rgba(14, 12, 10, 0.0));
}
.dx-top .dx-brand { font-family: var(--f-display); font-weight: 700; font-size: 15px; letter-spacing: 0.22em; color: var(--ink); text-transform: uppercase; }
.dx-top .dx-scene { font-family: var(--f-label); font-size: 11px; letter-spacing: 0.12em; color: var(--ink-2); text-transform: uppercase; }
.dx-top .dx-sep { width: 1px; height: 12px; background: var(--rule-2); }
.dx-top .dx-grow { flex: 1; }
.dx-stat { display: flex; align-items: baseline; gap: 6px; }
.dx-stat .dx-num { color: var(--ink); }
.dx-ruler {
  position: absolute; left: 0; right: 0; top: 30px; height: 6px; opacity: 0.5;
  background:
    repeating-linear-gradient(90deg, var(--rule-2) 0 1px, transparent 1px 80px) 0 0 / 100% 6px no-repeat,
    repeating-linear-gradient(90deg, var(--rule) 0 1px, transparent 1px 16px) 0 0 / 100% 3px no-repeat;
}
.dx-slowmo-tag { color: var(--amber); font-family: var(--f-label); font-weight: 600; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; }

/* ── Telemetry: the newest impact large, older ones one line each, fading ── */
.dx-tele { right: var(--pad); top: 44px; width: 316px; padding: 9px 12px 10px; transition: opacity 0.8s ease; }
.dx-tele.dx-idle { opacity: 0.5; }
.dx-tele.dx-idle .dx-older, .dx-tele.dx-idle .dx-latest .dx-tr { display: none !important; }
.dx-tele-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.dx-tele-head .dx-title { font-family: var(--f-label); font-weight: 600; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; }
.dx-latest { position: relative; margin: 0 -12px; padding: 2px 12px 0 12px; }
.dx-latest::before { content: ''; position: absolute; left: 0; top: 4px; height: 13px; width: 2px; background: var(--amber); }
.dx-row-1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dx-row-1 .dx-ammo { font-family: var(--f-label); font-weight: 600; font-size: 12px; letter-spacing: 0.02em; white-space: nowrap; }
.dx-row-1 .dx-mat { font-family: var(--f-text); font-size: 11.5px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.dx-cnt { font-size: 10px; color: var(--amber); }
.dx-follow { display: block; margin-top: 2px; font-family: var(--f-label); font-size: 10px; letter-spacing: 0.06em; color: var(--ink-3); }
.dx-big { display: grid; grid-template-columns: auto 1fr; gap: 14px; align-items: end; margin-top: 6px; }
.dx-depth .dx-lbl { display: block; font-size: 8.5px; }
.dx-depth b { display: block; font-family: var(--f-display); font-weight: 700; font-size: 34px; line-height: 0.9; letter-spacing: 0.01em; color: var(--amber); white-space: nowrap; margin-top: 2px; }
.dx-vals { display: grid; grid-template-columns: 1fr; gap: 1px; padding-bottom: 1px; min-width: 0; }
.dx-vals div { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; border-bottom: 1px solid var(--rule); padding-bottom: 1px; min-width: 0; }
.dx-vals .dx-lbl { font-size: 8.5px; letter-spacing: 0.12em; }
.dx-vals .dx-num { font-size: 10.5px; color: var(--ink); }
.dx-tag {
  font-family: var(--f-label); font-weight: 600; font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
  padding: 1px 5px; border: 1px solid var(--rule-2); color: var(--ink-2); white-space: nowrap;
}
.dx-tag.dx-perforate { border-color: var(--amber-2); color: var(--amber); }
.dx-tag.dx-ricochet { border-style: dashed; }
.dx-tag.dx-shatter { color: var(--ink); }
.dx-latest .dx-tr { margin-top: 6px; font-size: 11px; line-height: 1.4; color: var(--ink-2); }
.dx-group { margin-top: 7px; }
.dx-group-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.dx-group-head .dx-lbl { color: var(--ink-2); font-size: 9px; }
.dx-group-head .dx-num { color: var(--amber); font-size: 10.5px; }
.dx-section { position: relative; height: 22px; margin-top: 4px; }
.dx-band {
  position: absolute; left: 0; right: 0; top: 0;
  background: repeating-linear-gradient(135deg, rgba(239, 233, 223, 0.28) 0 1px, transparent 1px 5px);
  -webkit-mask-image: linear-gradient(#000 55%, transparent); mask-image: linear-gradient(#000 55%, transparent);
}
.dx-band.dx-back { -webkit-mask-image: none; mask-image: none; border-bottom: 1px dashed var(--ink-2); }
.dx-section svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.dx-section .c { fill: rgba(14, 12, 10, 0.9); }
.dx-section .p { fill: none; stroke: var(--amber); stroke-width: 1.25; vector-effect: non-scaling-stroke; }
.dx-section .s { stroke: var(--ink); stroke-width: 1; vector-effect: non-scaling-stroke; }
.dx-group-note { margin-top: 3px; font-family: var(--f-mono); font-stretch: 87.5%; font-size: 9.5px; color: var(--ink-2); }
/* The resolver's own model line: only with the detail open (I held). */
.dx-latest .dx-model { display: none; font-family: var(--f-mono); font-stretch: 80%; font-size: 9px; color: var(--ink-3); margin-top: 5px; line-height: 1.4; overflow-wrap: anywhere; }
.dx-root.dx-detailed .dx-latest .dx-model { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.dx-older { margin-top: 7px; padding-top: 3px; border-top: 1px solid var(--rule); }
.dx-orow { display: flex; align-items: baseline; gap: 7px; padding: 2px 0; min-width: 0; color: var(--ink-2); }
.dx-orow:nth-child(1) { opacity: 0.8; }
.dx-orow:nth-child(2) { opacity: 0.56; }
.dx-orow:nth-child(3) { opacity: 0.36; }
.dx-orow .dx-ammo { font-family: var(--f-label); font-weight: 600; font-size: 11px; white-space: nowrap; }
.dx-orow .dx-ammo.dx-followed { font-weight: 500; color: var(--ink-3); letter-spacing: 0.04em; }
.dx-orow .dx-mat { font-size: 10.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dx-orow .dx-num { font-size: 10px; }
.dx-orow .dx-cnt { color: var(--ink-3); }
.dx-orow .dx-tag { font-size: 8.5px; padding: 0 4px; }
.dx-empty { padding: 0 0 2px; color: var(--ink-3); font-size: 11px; line-height: 1.4; }
.dx-blast { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--rule); }
.dx-blast .dx-tele-head { margin-bottom: 4px; }
.dx-blast-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px 12px; }
.dx-blast-grid div { display: flex; flex-direction: column; min-width: 0; }
.dx-blast-grid .dx-lbl { font-size: 8.5px; letter-spacing: 0.12em; }
.dx-blast .dx-v { font-family: var(--f-mono); font-stretch: 87.5%; font-size: 10.5px; color: var(--amber); white-space: nowrap; }
.dx-blast .dx-note { margin-top: 4px; font-size: 10.5px; color: var(--ink-2); }
.dx-blast .dx-note.dx-warn { color: var(--warn); }

/* ── Dock: weapon list over the weapon card, bottom left ──────────────── */
.dx-dock { position: absolute; left: var(--pad); bottom: var(--pad); display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.dx-dock > .dx-panel { position: relative; }

/* ── Weapon card: collapsed by default, full specification on I ─────── */
.dx-card { width: 320px; padding: 8px 12px 10px; transition: opacity 0.2s ease; }
/* Touch screens: tap the card for the full specification, tap a group number to switch weapons. */
.dx-root.dx-is-touch .dx-card { pointer-events: auto; cursor: pointer; }
.dx-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dx-slotcaps { display: flex; gap: 2px; }
.dx-slotcaps .dx-key { min-width: 13px; height: 13px; padding: 0 2px; font-size: 8px; color: var(--ink-3); border-color: var(--rule); }
.dx-slotcaps .dx-key.dx-on { color: #1a140c; background: var(--amber); border-color: var(--amber); }
.dx-card-head .dx-cat { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; font-family: var(--f-mono); font-stretch: 87.5%; font-size: 9.5px; color: var(--ink-2); }
.dx-key { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px; border: 1px solid var(--rule-2); font-family: var(--f-mono); font-size: 9.5px; color: var(--ink-2); }
.dx-card-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-top: 5px; min-width: 0; }
.dx-wname { font-family: var(--f-display); font-weight: 700; font-size: 28px; line-height: 0.95; letter-spacing: 0.01em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
.dx-card-ammo { display: flex; align-items: center; gap: 4px; flex-shrink: 0; margin-left: auto; }
.dx-card-ammo .dx-key { min-width: 14px; height: 14px; font-size: 8.5px; }
.dx-card-sum { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-top: 5px; }
.dx-sumline { font-family: var(--f-mono); font-stretch: 87.5%; font-size: 10px; line-height: 1.45; color: var(--ink-2); min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dx-card-sum .dx-num { font-size: 10px; flex-shrink: 0; }
.dx-coolline { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--rule); }
.dx-coolline > b { display: block; height: 100%; background: var(--amber); width: 100%; }
.dx-card-more { display: none; margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--rule); }
.dx-card.dx-detail { width: 372px; }
.dx-card.dx-detail .dx-card-more { display: block; }
.dx-card-top { display: flex; justify-content: space-between; align-items: baseline; }
.dx-role { font-size: 11.5px; color: var(--ink-2); min-width: 0; }
.dx-card-more .dx-card-top { gap: 10px; }
.dx-card-more .dx-stat .dx-lbl { font-size: 8.5px; }
.dx-ammo-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.dx-pill { font-family: var(--f-label); font-weight: 500; font-size: 10.5px; letter-spacing: 0.06em; padding: 1px 7px; border: 1px solid var(--rule); color: var(--ink-3); white-space: nowrap; }
.dx-pill.dx-on { border-color: var(--amber-2); color: var(--amber); background: var(--amber-3); }
.dx-ammo-line { margin-top: 6px; font-size: 11px; line-height: 1.4; color: var(--ink-2); }
.dx-specs { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 14px; margin-top: 8px; }
.dx-spec { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; border-bottom: 1px solid var(--rule); padding-bottom: 2px; min-width: 0; }
.dx-spec .dx-num { font-size: 10.5px; color: var(--ink); }
.dx-spec .dx-lbl { font-size: 8.5px; letter-spacing: 0.12em; overflow: hidden; text-overflow: ellipsis; }
.dx-spec.dx-hi .dx-num { color: var(--amber); }
.dx-charges { font-size: 11px; color: var(--ink-2); margin-top: 5px; }
.dx-charges b { color: var(--amber); font-family: var(--f-mono); font-weight: 400; }

/* ── Weapon list: shows on a weapon change and with the detail ─────────── */
.dx-strip {
  width: 320px; padding: 5px 0 4px; opacity: 0; visibility: hidden; transform: translateY(6px);
  transition: opacity 0.35s ease, transform 0.35s ease, visibility 0s linear 0.35s;
}
.dx-strip.dx-show { opacity: 1; visibility: visible; transform: none; transition: opacity 0.12s ease, transform 0.18s ease, visibility 0s; }
.dx-slot { display: grid; grid-template-columns: 18px 62px 1fr auto; align-items: center; gap: 6px; padding: 1px 10px; color: var(--ink-3); }
.dx-slot .dx-key { min-width: 14px; height: 14px; font-size: 8.5px; }
.dx-slot .dx-lbl { font-size: 8.5px; }
.dx-slot .dx-sname { font-family: var(--f-label); font-size: 11.5px; font-weight: 500; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dx-slot .dx-count { font-family: var(--f-mono); font-size: 8.5px; color: var(--ink-4); }
.dx-slot.dx-on { color: var(--ink); background: linear-gradient(90deg, var(--amber-3), transparent); }
.dx-slot.dx-on .dx-key { border-color: var(--amber); color: var(--amber); }
.dx-slot.dx-on .dx-lbl { color: var(--amber); }
.dx-subs { padding: 1px 10px 3px 96px; display: flex; flex-wrap: wrap; gap: 2px 10px; }
.dx-sub { font-family: var(--f-label); font-size: 10.5px; color: var(--ink-3); white-space: nowrap; }
.dx-sub.dx-on { color: var(--amber); }
.dx-sub.dx-on::before { content: '▸ '; }
.dx-strip-foot { margin: 4px 10px 0; padding-top: 4px; border-top: 1px solid var(--rule); font-family: var(--f-label); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }

/* ── Key hints under the view (first seconds of play, and with the detail) ─ */
/* Bottom right, clear of the dock (the weapon card) at the left. */
.dx-keys {
  position: absolute; right: var(--pad); bottom: var(--pad); max-width: calc(100% - 420px); display: flex; gap: 6px 14px; flex-wrap: wrap; justify-content: flex-end;
  padding: 5px 12px; background: rgba(18, 16, 14, 0.5); border: 1px solid var(--rule); white-space: nowrap;
  font-family: var(--f-label); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2);
  animation: dx-fade 0.3s ease-out;
}
.dx-khint { display: flex; align-items: center; gap: 5px; }
.dx-khint .dx-cap { font-size: 9px; padding: 0 4px; letter-spacing: 0; text-transform: none; }

/* ── Scene build in progress (reload) ──────────────────────────────────── */
.dx-loading {
  position: absolute; left: 50%; top: 44px; transform: translateX(-50%); padding: 7px 14px 9px; overflow: hidden;
  font-family: var(--f-label); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; white-space: nowrap;
}
.dx-sweep { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; overflow: hidden; }
.dx-sweep::after { content: ''; position: absolute; top: 0; bottom: 0; width: 30%; background: var(--amber); animation: dx-sweep 1.4s cubic-bezier(.6, 0, .4, 1) infinite; }
@keyframes dx-sweep { from { transform: translateX(-100%); } to { transform: translateX(340%); } }

/* ── Crosshair / reticles ──────────────────────────────────────────────── */
.dx-reticle { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.dx-reticle svg { position: absolute; overflow: visible; left: 0; top: 0; }
.dx-reticle .o { stroke: rgba(10, 8, 6, 0.55); stroke-width: 3.2; fill: none; stroke-linecap: square; }
.dx-reticle .a { stroke: var(--amber); stroke-width: 1.3; fill: none; stroke-linecap: square; }
.dx-reticle .af { fill: var(--amber); stroke: rgba(10, 8, 6, 0.55); stroke-width: 1; }
.dx-reticle .s { stroke: var(--ink-2); stroke-width: 1; fill: none; stroke-dasharray: 2 3; }
.dx-readout {
  position: absolute; left: 50%; top: 50%; transform: translate(26px, 14px); white-space: nowrap;
  font-family: var(--f-mono); font-stretch: 87.5%; font-size: 10.5px; color: var(--amber);
  text-shadow: 0 0 3px rgba(0, 0, 0, 0.8), 0 1px 1px rgba(0, 0, 0, 0.6);
}
.dx-readout .dx-lbl { color: var(--ink-2); text-shadow: 0 0 3px rgba(0, 0, 0, 0.9); margin-right: 5px; }
.dx-readout div + div { margin-top: 2px; }
.dx-hit { position: absolute; left: 50%; top: 50%; opacity: 0; transition: opacity 0.18s ease-out; }
.dx-hit.dx-show { opacity: 1; transition: none; }

/* Lite panels: no backdrop blur (see Hud.setLite), a denser tint instead. */
.dx-root.dx-lite .dx-panel { -webkit-backdrop-filter: none; backdrop-filter: none; background: rgba(24, 21, 18, 0.82); }
.dx-root.dx-lite .dx-menu::before { -webkit-backdrop-filter: none; backdrop-filter: none; }

/* Clean view: only the reticle (and transient messages) remain. */
.dx-root.dx-clean :is(.dx-top, .dx-ruler, .dx-tele, .dx-dock, .dx-readout, .dx-keys) { display: none; }

/* With the menu up, the play HUD is not drawn under the translucent sheet. */
.dx-root.dx-menu-open :is(.dx-top, .dx-ruler, .dx-tele, .dx-dock, .dx-strip, .dx-reticle, .dx-readout, .dx-hit, .dx-banner, .dx-scope, .dx-lockhint, .dx-frame, .dx-keys, .dx-loading) { visibility: hidden; }
.dx-touch-hidden { display: none !important; }

/* Looking through a scope, the panels step back. */
.dx-root.dx-scoped :is(.dx-card, .dx-top, .dx-ruler) { opacity: 0.32; }
.dx-root.dx-scoped :is(.dx-tele, .dx-strip) { opacity: 0.1; }
.dx-top { transition: opacity 0.2s ease; }

/* Scope: dark field outside a round (rifle) or rectangular (missile CLU) aperture */
.dx-scope { position: absolute; inset: 0; opacity: 0; display: none; }
.dx-scope svg { position: absolute; inset: 0; width: 100%; height: 100%; }

/* ── Overlays ──────────────────────────────────────────────────────────── */
.dx-banner {
  position: absolute; left: 50%; top: 44px; transform: translateX(-50%); padding: 6px 14px;
  font-family: var(--f-label); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; white-space: nowrap;
}
.dx-banner .dx-num { margin-left: 8px; color: var(--amber); text-transform: none; letter-spacing: 0; }
.dx-toast {
  position: absolute; left: 50%; top: 21%; transform: translate(-50%, 0); padding: 6px 14px;
  font-family: var(--f-label); font-weight: 500; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
  opacity: 0; transition: opacity 0.35s ease, transform 0.35s ease; white-space: nowrap; z-index: 4;
}
.dx-toast.dx-show { opacity: 1; transform: translate(-50%, -6px); transition: opacity 0.08s ease, transform 0.2s ease; }
.dx-toast.dx-accent { color: var(--amber); border-color: var(--amber-2); }
.dx-lockhint {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, 96px); padding: 7px 14px;
  font-family: var(--f-label); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink);
}
.dx-frame { position: absolute; inset: 14px; pointer-events: none; opacity: 0; transition: opacity 0.4s ease; }
.dx-frame.dx-show { opacity: 1; }
.dx-frame i { position: absolute; width: 26px; height: 26px; border: 0 solid var(--amber-2); }
.dx-frame i:nth-child(1) { left: 0; top: 0; border-width: 1px 0 0 1px; }
.dx-frame i:nth-child(2) { right: 0; top: 0; border-width: 1px 1px 0 0; }
.dx-frame i:nth-child(3) { left: 0; bottom: 0; border-width: 0 0 1px 1px; }
.dx-frame i:nth-child(4) { right: 0; bottom: 0; border-width: 0 1px 1px 0; }

/* ── Help ──────────────────────────────────────────────────────────────── */
.dx-help { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(760px, calc(100vw - 32px)); padding: 18px 22px 20px; background: var(--glass-2); pointer-events: auto; display: none; z-index: 3; }
.dx-help.dx-show { display: block; }
.dx-help-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.dx-help-head .dx-btn { padding: 6px 12px; font-size: 10.5px; }
.dx-help h2 { margin: 0; font-family: var(--f-display); font-weight: 700; font-size: 28px; letter-spacing: 0.06em; text-transform: uppercase; }
.dx-help-cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
.dx-help-col .dx-lbl { display: block; margin-bottom: 8px; color: var(--amber); }
.dx-help-row { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; border-top: 1px solid var(--rule); align-items: baseline; }
.dx-help-row span { font-size: 11.5px; color: var(--ink-2); }
.dx-caps { display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end; flex-shrink: 0; max-width: 55%; }
.dx-cap { font-family: var(--f-mono); font-stretch: 87.5%; font-size: 9.5px; padding: 1px 5px; border: 1px solid var(--rule-2); color: var(--ink); white-space: nowrap; }
.dx-help-foot { margin-top: 14px; font-size: 11px; color: var(--ink-3); }
.dx-root.dx-is-touch .dx-help-desk, .dx-root:not(.dx-is-touch) .dx-help-touch { display: none; }
.dx-help-touch { grid-template-columns: 1fr; }

/* ── Menu: the cover of a monograph over the live scene ────────────────── */
.dx-menu {
  position: absolute; inset: 0; pointer-events: auto; overflow: auto; display: none;
  /* Dark only where the type sits: the live scene is the cover photograph. */
  background:
    linear-gradient(90deg, rgba(12, 11, 10, 0.9) 0%, rgba(12, 11, 10, 0.74) 30%, rgba(12, 11, 10, 0.18) 58%, rgba(12, 11, 10, 0) 78%),
    linear-gradient(0deg, rgba(12, 11, 10, 0.92) 0%, rgba(12, 11, 10, 0.6) 26%, rgba(12, 11, 10, 0) 48%);
}
.dx-menu.dx-show { display: block; animation: dx-fade 0.25s ease-out; }
@keyframes dx-fade { from { opacity: 0; } to { opacity: 1; } }
.dx-sheet {
  position: relative; min-height: 100%; padding: 40px 48px 36px; display: grid;
  grid-template-columns: minmax(320px, 520px) 1fr; grid-template-rows: auto 1fr auto; column-gap: 44px;
  grid-template-areas: 'intro plate' 'intro .' 'scenes scenes';
}
.dx-sheet::before { content: ''; position: absolute; inset: 18px; border: 1px solid var(--rule); pointer-events: none; }
.dx-sheet::after {
  content: ''; position: absolute; left: 18px; right: 18px; top: 18px; height: 8px; pointer-events: none;
  background:
    repeating-linear-gradient(90deg, var(--rule-2) 0 1px, transparent 1px 96px) 0 0 / 100% 8px no-repeat,
    repeating-linear-gradient(90deg, var(--rule) 0 1px, transparent 1px 12px) 0 0 / 100% 4px no-repeat;
}
.dx-intro { grid-area: intro; display: flex; flex-direction: column; padding-top: 10px; text-shadow: 0 1px 12px rgba(0, 0, 0, 0.35); }
.dx-over { font-family: var(--f-label); font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--amber); }
.dx-h1 { margin: 8px 0 0; font-family: var(--f-display); font-weight: 800; font-size: clamp(56px, 7.2vw, 112px); line-height: 0.86; letter-spacing: 0.005em; text-transform: uppercase; }
.dx-h1-sub { margin-top: 10px; font-family: var(--f-display); font-weight: 500; font-size: 22px; letter-spacing: 0.04em; color: var(--ink-2); }
.dx-lead { margin: 14px 0 0; max-width: 470px; font-size: 13px; line-height: 1.55; color: var(--ink-2); }
.dx-models { margin-top: 12px; display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; max-width: 470px; }
.dx-models .dx-lbl { font-size: 9.5px; }
.dx-models span:not(.dx-lbl) { font-size: 11px; color: var(--ink-2); }
.dx-actions { margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.dx-btn {
  pointer-events: auto; cursor: pointer; border: 1px solid var(--rule-2); background: rgba(18, 16, 14, 0.35); padding: 10px 16px;
  font-family: var(--f-label) !important; font-weight: 600; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.dx-btn:hover { border-color: var(--ink-2); background: rgba(239, 233, 223, 0.08); }
.dx-btn:focus-visible { outline: 1px solid var(--amber); outline-offset: 3px; }
.dx-btn.dx-primary { border-color: var(--amber); color: #1a140c; background: var(--amber); padding: 12px 30px; font-size: 13px; min-width: 148px; }
.dx-btn.dx-primary:hover { background: #ffc467; }
.dx-btn[disabled] { opacity: 0.75; cursor: progress; }
.dx-loadline { position: relative; display: none; margin-top: 12px; padding-bottom: 6px; max-width: 470px; font-family: var(--f-label); font-size: 10.5px; letter-spacing: 0.16em; color: var(--amber); overflow: hidden; }
.dx-menu.dx-loading-on .dx-loadline { display: block; }
.dx-loadline .dx-sweep { background: var(--rule); height: 1px; }
.dx-hint { margin-top: 12px; font-size: 11px; color: var(--ink-3); }
.dx-plate { grid-area: plate; justify-self: end; align-self: start; margin-top: 12px; text-align: right; display: flex; flex-direction: column; gap: 3px; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.55); }
.dx-plate .dx-lbl { color: var(--ink-2); font-size: 9px; }
.dx-plate-line { display: flex; gap: 10px; align-items: baseline; justify-content: flex-end; }
.dx-plate-line .dx-num { color: var(--amber); font-size: 10px; }
.dx-plate-name { font-family: var(--f-display); font-weight: 700; font-size: 22px; letter-spacing: 0.03em; text-transform: uppercase; }
.dx-plate-ref { font-family: var(--f-label); font-size: 11px; letter-spacing: 0.1em; color: var(--ink-2); text-transform: uppercase; }
.dx-scenes { grid-area: scenes; margin-top: 18px; }
.dx-scenes-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; padding-top: 8px; border-top: 1px solid var(--rule-2); }
.dx-scenes-head .dx-title { font-family: var(--f-label); font-weight: 600; font-size: 11px; letter-spacing: 0.26em; text-transform: uppercase; }
.dx-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
.dx-scard {
  position: relative; cursor: pointer; text-align: left; padding: 8px 10px 10px; background: rgba(20, 18, 16, 0.62);
  border: 1px solid var(--rule); transition: border-color 0.15s ease, background 0.15s ease; pointer-events: auto;
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
}
.dx-scard:hover { border-color: var(--rule-2); background: rgba(33, 30, 26, 0.74); }
.dx-scard:focus-visible { outline: 1px solid var(--amber); outline-offset: 2px; }
.dx-scard.dx-on { border-color: var(--amber-2); background: rgba(40, 33, 24, 0.78); }
.dx-scard.dx-on::before, .dx-scard.dx-on::after { content: ''; position: absolute; width: 10px; height: 10px; border: 0 solid var(--amber); }
.dx-scard.dx-on::before { left: -1px; top: -1px; border-width: 2px 0 0 2px; }
.dx-scard.dx-on::after { right: -1px; bottom: -1px; border-width: 0 2px 2px 0; }
.dx-scard svg { display: block; width: 100%; height: 64px; }
.dx-scard .dx-idx { font-family: var(--f-mono); font-size: 9px; color: var(--ink-3); margin-top: 2px; }
.dx-scard .dx-sname { margin-top: 3px; font-family: var(--f-display); font-weight: 700; font-size: 18px; line-height: 1; letter-spacing: 0.02em; text-transform: uppercase; }
.dx-scard .dx-sref { margin-top: 4px; font-family: var(--f-label); font-size: 10px; letter-spacing: 0.08em; color: var(--amber); text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dx-scard .dx-sblurb { margin-top: 4px; font-size: 11px; line-height: 1.4; color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dx-scard .dx-cur { position: absolute; right: 10px; top: 8px; font-family: var(--f-label); font-size: 9px; letter-spacing: 0.18em; color: var(--amber); text-transform: uppercase; }
.dx-art .ln { stroke: var(--ink); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; stroke-linejoin: miter; }
.dx-art .ln2 { stroke: var(--ink-3); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; }
.dx-art .ln3 { stroke: var(--ink-4); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; }
.dx-art .am { stroke: var(--amber); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; }
.dx-art .amf { fill: var(--amber); }
.dx-art .glass { fill: rgba(170, 205, 215, 0.08); stroke: var(--ink-3); stroke-width: 1; vector-effect: non-scaling-stroke; }
.dx-art .solid { fill: rgba(239, 233, 223, 0.06); stroke: var(--ink); stroke-width: 1; vector-effect: non-scaling-stroke; }
.dx-art text { font-family: var(--f-mono); font-size: 7.5px; fill: var(--amber); letter-spacing: 0.02em; }
/* Short screens: the plates drop their drawings. */
@media (max-height: 680px) and (min-width: 761px) {
  .dx-scard svg { display: none; }
  .dx-models { display: none; }
}

/* ── Touch controls ────────────────────────────────────────────────────── */
.dx-touch { position: absolute; inset: 0; pointer-events: none; display: none; }
.dx-root.dx-is-touch .dx-touch { display: block; }
.dx-stick-zone { position: absolute; left: 0; bottom: 0; width: 45%; height: 52%; pointer-events: auto; touch-action: none; }
.dx-look-zone { position: absolute; right: 0; top: 0; width: 55%; height: 100%; pointer-events: auto; touch-action: none; }
.dx-stick { position: absolute; width: 112px; height: 112px; margin: -56px 0 0 -56px; border: 1px solid var(--rule-2); border-radius: 50%; background: rgba(20, 18, 16, 0.25); opacity: 0; transition: opacity 0.15s; }
.dx-stick.dx-show { opacity: 1; }
.dx-stick b { position: absolute; left: 50%; top: 50%; width: 42px; height: 42px; margin: -21px 0 0 -21px; border-radius: 50%; border: 1px solid var(--amber-2); background: var(--amber-3); }
.dx-tbtn {
  position: absolute; pointer-events: auto; touch-action: none; display: grid; place-items: center; border: 1px solid var(--rule-2);
  background: rgba(24, 21, 18, 0.55); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: var(--ink);
  font-family: var(--f-label); font-weight: 600; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; padding: 0 8px; height: 38px;
}
.dx-tbtn.dx-on { border-color: var(--amber-2); color: var(--amber); }
.dx-fire { width: 86px; height: 86px; border-radius: 50%; border: 2px solid var(--amber); background: rgba(255, 181, 71, 0.14); color: var(--amber); font-size: 12px; letter-spacing: 0.2em; }
.dx-fire.dx-on { background: rgba(255, 181, 71, 0.36); }
.dx-tbtn svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.5; }

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 1100px) {
  .dx-tele { width: 300px; }
}
@media (max-width: 760px), (max-height: 520px) {
  .dx-root { --pad: 10px; }
  .dx-top { height: 26px; gap: 8px; }
  .dx-hide-s { display: none !important; }
  .dx-ruler { top: 26px; }
  /* Phones: the card runs along the top, the telemetry under it (numbers only). */
  .dx-dock { top: 34px; bottom: auto; right: var(--pad); align-items: stretch; }
  .dx-dock .dx-card { order: -1; width: auto; padding: 7px 10px 9px; }
  .dx-card.dx-detail { width: auto; }
  .dx-strip { display: none; }
  .dx-wname { font-size: 24px; }
  /* The group numbers are buttons on touch screens: finger-sized. */
  .dx-slotcaps { gap: 4px; }
  .dx-slotcaps .dx-key { min-width: 26px; height: 24px; font-size: 11px; }
  .dx-card-more .dx-ammo-line { display: none; }
  .dx-specs .dx-spec:nth-child(n+7) { display: none; }
  .dx-tele { left: var(--pad); right: var(--pad); width: auto; top: 118px; padding: 7px 10px 8px; }
  .dx-tele-head { display: none; }
  .dx-latest .dx-tr, .dx-group-note, .dx-blast .dx-note, .dx-older, .dx-empty { display: none !important; }
  .dx-big { margin-top: 4px; }
  .dx-vals { grid-template-columns: 1fr 1fr; column-gap: 12px; }
  .dx-blast-grid div:nth-child(n+4) { display: none; }
  .dx-tele.dx-idle { opacity: 0; }
  .dx-root.dx-detailed .dx-tele { display: none; }
  .dx-depth b { font-size: 26px; }
  .dx-group { margin-top: 5px; }
  .dx-section { height: 16px; margin-top: 3px; }
  .dx-blast { margin-top: 5px; padding-top: 5px; }
  .dx-tele.dx-none { display: none; }
  .dx-keys { display: none !important; }
  .dx-lockhint { display: none !important; }
  .dx-sheet { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'intro' 'plate' 'scenes'; grid-template-rows: auto auto auto; padding: 30px 20px 96px; }
  .dx-menu { background: linear-gradient(180deg, rgba(12, 11, 10, 0.55) 0%, rgba(12, 11, 10, 0.82) 38%, rgba(12, 11, 10, 0.94) 70%); }
  .dx-sheet::before { inset: 10px; }
  .dx-sheet::after { left: 10px; right: 10px; top: 10px; }
  .dx-h1 { font-size: min(56px, 12vw); }
  .dx-h1-sub { font-size: 18px; }
  .dx-lead { font-size: 12.5px; }
  .dx-models { display: none; }
  .dx-plate { justify-self: start; text-align: left; margin-top: 14px; }
  .dx-plate-line { justify-content: flex-start; }
  .dx-actions { position: fixed; left: 0; right: 0; bottom: 0; margin: 0; padding: 12px 20px calc(12px + env(safe-area-inset-bottom)); gap: 8px; flex-wrap: nowrap; background: linear-gradient(transparent, rgba(12, 11, 10, 0.96) 30%); z-index: 2; }
  .dx-actions .dx-btn { padding: 11px 10px; letter-spacing: 0.12em; font-size: 11px; white-space: nowrap; }
  .dx-actions .dx-btn.dx-primary { flex: 1; font-size: 13px; min-width: 0; }
  .dx-hint { display: none; }
  .dx-cards { grid-template-columns: 1fr; gap: 8px; }
  .dx-scard { display: grid; grid-template-columns: 96px 1fr; gap: 10px; align-items: center; }
  .dx-scard svg { height: 52px; }
  .dx-scard .dx-sblurb { -webkit-line-clamp: 2; }
  .dx-help-cols { grid-template-columns: 1fr; gap: 10px; }
  .dx-help { max-height: calc(100vh - 40px); overflow: auto; }
  .dx-toast { top: 56%; }
}
/* Landscape phones: card and telemetry side by side along the top. */
@media (max-height: 520px) and (min-width: 761px) {
  .dx-dock { right: auto; width: min(360px, 44vw); }
  .dx-tele { left: auto; right: var(--pad); top: 34px !important; width: min(360px, 44vw); }
}
@media (prefers-reduced-motion: reduce) {
  .dx-root *, .dx-root *::before, .dx-root *::after { transition: none !important; animation: none !important; }
}
`;
