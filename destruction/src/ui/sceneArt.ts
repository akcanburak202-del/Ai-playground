/**
 * Elevation line drawings for the scene cards, in the manner of an architect's sheet: hairline
 * strokes, a hatched ground line, dimension lines with slash ticks and the one amber mark — the
 * aim point. Static SVG markup (no user text goes into it). Chosen by keywords in the scene id or
 * name, so new scenes get a sensible drawing without touching this file.
 */

export type ArtKind = 'chapel' | 'pavilion' | 'tower' | 'temple' | 'proving' | 'generic';

export function artKindFor(id: string, name = ''): ArtKind {
  const s = `${id} ${name}`.toLowerCase();
  if (/chapel|ando|church|light|şapel|kilise/.test(s)) return 'chapel';
  if (/pavilion|pavyon|mies|barcelona/.test(s)) return 'pavilion';
  if (/tower|kule|frame|curtain|skyscraper|office|gökdelen/.test(s)) return 'tower';
  if (/temple|tapınak|doric|dor|parthenon|classic/.test(s)) return 'temple';
  if (/proving|range|test|calib|poligon|atış/.test(s)) return 'proving';
  return 'generic';
}

const W = 320;
const GROUND = 126;

function ground(x0 = 10, x1 = 310): string {
  let hatch = '';
  for (let x = x0 + 4; x < x1; x += 7) hatch += `M${x} ${GROUND + 1}l-4 5`;
  return `<path class="ln" d="M${x0} ${GROUND}H${x1}"/><path class="ln3" d="${hatch}"/>`;
}

/** Horizontal dimension line with architectural slash ticks and a centred label. */
function dimH(x0: number, x1: number, y: number, label: string): string {
  const mid = (x0 + x1) / 2;
  const tw = label.length * 4.6 + 8;
  return `<path class="ln2" d="M${x0} ${y}H${mid - tw / 2}M${mid + tw / 2} ${y}H${x1}M${x0} ${y - 5}v10M${x1} ${y - 5}v10"/>`
    + `<path class="ln" d="M${x0 - 3} ${y + 3}l6 -6M${x1 - 3} ${y + 3}l6 -6"/>`
    + `<text x="${mid}" y="${y + 2.6}" text-anchor="middle">${label}</text>`;
}

function dimV(x: number, y0: number, y1: number, label: string): string {
  const mid = (y0 + y1) / 2;
  return `<path class="ln2" d="M${x} ${y0}V${mid - 9}M${x} ${mid + 9}V${y1}M${x - 5} ${y0}h10M${x - 5} ${y1}h10"/>`
    + `<path class="ln" d="M${x - 3} ${y0 + 3}l6 -6M${x - 3} ${y1 + 3}l6 -6"/>`
    + `<text x="${x}" y="${mid + 2.6}" text-anchor="middle" transform="rotate(-90 ${x} ${mid})">${label}</text>`;
}

/** The aim mark: a small amber circle with a cross, where the first round will land. */
function aim(x: number, y: number): string {
  return `<circle class="am" cx="${x}" cy="${y}" r="4"/><path class="am" d="M${x - 7} ${y}h4M${x + 3} ${y}h4M${x} ${y - 7}v4M${x} ${y + 3}v4"/>`;
}

function chapel(): string {
  let ties = '';
  for (let y = 60; y < 122; y += 12) for (let x = 84; x < 226; x += 16) ties += `<circle class="ln3" cx="${x}" cy="${y}" r="0.9"/>`;
  return ground()
    + `<rect class="solid" x="72" y="46" width="160" height="80"/>`
    + ties
    // The light cross: slots through the altar wall.
    + `<path class="amf" d="M150 56h4v62h-4zM128 78h48v4h-48z"/>`
    // Free-standing wall slicing past at 15° (seen as a lower plane in front).
    + `<path class="solid" d="M28 126V88L128 80V126z"/>`
    + `<path class="ln3" d="M40 98h78M40 110h78"/>`
    + aim(206, 92)
    + dimH(72, 232, 140, '18,0 m')
    + dimV(250, 46, 126, '8,0 m');
}

function pavilion(): string {
  let joints = '';
  for (let x = 38; x < 92; x += 9) joints += `M${x} 74V116`;
  for (let y = 83; y < 116; y += 11) joints += `M30 ${y}H92`;
  return ground()
    + `<rect class="ln" x="18" y="116" width="284" height="10"/>`
    // Travertine wall, glass, onyx screen, the floating roof on chrome cruciform columns.
    + `<rect class="solid" x="30" y="72" width="62" height="44"/><path class="ln3" d="${joints}"/>`
    + `<rect class="glass" x="112" y="64" width="72" height="52"/><path class="ln3" d="M122 110l18 -40M132 110l12 -26M160 108l16 -36"/><path class="ln2" d="M148 64V116"/>`
    + `<rect class="solid" x="200" y="64" width="44" height="52"/><path class="ln2" d="M204 76c12 4 18 -6 36 2M204 92c10 -6 20 8 36 0M204 104c14 4 20 -4 36 4"/>`
    + `<path class="ln" d="M104 64V116M254 64V116M100 116h8M250 116h8"/>`
    + `<rect class="solid" x="52" y="58" width="226" height="6"/>`
    // Reflecting pool.
    + `<path class="ln2" d="M20 121h74"/><path class="ln3" d="M26 123.5h20M56 123.5h28"/>`
    + aim(222, 86)
    + dimH(52, 278, 140, '24,5 m');
}

function tower(): string {
  let grid = '';
  for (let x = 130; x < 200; x += 10) grid += `M${x} 20V100`;
  let floors = '';
  for (let y = 26; y < 100; y += 7) floors += `M120 ${y}H200`;
  return ground()
    + `<rect class="glass" x="120" y="16" width="80" height="84"/>`
    + `<path class="ln3" d="${grid}"/><path class="ln2" d="${floors}"/>`
    + `<rect class="solid" x="116" y="10" width="88" height="6"/>`
    // Podium on pilotis.
    + `<rect class="solid" x="86" y="100" width="148" height="10"/>`
    + `<path class="ln" d="M96 110V126M130 110V126M160 110V126M190 110V126M224 110V126"/>`
    + `<rect class="glass" x="100" y="114" width="120" height="12"/>`
    // Diagonal wind bracing glimpsed through the glass.
    + `<path class="ln3" d="M120 100L200 58M120 58L200 16"/>`
    + aim(170, 64)
    + dimV(250, 10, 126, '86 m')
    + dimH(86, 234, 140, '30,0 m');
}

function temple(): string {
  let cols = '';
  const n = 6;
  for (let i = 0; i < n; i++) {
    const cx = 78 + i * 33;
    // Fluted, tapering shaft; echinus and abacus above.
    cols += `<path class="solid" d="M${cx - 8} 116L${cx - 6.5} 66H${cx + 6.5}L${cx + 8} 116z"/>`;
    cols += `<path class="ln3" d="M${cx - 3} 115L${cx - 2.4} 67M${cx} 115V67M${cx + 3} 115L${cx + 2.4} 67"/>`;
    cols += `<path class="ln" d="M${cx - 7} 66L${cx - 10} 61H${cx + 10}L${cx + 7} 66"/><rect class="ln" x="${cx - 11}" y="57" width="22" height="4"/>`;
  }
  let tri = '';
  for (let x = 66; x < 256; x += 12) tri += `M${x} 43v6M${x + 2.5} 43v6`;
  return ground()
    + `<path class="ln" d="M52 116H268M48 120H272M44 123H276M44 126V123M48 123V120M52 120V116M276 126V123M272 123V120M268 120V116"/>`
    + cols
    + `<rect class="solid" x="56" y="49" width="208" height="8"/>`
    + `<rect class="ln" x="56" y="42" width="208" height="7"/><path class="ln3" d="${tri}"/>`
    + `<path class="solid" d="M50 42L160 16L270 42z"/><path class="ln2" d="M64 39L160 20L256 39"/>`
    // A crack running down the fourth column.
    + `<path class="am" d="M177 80l-3 8l4 5l-2 9"/>`
    + aim(177, 80)
    + dimH(44, 276, 140, '31,0 m');
}

function proving(): string {
  return ground()
    // Earth berm behind the targets.
    + `<path class="ln2" d="M14 126C60 84 250 84 306 126"/>`
    // Concrete wall block, steel plate on its stand, framed glass pane.
    + `<rect class="solid" x="44" y="84" width="46" height="42"/><path class="ln3" d="M52 94h30M52 104h30M52 114h30"/>`
    + `<rect class="solid" x="134" y="74" width="34" height="38"/><path class="ln" d="M140 112l-6 14M162 112l6 14"/>`
    + `<rect class="glass" x="206" y="72" width="34" height="54"/><path class="ln3" d="M212 118l16 -38M222 120l12 -28"/>`
    // Range posts.
    + `<path class="ln2" d="M112 126v-10M186 126v-10M262 126v-10"/>`
    + `<text x="112" y="112" text-anchor="middle">25</text><text x="186" y="112" text-anchor="middle">50</text><text x="262" y="112" text-anchor="middle">100</text>`
    // The shot line.
    + `<path class="am" stroke-dasharray="3 3" d="M10 92Q80 86 150 93"/>`
    + aim(151, 93)
    + dimH(44, 240, 140, '100 m');
}

function generic(): string {
  let win = '';
  for (let x = 96; x < 222; x += 18) for (let y = 62; y < 110; y += 16) win += `<rect class="glass" x="${x}" y="${y}" width="10" height="10"/>`;
  return ground() + `<rect class="solid" x="84" y="50" width="152" height="76"/>` + win + aim(192, 78) + dimH(84, 236, 140, '20,0 m');
}

export function sceneArt(kind: ArtKind): string {
  const body = { chapel, pavilion, tower, temple, proving, generic }[kind]();
  return `<svg class="dx-art" viewBox="0 0 ${W} 150" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${body}</svg>`;
}
