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

/* ── Telemetry ─────────────────────────────────────────────────────────── */
.dx-tele { right: var(--pad); top: 48px; width: 384px; padding: 10px 12px 12px; }
.dx-tele-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.dx-tele-head .dx-title { font-family: var(--f-label); font-weight: 600; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; }
.dx-rows { display: flex; flex-direction: column; }
.dx-row { position: relative; padding: 5px 0 5px 12px; border-top: 1px solid var(--rule); color: var(--ink-2); }
.dx-rows .dx-row:nth-child(2) { border-top: 0; }
.dx-row::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; background: var(--rule); }
.dx-row.dx-new::before { background: var(--amber); }
.dx-row.dx-new { color: var(--ink); }
.dx-row.dx-new .dx-v { color: var(--amber); }
.dx-row-1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dx-row-1 .dx-ammo { font-family: var(--f-label); font-weight: 600; font-size: 12px; letter-spacing: 0.02em; white-space: nowrap; }
.dx-row-1 .dx-mat { font-family: var(--f-text); font-size: 11.5px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.dx-row-1 .dx-cnt { font-size: 10px; color: var(--ink-3); }
.dx-row.dx-new .dx-cnt { color: var(--amber); }
.dx-cols, .dx-row-2 { display: grid; grid-template-columns: 1.1fr 0.55fr 0.95fr 0.95fr 0.95fr; gap: 4px; }
.dx-cols { padding: 0 0 4px 12px; border-bottom: 1px solid var(--rule); }
.dx-cols .dx-lbl { font-size: 8.5px; letter-spacing: 0.12em; overflow: hidden; text-overflow: ellipsis; }
.dx-row-2 { margin-top: 2px; }
.dx-row-2 .dx-v { font-family: var(--f-mono); font-stretch: 87.5%; font-size: 10.5px; white-space: nowrap; color: var(--ink-2); overflow: hidden; }
.dx-tag {
  font-family: var(--f-label); font-weight: 600; font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase;
  padding: 1px 6px; border: 1px solid var(--rule-2); color: var(--ink-2); white-space: nowrap;
}
.dx-tag.dx-perforate { border-color: var(--amber-2); color: var(--amber); }
.dx-tag.dx-ricochet { border-style: dashed; }
.dx-tag.dx-shatter { color: var(--ink); }
.dx-summary { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--rule); }
.dx-summary .dx-tr { font-size: 11.5px; color: var(--ink); }
.dx-group { margin-top: 8px; }
.dx-group-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.dx-group-head .dx-lbl { color: var(--ink-2); }
.dx-group-head .dx-num { color: var(--amber); font-size: 11px; }
.dx-section { position: relative; height: 28px; margin-top: 5px; }
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
.dx-group-note { margin-top: 4px; font-family: var(--f-mono); font-stretch: 87.5%; font-size: 10px; color: var(--ink-2); }
.dx-summary .dx-model { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dx-summary .dx-model { font-family: var(--f-mono); font-stretch: 80%; font-size: 9.5px; color: var(--ink-3); margin-top: 3px; line-height: 1.4; overflow-wrap: anywhere; }
.dx-empty { padding: 10px 0 4px; color: var(--ink-3); font-size: 11.5px; }
.dx-blast { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--rule); transition: opacity 1.2s ease; }
.dx-blast-grid { display: grid; grid-template-columns: repeat(5, auto); gap: 4px 10px; margin-top: 4px; }
.dx-blast .dx-v { font-family: var(--f-mono); font-stretch: 87.5%; font-size: 10.5px; color: var(--amber); white-space: nowrap; }
.dx-blast .dx-note { margin-top: 4px; font-size: 11px; color: var(--ink-2); }
.dx-blast .dx-note.dx-warn { color: var(--warn); }

/* ── Weapon card ───────────────────────────────────────────────────────── */
.dx-card { left: var(--pad); bottom: var(--pad); width: 372px; padding: 12px 14px 12px; }
.dx-card-top { display: flex; justify-content: space-between; align-items: baseline; }
.dx-key { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px; border: 1px solid var(--rule-2); font-family: var(--f-mono); font-size: 9.5px; color: var(--ink-2); }
.dx-wname { font-family: var(--f-display); font-weight: 700; font-size: 40px; line-height: 0.95; letter-spacing: 0.01em; margin-top: 4px; text-transform: uppercase; }
.dx-role { font-size: 12px; color: var(--ink-2); margin-top: 3px; }
.dx-ammo-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.dx-pill { font-family: var(--f-label); font-weight: 500; font-size: 10.5px; letter-spacing: 0.06em; padding: 2px 7px; border: 1px solid var(--rule); color: var(--ink-3); white-space: nowrap; }
.dx-pill.dx-on { border-color: var(--amber-2); color: var(--amber); background: var(--amber-3); }
.dx-ammo-line { margin-top: 6px; font-size: 11.5px; color: var(--ink-2); }
.dx-specs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; margin-top: 10px; }
.dx-spec { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; border-bottom: 1px solid var(--rule); padding-bottom: 3px; min-width: 0; }
.dx-spec .dx-num { font-size: 11px; color: var(--ink); }
.dx-spec .dx-lbl { font-size: 9px; letter-spacing: 0.13em; overflow: hidden; text-overflow: ellipsis; }
.dx-spec.dx-hi .dx-num { color: var(--amber); }
.dx-foot { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
.dx-cool { flex: 1; position: relative; height: 12px; }
.dx-cool::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 1px; background: var(--rule-2); }
.dx-cool > b { position: absolute; left: 0; top: 5px; height: 3px; background: var(--amber); width: 100%; }
.dx-cool > i { position: absolute; top: 3px; width: 1px; height: 7px; background: var(--rule-2); }
.dx-charges { font-size: 11.5px; color: var(--ink-2); margin-top: 8px; }
.dx-charges b { color: var(--amber); font-family: var(--f-mono); font-weight: 400; }

/* ── Weapon strip ──────────────────────────────────────────────────────── */
.dx-strip { right: var(--pad); bottom: var(--pad); width: 230px; padding: 6px 0; }
.dx-slot { display: grid; grid-template-columns: 22px 64px 1fr auto; align-items: center; gap: 6px; padding: 3px 10px; color: var(--ink-3); }
.dx-slot .dx-key { min-width: 16px; }
.dx-slot .dx-sname { font-family: var(--f-label); font-size: 12px; font-weight: 500; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dx-slot .dx-count { font-family: var(--f-mono); font-size: 9px; color: var(--ink-4); }
.dx-slot.dx-on { color: var(--ink); background: linear-gradient(90deg, var(--amber-3), transparent); }
.dx-slot.dx-on .dx-key { border-color: var(--amber); color: var(--amber); }
.dx-slot.dx-on .dx-lbl { color: var(--amber); }

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

/* Clean view: only the reticle (and transient messages) remain. */
.dx-root.dx-clean :is(.dx-top, .dx-ruler, .dx-tele, .dx-card, .dx-strip, .dx-readout) { display: none; }

/* With the menu up, the play HUD is not drawn under the translucent sheet. */
.dx-root.dx-menu-open :is(.dx-top, .dx-ruler, .dx-tele, .dx-card, .dx-strip, .dx-reticle, .dx-readout, .dx-hit, .dx-banner, .dx-scope, .dx-lockhint, .dx-frame) { visibility: hidden; }
.dx-touch-hidden { display: none !important; }

/* Looking through a scope, the panels step back. */
.dx-root.dx-scoped :is(.dx-card, .dx-top, .dx-ruler) { opacity: 0.32; }
.dx-root.dx-scoped :is(.dx-tele, .dx-strip) { opacity: 0.1; }
.dx-tele, .dx-card, .dx-strip, .dx-top { transition: opacity 0.2s ease; }

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

/* ── Menu: the drawing sheet ───────────────────────────────────────────── */
.dx-menu {
  position: absolute; inset: 0; pointer-events: auto; overflow: auto; display: none;
  background:
    linear-gradient(rgba(239, 233, 223, 0.035) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(90deg, rgba(239, 233, 223, 0.035) 1px, transparent 1px) 0 0 / 24px 24px,
    radial-gradient(120% 90% at 70% 30%, rgba(34, 30, 26, 0.8), rgba(12, 11, 10, 0.94));
}
/* The blur lives on a pseudo-element: a backdrop-filter on the menu itself would become the
   containing block of the fixed action bar on phones. */
.dx-menu::before { content: ''; position: fixed; inset: 0; z-index: -1; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.dx-menu.dx-show { display: block; animation: dx-fade 0.25s ease-out; }
@keyframes dx-fade { from { opacity: 0; } to { opacity: 1; } }
.dx-sheet { position: relative; min-height: 100%; padding: 44px 48px 40px; display: grid; grid-template-columns: minmax(300px, 0.78fr) 1.22fr; gap: 44px; }
.dx-sheet::before { content: ''; position: absolute; inset: 18px; border: 1px solid var(--rule); pointer-events: none; }
.dx-sheet::after {
  content: ''; position: absolute; left: 18px; right: 18px; top: 18px; height: 8px; pointer-events: none;
  background:
    repeating-linear-gradient(90deg, var(--rule-2) 0 1px, transparent 1px 96px) 0 0 / 100% 8px no-repeat,
    repeating-linear-gradient(90deg, var(--rule) 0 1px, transparent 1px 12px) 0 0 / 100% 4px no-repeat;
}
.dx-intro { display: flex; flex-direction: column; padding-top: 18px; }
.dx-over { font-family: var(--f-label); font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--amber); }
.dx-h1 { margin: 10px 0 0; font-family: var(--f-display); font-weight: 800; font-size: clamp(56px, 7.4vw, 104px); line-height: 0.86; letter-spacing: 0.005em; text-transform: uppercase; }
.dx-h1-sub { margin-top: 12px; font-family: var(--f-display); font-weight: 500; font-size: 24px; letter-spacing: 0.04em; color: var(--ink-2); }
.dx-lead { margin-top: 18px; max-width: 460px; font-size: 13.5px; line-height: 1.55; color: var(--ink-2); }
.dx-models { margin-top: 16px; display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; max-width: 460px; }
.dx-models .dx-lbl { font-size: 9.5px; }
.dx-models span:not(.dx-lbl) { font-size: 11.5px; color: var(--ink-2); }
.dx-actions { margin-top: 26px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.dx-btn {
  pointer-events: auto; cursor: pointer; border: 1px solid var(--rule-2); background: transparent; padding: 10px 16px;
  font-family: var(--f-label) !important; font-weight: 600; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.dx-btn:hover { border-color: var(--ink-2); background: rgba(239, 233, 223, 0.06); }
.dx-btn:focus-visible { outline: 1px solid var(--amber); outline-offset: 3px; }
.dx-btn.dx-primary { border-color: var(--amber); color: #1a140c; background: var(--amber); padding: 12px 30px; font-size: 13px; }
.dx-btn.dx-primary:hover { background: #ffc467; }
.dx-btn[disabled] { opacity: 0.6; cursor: progress; }
.dx-hint { margin-top: 14px; font-size: 11px; color: var(--ink-3); }
.dx-scenes-head { display: flex; justify-content: space-between; align-items: baseline; padding-top: 18px; margin-bottom: 12px; }
.dx-scenes-head .dx-title { font-family: var(--f-label); font-weight: 600; font-size: 11px; letter-spacing: 0.26em; text-transform: uppercase; }
.dx-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(208px, 1fr)); gap: 12px; }
.dx-scard {
  position: relative; cursor: pointer; text-align: left; padding: 10px 12px 12px; background: rgba(27, 24, 21, 0.55);
  border: 1px solid var(--rule); transition: border-color 0.15s ease, background 0.15s ease; pointer-events: auto;
}
.dx-scard:hover { border-color: var(--rule-2); background: rgba(33, 30, 26, 0.7); }
.dx-scard:focus-visible { outline: 1px solid var(--amber); outline-offset: 2px; }
.dx-scard.dx-on { border-color: var(--amber-2); background: rgba(40, 33, 24, 0.72); }
.dx-scard.dx-on::before, .dx-scard.dx-on::after { content: ''; position: absolute; width: 10px; height: 10px; border: 0 solid var(--amber); }
.dx-scard.dx-on::before { left: -1px; top: -1px; border-width: 2px 0 0 2px; }
.dx-scard.dx-on::after { right: -1px; bottom: -1px; border-width: 0 2px 2px 0; }
.dx-scard svg { display: block; width: 100%; height: auto; aspect-ratio: 32 / 15; }
.dx-scard .dx-idx { font-family: var(--f-mono); font-size: 9.5px; color: var(--ink-3); }
.dx-scard .dx-sname { margin-top: 5px; font-family: var(--f-display); font-weight: 700; font-size: 21px; line-height: 1; letter-spacing: 0.02em; text-transform: uppercase; }
.dx-scard .dx-sblurb { margin-top: 6px; font-size: 12px; line-height: 1.45; color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dx-scard .dx-cur { position: absolute; right: 12px; top: 11px; font-family: var(--f-label); font-size: 9px; letter-spacing: 0.18em; color: var(--amber); text-transform: uppercase; }
.dx-art .ln { stroke: var(--ink); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; stroke-linejoin: miter; }
.dx-art .ln2 { stroke: var(--ink-3); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; }
.dx-art .ln3 { stroke: var(--ink-4); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; }
.dx-art .am { stroke: var(--amber); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; }
.dx-art .amf { fill: var(--amber); }
.dx-art .glass { fill: rgba(170, 205, 215, 0.08); stroke: var(--ink-3); stroke-width: 1; vector-effect: non-scaling-stroke; }
.dx-art .solid { fill: rgba(239, 233, 223, 0.06); stroke: var(--ink); stroke-width: 1; vector-effect: non-scaling-stroke; }
.dx-art text { font-family: var(--f-mono); font-size: 7.5px; fill: var(--amber); letter-spacing: 0.02em; }
.dx-titleblock {
  position: absolute; right: 18px; bottom: 18px; display: grid; grid-template-columns: repeat(4, auto); border-left: 1px solid var(--rule); border-top: 1px solid var(--rule);
}
.dx-titleblock div { padding: 5px 10px 6px; border-right: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.dx-titleblock .dx-lbl { display: block; font-size: 8px; }
.dx-titleblock .dx-num { font-size: 10px; color: var(--ink-2); }

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

/* ── Responsive ────────────────────────────────────────────────────────── */
/* Short screens with the weapon strip: the telemetry keeps its three newest rows so it stays clear of the strip. */
@media (max-height: 800px) and (min-width: 1101px) {
  .dx-rows .dx-row:nth-child(n+5) { display: none !important; }
}
@media (max-width: 1100px) {
  .dx-tele { width: 340px; }
  .dx-card { width: 340px; }
  .dx-strip { display: none; }
}
@media (max-width: 760px), (max-height: 520px) {
  .dx-root { --pad: 10px; }
  .dx-top { height: 26px; gap: 8px; }
  .dx-hide-s { display: none !important; }
  .dx-ruler { top: 26px; }
  .dx-tele { left: var(--pad); right: var(--pad); width: auto; top: 170px; padding: 7px 10px 8px; }
  .dx-tele .dx-row:not(.dx-new), .dx-tele .dx-summary .dx-model, .dx-tele-head .dx-lbl { display: none; }
  /* Numbers only: the panel must end above the reticle. */
  .dx-tele .dx-summary .dx-tr, .dx-group-note, .dx-blast .dx-note { display: none !important; }
  .dx-summary { margin-top: 4px; padding-top: 4px; }
  .dx-group { margin-top: 0; }
  .dx-section { height: 18px; margin-top: 3px; }
  .dx-blast { margin-top: 5px; padding-top: 5px; }
  .dx-blast .dx-tele-head { margin-bottom: 0; }
  .dx-tele-head { margin-bottom: 4px; }
  .dx-card { left: var(--pad); right: var(--pad); top: 34px; bottom: auto; width: auto; padding: 8px 10px 9px; }
  .dx-card > .dx-card-top, .dx-card .dx-dimline, .dx-card .dx-role, .dx-card .dx-ammo-line { display: none; }
  .dx-wname { font-size: 26px; margin-top: 0; }
  .dx-ammo-pills { margin-top: 6px; }
  .dx-specs { grid-template-columns: 1fr 1fr; gap: 3px 10px; margin-top: 6px; }
  .dx-specs .dx-spec:nth-child(n+5) { display: none; }
  .dx-foot { margin-top: 6px; }
  .dx-charges { margin-top: 5px; }
  .dx-strip { display: none; }
  .dx-lockhint { display: none !important; }
  .dx-sheet { grid-template-columns: 1fr; padding: 34px 22px 96px; gap: 22px; }
  .dx-sheet::before { inset: 10px; }
  .dx-sheet::after { left: 10px; right: 10px; top: 10px; }
  .dx-h1 { font-size: 58px; }
  .dx-h1-sub { font-size: 19px; }
  .dx-lead { font-size: 13px; }
  .dx-models { display: none; }
  .dx-actions { position: fixed; left: 0; right: 0; bottom: 0; margin: 0; padding: 12px 22px calc(12px + env(safe-area-inset-bottom)); gap: 8px; flex-wrap: nowrap; background: linear-gradient(transparent, rgba(12, 11, 10, 0.96) 30%); z-index: 2; }
  .dx-actions .dx-btn { padding: 11px 10px; letter-spacing: 0.12em; font-size: 11px; white-space: nowrap; }
  .dx-actions .dx-btn.dx-primary { flex: 1; font-size: 13px; }
  .dx-hint { display: none; }
  .dx-cards { grid-template-columns: 1fr; }
  .dx-titleblock { display: none; }
  .dx-help-cols { grid-template-columns: 1fr; gap: 10px; }
  .dx-help { max-height: calc(100vh - 40px); overflow: auto; }
  .dx-toast { top: 56%; }
}
/* Landscape phones: card and telemetry side by side along the top. */
@media (max-height: 520px) and (min-width: 761px) {
  .dx-card { right: auto; width: min(360px, 44vw); }
  .dx-tele { left: auto; right: var(--pad); top: 34px; width: min(360px, 44vw); }
}
@media (prefers-reduced-motion: reduce) {
  .dx-root *, .dx-root *::before, .dx-root *::after { transition: none !important; animation: none !important; }
}
`;
