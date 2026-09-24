import * as THREE from 'three';
import type { SimEvents, StructureApi } from '../app/contracts.ts';
import type { Destructible, Structural } from '../destructibles/Destructible.ts';
import { G } from '../core/units.ts';

/**
 * The support graph of a scene: which element holds up which, through which contact region, and
 * how the dead load flows down to the ground. It decides *when* an element loses a support; the
 * elements decide *what* that does to them (a slab that keeps one wall cantilevers or breaks off
 * beyond its reach, a column that loses its load stands, a pane whose frame goes shatters).
 *
 *   ground ──► walls / columns ──► beams / slabs ──► roof, glass, stone blocks
 *
 * Failure propagation: a supporter that has failed, been removed, or whose material in a contact
 * region has fallen below PRESENCE_MIN no longer holds that region. The supported element is told
 * (`releaseAnchor`) after the time it takes to drop through the bearing's deformation capacity δ,
 * t = √(2δ/g) (free fall, constant acceleration kinematics) — tens of milliseconds per level, so a
 * collapse runs down the structure as a visible sequence instead of in one frame. What an element
 * carries starts its own countdown the moment the element loses its last support. Column splices
 * (an upright steel member standing on another) have almost no play, so a cut column line drops
 * as one within a few steps instead of opening a gap at every floor. Panes, which break on the
 * spot when released, go one per step.
 *
 * Load flow: top-down over the active links, each element delivers its own weight plus what it
 * carries to its bearing supports, split by the lever rule (share ∝ 1 / horizontal distance from
 * the element's centre to the contact; exact for two supports, the usual tributary approximation
 * beyond). The carried load goes to `setImposedLoad` (column crushing / buckling checks). Weights
 * are cached and re-measured only for elements that were touched (lost material).
 *
 * Pure logic over the Destructible / Structural interfaces: no DOM, no renderer.
 */

/** A supporter that keeps less than this fraction of its material in a contact region lets go. */
export const PRESENCE_MIN = 0.35;
/** Bearing deformation capacity before a support lets go, m (engineering estimates, see delay()) */
const DELTA_BRITTLE = 0.02;
const DELTA_STEEL = 0.05;
const DELTA_GLAZING = 0.012;
const DELTA_SPLICE = 0.005;
/** Touched supporters are re-measured at most this often (their own checks are debounced too), s */
const EVAL_INTERVAL = 0.05;
/** Steel members are re-measured on this period even when nobody touched them, s */
const SWEEP_INTERVAL = 0.25;
/** A steel member whose bounds moved less than this since its last measurement is not re-probed, m */
const MOVE_TOL = 0.002;
/** Weights drift as material is shot away; the load flow is refreshed at most this often, s */
const WEIGHT_INTERVAL = 1;
/** Glass panes let go per fixed step at most (each break is several ms of work in the pane) */
const GLASS_PER_STEP = 1;
/** Load changes smaller than this are not pushed (N, and relative) */
const PUSH_ABS = 500;
const PUSH_REL = 0.02;
/** Load decreases (which cannot fail anything) are pushed at most this often per element, s */
const DECREASE_INTERVAL = 0.25;

/** What the graph needs from the simulation context (tests pass a small mock). */
export interface GraphHost {
  readonly time: { readonly now: number };
  readonly events: { emit<K extends keyof SimEvents>(type: K, payload: SimEvents[K]): void };
}

export interface LinkInfo {
  readonly id: string;
  readonly supporter: Destructible | 'ground';
  readonly supported: Destructible;
  readonly region: THREE.Box3;
  /** Carries gravity (contact at the supported element's base) rather than restraining it sideways */
  readonly bearing: boolean;
  readonly active: boolean;
  /** Simulation time the release takes effect, or −1 */
  readonly releaseAt: number;
  /** Share of the supported element's load carried through this link at the last load flow, N */
  readonly load: number;
}

interface Link {
  id: string;
  supporter: Node | null;
  supported: Node;
  region: THREE.Box3;
  centre: THREE.Vector3;
  bearing: boolean;
  active: boolean;
  releaseAt: number;
  load: number;
  /** Rays that found a steel supporter under the bearing plane when linked (0: not probed) */
  probe: number;
  /** A column splice (judged when linked: a falling column no longer stands upright) */
  splice: boolean;
}

interface Node {
  el: Destructible;
  s: Structural | null;
  /** Links where this element is the supporter (its dependents) */
  up: Link[];
  /** Links where this element is supported */
  down: Link[];
  /** Extra dead load acting on the element (test rigs, finishes not modelled), N */
  external: number;
  /** Load arriving from dependents plus external, at the last flow, N */
  target: number;
  /** Point loads arriving at the element, [x, z, N] triples: where they act in plan */
  pts: number[];
  /** Bounds when its supports were last measured (steel sweep: unmoved members are skipped) */
  snap: THREE.Box3 | null;
  /** Own weight at the last measurement, N; re-measured after the element was touched */
  w: number;
  wDirty: boolean;
  pushed: number;
  pushedAt: number;
  touched: boolean;
  lastEval: number;
  gone: boolean;
  /** Lost its last support (event emitted) */
  fell: boolean;
  /** Scratch for the topological sort */
  indeg: number;
}


export class StructureGraph implements StructureApi {
  private readonly host: GraphHost;
  private readonly nodes = new Map<Destructible, Node>();
  private readonly links = new Map<string, Link>();
  private n = 0;
  private topologyDirty = false;
  private weightsDirty = false;
  private lastFlow = -Infinity;
  private pending: Link[] = [];
  /** Steel supporters, re-measured round robin */
  private steel: Node[] = [];
  private sweep = 0;
  /** Supporters whose presence should be re-measured */
  private touchedList: Node[] = [];
  /** Diagnostics */
  readonly stats = { links: 0, releases: 0, flows: 0, pushes: 0, lastUpdateMs: 0, lastFlowMs: 0 };

  constructor(host: GraphHost) {
    this.host = host;
  }

  // ── StructureApi ──────────────────────────────────────────────────────────────────────────

  link(supporter: Destructible | 'ground', supported: Destructible, regionWorld: THREE.Box3): string {
    const id = `st-${++this.n}`;
    const child = this.node(supported);
    const parent = supporter === 'ground' ? null : this.node(supporter);
    const region = regionWorld.clone();
    const centre = region.getCenter(new THREE.Vector3());
    // Bearing when the contact sits in the lower quarter of the supported element; otherwise it
    // restrains the element from the side (a panel held at its edge, a pane in its frame) and only
    // takes gravity when nothing bears underneath.
    const b = supported.bounds;
    const h = Math.max(1e-3, b.max.y - b.min.y);
    const bearing = b.isEmpty() || centre.y <= b.min.y + 0.25 * h;
    const splice = !!parent && bearing && isSplice(parent.el, supported);
    const l: Link = { id, supporter: parent, supported: child, region, centre, bearing, active: true, releaseAt: -1, load: 0, probe: 0, splice };
    if (parent && bearing && (parent.el.kind === 'beam' || parent.el.kind === 'plate')) {
      l.probe = bearingHits(parent.el, region);
      (parent.snap ??= new THREE.Box3()).copy(parent.el.bounds);
    }
    this.links.set(id, l);
    child.down.push(l);
    parent?.up.push(l);
    child.fell = false;
    supported.structural?.addAnchor(id, region);
    // Measure the supporter once now: element implementations cache the pristine count lazily.
    if (parent?.s && !parent.gone) parent.s.supportPresence(region);
    this.topologyDirty = true;
    this.stats.links++;
    return id;
  }

  touch(el: Destructible): void {
    const node = this.nodes.get(el);
    if (!node || node.gone) return;
    // Material went: weigh the element again at the next load flow (weighing is not free — a slab
    // sums every rebar segment — so untouched elements keep their cached weight).
    node.wDirty = true;
    this.weightsDirty = true;
    if (!node.touched && node.up.length) {
      node.touched = true;
      this.touchedList.push(node);
    }
  }

  remove(el: Destructible): void {
    const node = this.nodes.get(el);
    if (!node || node.gone) return;
    node.gone = true;
    const now = this.host.time.now;
    for (const l of node.up) this.schedule(l, now);
    for (const l of node.down) {
      l.active = false;
      l.releaseAt = -1;
    }
    this.topologyDirty = true;
  }

  update(dt: number): void {
    if (!(dt > 0) || this.nodes.size === 0) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const now = this.host.time.now;

    // Cheap every step: failed or vanished supporters.
    for (const node of this.nodes.values()) {
      if (node.gone) continue;
      if (node.el.disposed) {
        this.remove(node.el);
        continue;
      }
      if (node.up.length && node.s?.hasFailed()) for (const l of node.up) this.schedule(l, now);
    }

    // Touched supporters: re-measure what is left in each contact region.
    if (this.touchedList.length) {
      let w = 0;
      for (const node of this.touchedList) {
        if (node.gone || now - node.lastEval < EVAL_INTERVAL) {
          if (!node.gone) this.touchedList[w++] = node;
          continue;
        }
        node.touched = false;
        node.lastEval = now;
        this.measure(node, now);
      }
      this.touchedList.length = w;
    }
    // Steel members deform without losing material: re-measure each of them every SWEEP_INTERVAL,
    // a few per step (round robin), so the cost per step stays small — and only the ones that
    // have moved since they were last measured (a probe is a few dozen ray casts; a member whose
    // bounds have not changed cannot have sagged away from what it carries, and material loss
    // arrives through touch()).
    if (this.steel.length) {
      const due = Math.ceil((this.steel.length * dt) / SWEEP_INTERVAL);
      for (let i = 0; i < due; i++) {
        const node = this.steel[this.sweep++ % this.steel.length]!;
        if (node.gone || !node.up.length || now - node.lastEval < EVAL_INTERVAL) continue;
        if (node.snap && sameBox(node.snap, node.el.bounds, MOVE_TOL)) continue;
        node.lastEval = now;
        this.measure(node, now);
      }
    }

    // Releases that have come due. A pane that loses its frame breaks on the spot (tempered glass
    // dices the whole pane, ~8 ms of work each), so at most one pane lets go per step and
    // the rest follow on the next steps: a floor's worth of glazing goes over a few frames rather
    // than in one 80 ms step.
    if (this.pending.length) {
      let w = 0, glass = 0;
      for (const l of this.pending) {
        if (!l.active) continue;
        if (l.releaseAt > now || (l.supported.el.kind === 'glass' && glass >= GLASS_PER_STEP)) {
          this.pending[w++] = l;
          continue;
        }
        if (l.supported.el.kind === 'glass') glass++;
        this.release(l, now);
      }
      this.pending.length = w;
    }

    if (this.topologyDirty || (this.weightsDirty && now - this.lastFlow >= WEIGHT_INTERVAL)) this.flow(now);
    this.push(now);
    if (t0) this.stats.lastUpdateMs = performance.now() - t0;
  }

  // ── Extras (scenes, sandboxes, tests) ─────────────────────────────────────────────────────

  /** Dead load acting on an element beyond what the graph knows about (a test rig's jacks), N. */
  setExternalLoad(el: Destructible, newtons: number): void {
    const node = this.node(el);
    node.external = Math.max(0, newtons);
    this.topologyDirty = true;
  }

  /** Load arriving at an element from what it carries (after the last flow), N. */
  imposedLoad(el: Destructible): number {
    return this.nodes.get(el)?.target ?? 0;
  }

  /** Snapshot of the links (for tests, debugging overlays and telemetry). */
  linksOf(el?: Destructible): LinkInfo[] {
    const out: LinkInfo[] = [];
    for (const l of this.links.values()) {
      if (el && l.supported.el !== el && l.supporter?.el !== el) continue;
      out.push({
        id: l.id, supporter: l.supporter?.el ?? 'ground', supported: l.supported.el, region: l.region, bearing: l.bearing,
        active: l.active, releaseAt: l.releaseAt, load: l.load,
      });
    }
    return out;
  }

  /** True while a release is waiting for its delay. */
  get busy(): boolean {
    return this.pending.length > 0;
  }

  /** Drop everything (scene change). */
  reset(): void {
    this.nodes.clear();
    this.links.clear();
    this.pending.length = 0;
    this.touchedList.length = 0;
    this.topologyDirty = false;
    this.weightsDirty = false;
    this.lastFlow = -Infinity;
    this.steel.length = 0;
    this.sweep = 0;
    this.stats.links = this.stats.releases = this.stats.flows = this.stats.pushes = 0;
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────

  private node(el: Destructible): Node {
    let node = this.nodes.get(el);
    if (!node) {
      node = {
        el, s: el.structural ?? null, up: [], down: [], external: 0, target: 0, pts: [], snap: null, w: 0, wDirty: true, pushed: 0, pushedAt: -Infinity,
        touched: false, lastEval: -Infinity, gone: false, fell: false, indeg: 0,
      };
      this.nodes.set(el, node);
      if (el.kind === 'beam' || el.kind === 'plate') this.steel.push(node);
    }
    return node;
  }

  /** Re-measure a supporter's contact regions and schedule the ones it no longer holds. */
  private measure(node: Node, now: number): void {
    const s = node.s;
    (node.snap ??= new THREE.Box3()).copy(node.el.bounds);
    const steel = node.el.kind === 'beam' || node.el.kind === 'plate';
    for (const l of node.up) {
      if (!l.active || l.releaseAt >= 0) continue;
      let presence = 1;
      if (node.el.disposed) presence = 0;
      else if (s) presence = s.hasFailed() ? 0 : s.supportPresence(l.region);
      // A steel member can sag or swing away from what rests on it without losing material:
      // check that it is still under the bearing plane (relative to how it was found at first).
      if (presence >= PRESENCE_MIN && steel && l.probe > 0) presence = Math.min(presence, bearingHits(node.el, l.region) / l.probe);
      if (!(presence >= PRESENCE_MIN)) this.schedule(l, now);
    }
  }

  private schedule(l: Link, now: number): void {
    if (!l.active || l.releaseAt >= 0) return;
    l.releaseAt = now + delay(l);
    this.pending.push(l);
  }

  private release(l: Link, now: number): void {
    l.active = false;
    l.releaseAt = -1;
    this.stats.releases++;
    this.topologyDirty = true;
    const child = l.supported;
    if (child.gone || child.el.disposed) return;
    const last = !child.fell && !child.down.some((d) => d.active);
    const w = last ? safeWeight(child) : 0;
    child.s?.releaseAnchor(l.id);
    if (!last) return;
    // Nothing holds it any more: its mass starts to fall, and what it carries starts its own
    // countdown now (not a step later, when the element reports itself failed). Steel members and
    // plates report their own failure when they come loose (they know whether they buckled, were
    // severed or let go).
    child.fell = true;
    for (const u of child.up) this.schedule(u, now);
    const k = child.el.kind;
    if (k === 'beam' || k === 'plate') return;
    const pos = child.el.bounds.isEmpty() ? l.centre.clone() : child.el.bounds.getCenter(new THREE.Vector3());
    this.host.events.emit('structuralFailure', { time: now, position: pos, label: child.el.name, mass: w / G, cause: 'support-lost' });
  }

  /**
   * Top-down gravity load flow over the active links (dependents before their supporters; a cycle,
   * which a scene should not build, is broken where it is found).
   *
   * Tributary distribution (the load takedown of practice): an element's own weight is sampled as
   * point loads over its plan, loads it carries arrive spread along the contacts they came
   * through, and every point load is shared among the element's supports in inverse proportion to
   * its plan distance from each contact (+ 0.25 m) — the lever rule between two supports, the
   * tributary areas of a continuous member or slab over several. Statically determinate cases
   * are exact; continuity effects (a continuous beam's middle support carrying ~1.25× its
   * tributary share) are not modelled.
   */
  private flow(now: number): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.topologyDirty = false;
    this.weightsDirty = false;
    this.lastFlow = now;
    this.stats.flows++;
    const order: Node[] = [];
    for (const node of this.nodes.values()) {
      node.target = node.external;
      node.pts.length = 0;
      if (node.external > 0) {
        const b = node.el.bounds;
        node.pts.push(b.isEmpty() ? 0 : 0.5 * (b.min.x + b.max.x), b.isEmpty() ? 0 : 0.5 * (b.min.z + b.max.z), node.external);
      }
      node.indeg = 0;
    }
    for (const l of this.links.values()) if (l.active && l.supporter && !l.supported.gone) l.supporter.indeg++;
    for (const node of this.nodes.values()) if (node.indeg === 0) order.push(node);
    for (let i = 0; i < order.length; i++) {
      for (const l of order[i]!.down) {
        const p = l.supporter;
        if (!l.active || !p) continue;
        if (--p.indeg === 0) order.push(p);
      }
    }
    if (order.length < this.nodes.size) for (const node of this.nodes.values()) if (node.indeg > 0) order.push(node);

    const seen = new Set<Node>();
    const sup: Link[] = [];
    for (const node of order) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const l of node.down) l.load = 0;
      if (node.gone) continue;
      let any = false;
      for (const l of node.down) if (l.active && l.bearing) any = true;
      sup.length = 0;
      for (const l of node.down) if (l.active && l.bearing === any) sup.push(l);
      if (!sup.length) continue;
      // Own weight as a grid of point loads over the plan (≤ 6 × 6, ~1.5 m apart).
      const W = safeWeight(node);
      const b = node.el.bounds;
      if (W > 0) {
        if (b.isEmpty()) this.share(sup, 0, 0, W);
        else {
          const nx = Math.min(6, Math.max(1, Math.ceil((b.max.x - b.min.x) / 1.5)));
          const nz = Math.min(6, Math.max(1, Math.ceil((b.max.z - b.min.z) / 1.5)));
          const f = W / (nx * nz);
          for (let i = 0; i < nx; i++)
            for (let k = 0; k < nz; k++) this.share(sup, b.min.x + ((i + 0.5) / nx) * (b.max.x - b.min.x), b.min.z + ((k + 0.5) / nz) * (b.max.z - b.min.z), f);
        }
      }
      const pts = node.pts;
      for (let i = 0; i < pts.length; i += 3) this.share(sup, pts[i]!, pts[i + 1]!, pts[i + 2]!);
      // What each support took arrives at its supporter spread along the contact.
      for (const l of sup) {
        const p = l.supporter;
        if (!p || p.gone || seen.has(p) || !(l.load > 0)) continue;
        p.target += l.load;
        const r = l.region;
        const lx = r.max.x - r.min.x, lz = r.max.z - r.min.z;
        const n = Math.min(8, Math.max(1, Math.ceil(Math.max(lx, lz) / 1.5)));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          p.pts.push(lx >= lz ? r.min.x + t * lx : l.centre.x, lx >= lz ? l.centre.z : r.min.z + t * lz, l.load / n);
        }
      }
    }
    if (t0) this.stats.lastFlowMs = performance.now() - t0;
  }

  /** Share a point load f at (x, z) among the supports, by inverse plan distance to each contact. */
  private share(sup: Link[], x: number, z: number, f: number): void {
    let sum = 0;
    for (const l of sup) sum += leverWeight(l, x, z);
    if (!(sum > 0) || !(f > 0)) return;
    for (const l of sup) l.load += (f * leverWeight(l, x, z)) / sum;
  }

  /** Hand the flowed loads to the elements, skipping insignificant changes (they cost checks). */
  private push(now: number): void {
    for (const node of this.nodes.values()) {
      if (node.gone || !node.s) continue;
      const target = node.target, old = node.pushed;
      if (node.pushedAt === -Infinity) {
        if (target <= 0 && !node.up.length) continue;
      } else {
        const d = target - old;
        if (Math.abs(d) <= Math.max(PUSH_ABS, PUSH_REL * old)) continue;
        if (d < 0 && now - node.pushedAt < DECREASE_INTERVAL) continue;
      }
      node.pushed = target;
      node.pushedAt = now;
      this.stats.pushes++;
      node.s.setImposedLoad(target);
    }
  }
}

/** Bearing gap beyond which a member no longer carries what sat on it, m (≈ the delay's δ). */
const BEARING_GAP = 0.06;
const _o = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * How much of a supporter is found just under a bearing plane: short rays straight down from
 * above the plane on a grid over the region (≤ 12 × 3); a ray counts when it meets the supporter
 * within BEARING_GAP below the plane. Compared with the count at link time, so a thin-walled
 * section (an I-column head is mostly air) is judged against itself.
 */
export function bearingHits(sup: Destructible, region: THREE.Box3): number {
  const lx = region.max.x - region.min.x, lz = region.max.z - region.min.z;
  const long = Math.max(lx, lz), short = Math.min(lx, lz);
  const nl = Math.max(3, Math.min(12, Math.ceil(long / 0.05)));
  const ns = Math.max(1, Math.min(3, Math.ceil(short / 0.05)));
  const nx = lx >= lz ? nl : ns, nz = lx >= lz ? ns : nl;
  const plane = 0.5 * (region.min.y + region.max.y);
  const top = region.max.y + 0.01;
  const reach = top - plane + BEARING_GAP;
  let hits = 0;
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      _o.set(region.min.x + ((i + 0.5) / nx) * lx, top, region.min.z + ((k + 0.5) / nz) * lz);
      if (sup.raycast(_o, DOWN, reach)) hits++;
    }
  return hits;
}

/** The element's own weight (cached until it is touched), N; 0 for anything non-finite. */
function safeWeight(node: Node): number {
  if (node.wDirty) {
    const w = node.s?.weight() ?? 0;
    node.w = Number.isFinite(w) && w > 0 ? w : 0;
    node.wDirty = false;
  }
  return node.w;
}

function sameBox(a: THREE.Box3, b: THREE.Box3, tol: number): boolean {
  return Math.abs(a.min.x - b.min.x) <= tol && Math.abs(a.min.y - b.min.y) <= tol && Math.abs(a.min.z - b.min.z) <= tol
    && Math.abs(a.max.x - b.max.x) <= tol && Math.abs(a.max.y - b.max.y) <= tol && Math.abs(a.max.z - b.max.z) <= tol;
}

/** Two upright steel members, one standing on the other: a column splice. */
export function isSplice(supporter: Destructible, supported: Destructible): boolean {
  return supporter.kind === 'beam' && supported.kind === 'beam' && upright(supporter.bounds) && upright(supported.bounds);
}

function upright(b: THREE.Box3): boolean {
  return !b.isEmpty() && b.max.y - b.min.y > 3 * Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
}

/** A support's share of a point load falls with the load's plan distance from its contact. */
function leverWeight(l: Link, x: number, z: number): number {
  const r = l.region;
  const dx = x < r.min.x ? r.min.x - x : x > r.max.x ? x - r.max.x : 0;
  const dz = z < r.min.z ? r.min.z - z : z > r.max.z ? z - r.max.z : 0;
  return 1 / (Math.hypot(dx, dz) + 0.25);
}

/**
 * Time for a supported element to drop through the deformation capacity δ of its bearing once the
 * support below it has gone, t = √(2δ/g). δ ≈ 20 mm for concrete or stone bearing on concrete or
 * stone (crushing of the bearing edge), 50 mm for steel (plastic rotation of a connection before
 * it lets go), 12 mm for glass in a frame (the glazing bite), and 5 mm for a bolted column splice
 * (2 mm hole clearance, EN 1090-2 normal holes, plus bearing of the splice plates): a column is
 * continuous through its splices, so the storey above follows the one below almost at once
 * instead of hanging on for a bearing's worth of fall and opening a gap. Engineering estimates;
 * the ±15 % spread per link (a hash of its id, so runs are reproducible) keeps a row of identical
 * bearings from letting go on the same step.
 */
export function delay(l: { id: string; supporter: { el: Destructible } | null; supported: { el: Destructible }; splice?: boolean }): number {
  const a = l.supported.el.kind, b = l.supporter?.el.kind;
  const splice = l.splice ?? (!!l.supporter && isSplice(l.supporter.el, l.supported.el));
  const delta = a === 'glass' ? DELTA_GLAZING : splice ? DELTA_SPLICE : a === 'beam' || a === 'plate' || b === 'beam' || b === 'plate' ? DELTA_STEEL : DELTA_BRITTLE;
  let h = 2166136261;
  for (let i = 0; i < l.id.length; i++) h = Math.imul(h ^ l.id.charCodeAt(i), 16777619);
  const jitter = 0.85 + 0.3 * (((h >>> 0) % 1000) / 1000);
  return Math.sqrt((2 * delta) / G) * jitter;
}

