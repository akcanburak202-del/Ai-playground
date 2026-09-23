import type { Value } from '../types.ts';
import { compareValues, ErrorCode, OpusError } from '../types.ts';
import type { Pager } from './pager.ts';
import {
  clonePage,
  computeNodeSize,
  indexKeySize,
  INTERIOR_HEADER,
  isLeaf,
  NODE_HEADER,
  OVERFLOW_HEADER,
  PageType,
  TABLE_SEPARATOR_SIZE,
  tableCellSize,
} from './page.ts';
import type {
  Cell,
  IndexInteriorPage,
  IndexLeafPage,
  InteriorPage,
  LeafPage,
  NodePage,
  OverflowPage,
  OverflowRef,
  TableInteriorPage,
  TableLeafPage,
} from './page.ts';

/**
 * B+tree over pager pages.
 *
 *  - "table" trees are keyed by a numeric rowid and store the encoded row as
 *    the cell payload (spilling to overflow pages when it is large).
 *  - "index" trees store tuples of values (the indexed columns + the rowid)
 *    as keys and carry no payload.
 *
 * The root page number never changes: a root split moves the old root's
 * content to a fresh page, and a root with a single child absorbs that child.
 * Nodes split when their encoded size exceeds the page size (or, in teaching
 * mode, when they exceed `maxKeys` entries), and are merged or redistributed
 * with a sibling when they fall below a quarter of a page after deletes.
 */

export type TreeKind = 'table' | 'index';
export type Key = number | Value[];

export type TreeEvent =
  | { type: 'split'; page: number; newPage: number; leaf: boolean; separator: Key }
  | { type: 'root-split'; root: number; left: number; right: number; separator: Key }
  | { type: 'merge'; into: number; from: number; leaf: boolean }
  | { type: 'redistribute'; left: number; right: number; leaf: boolean }
  | { type: 'root-collapse'; root: number; from: number }
  | { type: 'overflow'; first: number; pages: number };

export interface BTreeOptions {
  /** Teaching mode: split nodes as soon as they hold more than this many keys. */
  maxKeys?: number;
  /** Per-column descending flags for index trees. */
  desc?: boolean[];
  observer?: (e: TreeEvent) => void;
}

interface Split {
  sep: Key;
  right: number;
}

export interface TreeCheck {
  depth: number;
  leaves: number;
  interiors: number;
  entries: number;
  overflowPages: number;
  pages: number[];
}

export interface DumpNode {
  id: number;
  leaf: boolean;
  keys: Key[];
  children: number[];
  depth: number;
  size: number;
}

export class BTree {
  readonly pager: Pager;
  readonly root: number;
  readonly kind: TreeKind;
  readonly isTable: boolean;
  maxKeys: number | undefined;
  desc: boolean[] | undefined;
  observer: ((e: TreeEvent) => void) | undefined;

  constructor(pager: Pager, root: number, kind: TreeKind, opts: BTreeOptions = {}) {
    this.pager = pager;
    this.root = root;
    this.kind = kind;
    this.isTable = kind === 'table';
    this.maxKeys = opts.maxKeys;
    this.desc = opts.desc;
    this.observer = opts.observer;
  }

  static create(pager: Pager, kind: TreeKind): number {
    return pager.allocate(kind === 'table' ? emptyTableLeaf() : emptyIndexLeaf());
  }

  // ------------------------------------------------------------------ comparison helpers

  cmp(a: Key, b: Key): number {
    if (this.isTable) return (a as number) - (b as number);
    const x = a as Value[];
    const y = b as Value[];
    const desc = this.desc;
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const c = compareValues(x[i], y[i]);
      if (c !== 0) return desc && desc[i] ? -c : c;
    }
    return x.length - y.length;
  }

  /** Compares only the first `prefix.length` columns of an index key. */
  cmpPrefix(key: Key, prefix: Key): number {
    if (this.isTable) return (key as number) - (prefix as number);
    const x = key as Value[];
    const y = prefix as Value[];
    const desc = this.desc;
    for (let i = 0; i < y.length; i++) {
      const c = compareValues(x[i], y[i]);
      if (c !== 0) return desc && desc[i] ? -c : c;
    }
    return 0;
  }

  /** First index i with cmp(keys[i], key) >= 0 (or > 0 when strict). */
  private search(keys: Key[], key: Key, strict: boolean, prefix: boolean): number {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const c = prefix ? this.cmpPrefix(keys[mid], key) : this.cmp(keys[mid], key);
      if (c < 0 || (strict && c === 0)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private separatorSize(key: Key): number {
    return this.isTable ? TABLE_SEPARATOR_SIZE : indexKeySize(key as Value[]) + 4;
  }

  private get pageSize(): number {
    return this.pager.pageSize;
  }

  /** Largest payload stored inline in a table leaf (guarantees >= 4 cells per page). */
  get maxLocal(): number {
    return Math.floor((this.pageSize - NODE_HEADER) / 4) - 8 - 3;
  }
  get maxIndexKey(): number {
    return Math.floor((this.pageSize - INTERIOR_HEADER) / 4) - 4;
  }

  private overfull(p: NodePage): boolean {
    return p.size > this.pageSize || (this.maxKeys !== undefined && p.keys.length > this.maxKeys);
  }
  private underfull(p: NodePage): boolean {
    if (p.keys.length === 0) return true;
    if (this.maxKeys !== undefined) return p.keys.length < Math.floor(this.maxKeys / 2);
    return p.size < this.pageSize / 4;
  }

  // ------------------------------------------------------------------ overflow chains

  private writeOverflow(payload: Uint8Array): OverflowRef {
    const chunk = this.pageSize - OVERFLOW_HEADER;
    const pages = Math.ceil(payload.length / chunk);
    let next = 0;
    for (let i = pages - 1; i >= 0; i--) {
      const data = payload.slice(i * chunk, Math.min(payload.length, (i + 1) * chunk));
      next = this.pager.allocate({ type: PageType.overflow, next, data });
    }
    this.observer?.({ type: 'overflow', first: next, pages });
    return { first: next, length: payload.length };
  }

  private freeOverflow(ref: OverflowRef): void {
    let id = ref.first;
    while (id !== 0) {
      const p = this.pager.get(id) as OverflowPage;
      const next = p.next;
      this.pager.free(id);
      id = next;
    }
  }

  readCell(cell: Cell): Uint8Array {
    if (cell instanceof Uint8Array) return cell;
    const out = new Uint8Array(cell.length);
    let off = 0;
    let id = cell.first;
    while (id !== 0 && off < cell.length) {
      const p = this.pager.get(id);
      if (p.type !== PageType.overflow) throw new OpusError(ErrorCode.corrupt, `page ${id} is not an overflow page`);
      out.set(p.data, off);
      off += p.data.length;
      id = p.next;
    }
    if (off !== cell.length) throw new OpusError(ErrorCode.corrupt, 'overflow chain is shorter than the payload');
    return out;
  }

  private makeCell(payload: Uint8Array): Cell {
    return payload.length > this.maxLocal ? this.writeOverflow(payload) : payload;
  }

  // ------------------------------------------------------------------ lookup

  /** Returns the payload stored under a rowid (table trees). */
  get(key: number): Uint8Array | undefined {
    const pager = this.pager;
    let node = pager.get(this.root) as TableLeafPage | TableInteriorPage;
    while (node.type === PageType.tableInterior) {
      const keys = node.keys;
      let lo = 0;
      let hi = keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keys[mid] <= key) lo = mid + 1;
        else hi = mid;
      }
      node = pager.get(node.children[lo]) as TableLeafPage | TableInteriorPage;
    }
    const keys = node.keys;
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    if (lo < keys.length && keys[lo] === key) {
      const c = node.cells[lo];
      return c instanceof Uint8Array ? c : this.readCell(c);
    }
    return undefined;
  }

  has(key: Key): boolean {
    let node = this.pager.get(this.root) as NodePage;
    while (!isLeaf(node)) node = this.pager.get(node.children[this.search(node.keys, key, true, false)]) as NodePage;
    const i = this.search(node.keys, key, false, false);
    return i < node.keys.length && this.cmp(node.keys[i], key) === 0;
  }

  /** Largest key in the tree (used to allocate the next rowid). */
  lastKey(): Key | undefined {
    let node = this.pager.get(this.root) as NodePage;
    while (!isLeaf(node)) node = this.pager.get(node.children[node.children.length - 1]) as NodePage;
    return node.keys.length ? node.keys[node.keys.length - 1] : undefined;
  }

  cursor(): Cursor {
    return new Cursor(this);
  }

  // ------------------------------------------------------------------ insert

  /**
   * Inserts a key (and payload for table trees). Returns false if the key
   * already existed; with `replace` the existing entry is overwritten.
   */
  insert(key: Key, payload?: Uint8Array, replace = false): boolean {
    let cell: Cell | undefined;
    if (this.isTable) {
      if (!payload) throw new OpusError(ErrorCode.internal, 'table insert requires a payload');
      cell = this.makeCell(payload);
    } else if (indexKeySize(key as Value[]) > this.maxIndexKey) {
      throw new OpusError(ErrorCode.featureNotSupported, `index key too large (max ${this.maxIndexKey} bytes)`);
    }
    const res = { existed: false };
    const split = this.insertRec(this.root, key, cell, true, replace, res);
    if (split) this.splitRoot(split);
    if (res.existed && !replace && cell && !(cell instanceof Uint8Array)) this.freeOverflow(cell);
    return !res.existed;
  }

  private splitRoot(split: Split): void {
    const rootPage = this.pager.get(this.root) as NodePage;
    const left = this.pager.allocate(clonePage(rootPage));
    const interior: InteriorPage = this.isTable
      ? { type: PageType.tableInterior, keys: [split.sep as number], children: [left, split.right], size: 0 }
      : { type: PageType.indexInterior, keys: [split.sep as Value[]], children: [left, split.right], size: 0 };
    interior.size = computeNodeSize(interior);
    this.pager.put(this.root, interior);
    this.observer?.({ type: 'root-split', root: this.root, left, right: split.right, separator: split.sep });
  }

  private insertRec(id: number, key: Key, cell: Cell | undefined, rightmost: boolean, replace: boolean, res: { existed: boolean }): Split | null {
    const node = this.pager.get(id) as NodePage;
    if (isLeaf(node)) {
      const i = this.search(node.keys, key, false, false);
      if (i < node.keys.length && this.cmp(node.keys[i], key) === 0) {
        res.existed = true;
        if (!replace || !this.isTable) return null;
        const w = this.pager.write(id) as TableLeafPage;
        const old = w.cells[i];
        if (!(old instanceof Uint8Array)) this.freeOverflow(old);
        w.size += tableCellSize(cell!) - tableCellSize(old);
        w.cells[i] = cell!;
        return this.overfull(w) ? this.splitLeaf(id, w, false) : null;
      }
      const append = rightmost && i === node.keys.length && this.maxKeys === undefined;
      const w = this.pager.write(id) as LeafPage;
      if (w.type === PageType.tableLeaf) {
        w.keys.splice(i, 0, key as number);
        w.cells.splice(i, 0, cell!);
        w.size += tableCellSize(cell!);
      } else {
        w.keys.splice(i, 0, key as Value[]);
        w.size += indexKeySize(key as Value[]);
      }
      return this.overfull(w) ? this.splitLeaf(id, w, append) : null;
    }
    const ci = this.search(node.keys, key, true, false);
    const childId = node.children[ci];
    const lastChild = ci === node.children.length - 1;
    const split = this.insertRec(childId, key, cell, rightmost && lastChild, replace, res);
    if (!split) return null;
    const w = this.pager.write(id) as InteriorPage;
    this.insertSeparator(w, ci, split);
    return this.overfull(w) ? this.splitInterior(id, w) : null;
  }

  private insertSeparator(w: InteriorPage, ci: number, split: Split): void {
    if (w.type === PageType.tableInterior) w.keys.splice(ci, 0, split.sep as number);
    else w.keys.splice(ci, 0, split.sep as Value[]);
    w.children.splice(ci + 1, 0, split.right);
    w.size += this.separatorSize(split.sep);
  }

  /** Chooses how many leading entries stay in the left node so both halves hold ~half the bytes. */
  private balancedSplitPoint(sizes: number[], header: number): number {
    const n = sizes.length;
    if (this.maxKeys !== undefined) return Math.ceil(n / 2);
    let total = 0;
    for (const s of sizes) total += s;
    let acc = 0;
    let k = 0;
    while (k < n - 1 && acc + sizes[k] / 2 < total / 2) acc += sizes[k++];
    k = Math.max(1, Math.min(n - 1, k));
    // make sure both sides fit
    while (k > 1 && header + prefixSum(sizes, 0, k) > this.pageSize) k--;
    while (k < n - 1 && header + prefixSum(sizes, k, n) > this.pageSize) k++;
    return k;
  }

  private entrySizes(p: LeafPage): number[] {
    return p.type === PageType.tableLeaf ? p.cells.map(tableCellSize) : p.keys.map((k) => indexKeySize(k));
  }

  private splitLeaf(id: number, w: LeafPage, append: boolean): Split {
    const n = w.keys.length;
    const k = append ? n - 1 : this.balancedSplitPoint(this.entrySizes(w), NODE_HEADER);
    let right: LeafPage;
    if (w.type === PageType.tableLeaf) {
      right = { type: PageType.tableLeaf, keys: w.keys.splice(k), cells: w.cells.splice(k), size: 0 };
    } else {
      right = { type: PageType.indexLeaf, keys: w.keys.splice(k), size: 0 };
    }
    right.size = computeNodeSize(right);
    w.size = computeNodeSize(w);
    const rightId = this.pager.allocate(right);
    const sep = right.keys[0];
    this.observer?.({ type: 'split', page: id, newPage: rightId, leaf: true, separator: sep });
    return { sep, right: rightId };
  }

  private splitInterior(id: number, w: InteriorPage): Split {
    const n = w.keys.length;
    let m: number;
    if (this.maxKeys !== undefined) m = Math.floor(n / 2);
    else {
      const sizes = w.keys.map((k: Key) => this.separatorSize(k));
      m = Math.max(1, Math.min(n - 2, this.balancedSplitPoint(sizes, INTERIOR_HEADER)));
    }
    const sep = w.keys[m];
    let right: InteriorPage;
    if (w.type === PageType.tableInterior) {
      right = { type: PageType.tableInterior, keys: w.keys.splice(m + 1), children: w.children.splice(m + 1), size: 0 };
      w.keys.length = m;
    } else {
      right = { type: PageType.indexInterior, keys: w.keys.splice(m + 1), children: w.children.splice(m + 1), size: 0 };
      w.keys.length = m;
    }
    right.size = computeNodeSize(right);
    w.size = computeNodeSize(w);
    const rightId = this.pager.allocate(right);
    this.observer?.({ type: 'split', page: id, newPage: rightId, leaf: false, separator: sep });
    return { sep, right: rightId };
  }

  // ------------------------------------------------------------------ delete

  delete(key: Key): boolean {
    const res = this.deleteRec(this.root, key);
    if (!res.found) return false;
    if (res.split) this.splitRoot(res.split);
    let r = this.pager.get(this.root) as NodePage;
    while (!isLeaf(r) && r.keys.length === 0) {
      const only = r.children[0];
      this.pager.put(this.root, clonePage(this.pager.get(only)));
      this.pager.free(only);
      this.observer?.({ type: 'root-collapse', root: this.root, from: only });
      r = this.pager.get(this.root) as NodePage;
    }
    return true;
  }

  private deleteRec(id: number, key: Key): { found: boolean; split: Split | null } {
    const node = this.pager.get(id) as NodePage;
    if (isLeaf(node)) {
      const i = this.search(node.keys, key, false, false);
      if (i >= node.keys.length || this.cmp(node.keys[i], key) !== 0) return { found: false, split: null };
      const w = this.pager.write(id) as LeafPage;
      if (w.type === PageType.tableLeaf) {
        const cell = w.cells[i];
        if (!(cell instanceof Uint8Array)) this.freeOverflow(cell);
        w.size -= tableCellSize(cell);
        w.cells.splice(i, 1);
        w.keys.splice(i, 1);
      } else {
        w.size -= indexKeySize(w.keys[i]);
        w.keys.splice(i, 1);
      }
      return { found: true, split: null };
    }
    const ci = this.search(node.keys, key, true, false);
    const childId = node.children[ci];
    const res = this.deleteRec(childId, key);
    if (!res.found) return res;
    if (res.split) this.insertSeparator(this.pager.write(id) as InteriorPage, ci, res.split);
    if (this.underfull(this.pager.get(childId) as NodePage)) this.rebalance(id, ci);
    const cur = this.pager.get(id) as NodePage;
    if (this.overfull(cur)) return { found: true, split: this.splitInterior(id, this.pager.write(id) as InteriorPage) };
    return { found: true, split: null };
  }

  private rebalance(parentId: number, ci: number): void {
    const parent = this.pager.get(parentId) as InteriorPage;
    if (parent.children.length < 2) return;
    const li = ci > 0 ? ci - 1 : ci;
    const leftId = parent.children[li];
    const rightId = parent.children[li + 1];
    const L = this.pager.write(leftId) as NodePage;
    const R = this.pager.write(rightId) as NodePage;
    const P = this.pager.write(parentId) as InteriorPage;
    const oldSep = P.keys[li];

    if (isLeaf(L)) {
      const Rl = R as LeafPage;
      const fits =
        this.maxKeys !== undefined ? L.keys.length + Rl.keys.length <= this.maxKeys : L.size + Rl.size - NODE_HEADER <= this.pageSize;
      if (fits) {
        if (L.type === PageType.tableLeaf) {
          const r = Rl as TableLeafPage;
          L.keys.push(...r.keys);
          L.cells.push(...r.cells);
        } else L.keys.push(...(Rl as IndexLeafPage).keys);
        L.size = computeNodeSize(L);
        this.removeChild(P, li);
        this.pager.free(rightId);
        this.observer?.({ type: 'merge', into: leftId, from: rightId, leaf: true });
        return;
      }
      // redistribute
      if (L.type === PageType.tableLeaf) {
        const r = Rl as TableLeafPage;
        const keys = L.keys.concat(r.keys);
        const cells = L.cells.concat(r.cells);
        const k = this.balancedSplitPoint(cells.map(tableCellSize), NODE_HEADER);
        L.keys = keys.slice(0, k);
        L.cells = cells.slice(0, k);
        r.keys = keys.slice(k);
        r.cells = cells.slice(k);
      } else {
        const r = Rl as IndexLeafPage;
        const keys = L.keys.concat(r.keys);
        const k = this.balancedSplitPoint(keys.map((x) => indexKeySize(x)), NODE_HEADER);
        L.keys = keys.slice(0, k);
        r.keys = keys.slice(k);
      }
      L.size = computeNodeSize(L);
      Rl.size = computeNodeSize(Rl);
      this.replaceSeparator(P, li, oldSep, Rl.keys[0]);
      this.observer?.({ type: 'redistribute', left: leftId, right: rightId, leaf: true });
      return;
    }

    const Li = L as InteriorPage;
    const Ri = R as InteriorPage;
    const fits =
      this.maxKeys !== undefined
        ? Li.keys.length + 1 + Ri.keys.length <= this.maxKeys
        : Li.size + Ri.size - INTERIOR_HEADER + this.separatorSize(oldSep) <= this.pageSize;
    const keys = (Li.keys as Key[]).concat([oldSep], Ri.keys as Key[]);
    const children = Li.children.concat(Ri.children);
    if (fits) {
      setInterior(Li, keys, children);
      Li.size = computeNodeSize(Li);
      this.removeChild(P, li);
      this.pager.free(rightId);
      this.observer?.({ type: 'merge', into: leftId, from: rightId, leaf: false });
      return;
    }
    let m: number;
    if (this.maxKeys !== undefined) m = Math.floor(keys.length / 2);
    else m = Math.min(keys.length - 2, Math.max(1, this.balancedSplitPoint(keys.map((k) => this.separatorSize(k)), INTERIOR_HEADER)));
    const newSep = keys[m];
    setInterior(Li, keys.slice(0, m), children.slice(0, m + 1));
    setInterior(Ri, keys.slice(m + 1), children.slice(m + 1));
    Li.size = computeNodeSize(Li);
    Ri.size = computeNodeSize(Ri);
    this.replaceSeparator(P, li, oldSep, newSep);
    this.observer?.({ type: 'redistribute', left: leftId, right: rightId, leaf: false });
  }

  private removeChild(P: InteriorPage, li: number): void {
    P.size -= this.separatorSize(P.keys[li]);
    P.keys.splice(li, 1);
    P.children.splice(li + 1, 1);
  }

  private replaceSeparator(P: InteriorPage, li: number, oldSep: Key, newSep: Key): void {
    P.size += this.separatorSize(newSep) - this.separatorSize(oldSep);
    (P.keys as Key[])[li] = newSep;
  }

  // ------------------------------------------------------------------ bulk operations

  /** Frees every page of the tree; the root is freed too unless `keepRoot`. */
  destroy(keepRoot = false): void {
    const visit = (id: number) => {
      const node = this.pager.get(id) as NodePage;
      if (!isLeaf(node)) for (const c of node.children) visit(c);
      else if (node.type === PageType.tableLeaf) for (const c of node.cells) if (!(c instanceof Uint8Array)) this.freeOverflow(c);
      if (id !== this.root) this.pager.free(id);
    };
    visit(this.root);
    if (keepRoot) this.pager.put(this.root, this.isTable ? emptyTableLeaf() : emptyIndexLeaf());
    else this.pager.free(this.root);
  }

  /** Exact number of entries (walks every leaf). */
  count(): number {
    const visit = (id: number): number => {
      const node = this.pager.get(id) as NodePage;
      if (isLeaf(node)) return node.keys.length;
      let n = 0;
      for (const c of node.children) n += visit(c);
      return n;
    };
    return visit(this.root);
  }

  /** Cheap cardinality estimate: product of fan-outs along the leftmost path. */
  estimateCount(): number {
    let node = this.pager.get(this.root) as NodePage;
    let mult = 1;
    while (!isLeaf(node)) {
      mult *= node.children.length;
      node = this.pager.get(node.children[Math.floor(node.children.length / 2)]) as NodePage;
    }
    return mult * node.keys.length;
  }

  depth(): number {
    let d = 1;
    let node = this.pager.get(this.root) as NodePage;
    while (!isLeaf(node)) {
      d++;
      node = this.pager.get(node.children[0]) as NodePage;
    }
    return d;
  }

  /** Breadth-first dump of the tree structure (for visualisation). */
  dump(maxNodes = 2000): DumpNode[] {
    const out: DumpNode[] = [];
    let level = [this.root];
    let depth = 0;
    while (level.length && out.length < maxNodes) {
      const next: number[] = [];
      for (const id of level) {
        if (out.length >= maxNodes) break;
        const node = this.pager.get(id) as NodePage;
        const leaf = isLeaf(node);
        out.push({ id, leaf, keys: node.keys.slice(), children: leaf ? [] : (node as InteriorPage).children.slice(), depth, size: node.size });
        if (!leaf) next.push(...(node as InteriorPage).children);
      }
      level = next;
      depth++;
    }
    return out;
  }

  /** Verifies every structural invariant; throws on the first violation. */
  check(): TreeCheck {
    const result: TreeCheck = { depth: -1, leaves: 0, interiors: 0, entries: 0, overflowPages: 0, pages: [] };
    const fail = (msg: string): never => {
      throw new OpusError(ErrorCode.corrupt, `b-tree ${this.root}: ${msg}`);
    };
    const visit = (id: number, lo: Key | undefined, hi: Key | undefined, depth: number): void => {
      const node = this.pager.get(id);
      if (node.type !== (this.isTable ? PageType.tableLeaf : PageType.indexLeaf) && node.type !== (this.isTable ? PageType.tableInterior : PageType.indexInterior)) {
        fail(`page ${id} has unexpected type ${node.type}`);
      }
      const n = node as NodePage;
      result.pages.push(id);
      const size = computeNodeSize(n);
      if (size !== n.size) fail(`page ${id} size bookkeeping is ${n.size}, actual ${size}`);
      if (size > this.pageSize) fail(`page ${id} overflows (${size} bytes)`);
      for (let i = 0; i < n.keys.length; i++) {
        if (i > 0 && this.cmp(n.keys[i - 1], n.keys[i]) >= 0) fail(`page ${id} keys out of order at ${i}`);
        if (lo !== undefined && this.cmp(n.keys[i], lo) < 0) fail(`page ${id} key below lower bound`);
        if (hi !== undefined && this.cmp(n.keys[i], hi) >= 0) fail(`page ${id} key above upper bound`);
      }
      if (isLeaf(n)) {
        if (result.depth === -1) result.depth = depth;
        else if (result.depth !== depth) fail(`leaf ${id} at depth ${depth}, expected ${result.depth}`);
        if (n.keys.length === 0 && id !== this.root) fail(`non-root leaf ${id} is empty`);
        result.leaves++;
        result.entries += n.keys.length;
        if (n.type === PageType.tableLeaf) {
          if (n.cells.length !== n.keys.length) fail(`page ${id} has ${n.cells.length} cells for ${n.keys.length} keys`);
          for (const c of n.cells) {
            if (c instanceof Uint8Array) continue;
            let pid = c.first;
            let len = 0;
            while (pid !== 0) {
              const op = this.pager.get(pid);
              if (op.type !== PageType.overflow) fail(`overflow page ${pid} has type ${op.type}`);
              const o = op as OverflowPage;
              result.pages.push(pid);
              result.overflowPages++;
              len += o.data.length;
              pid = o.next;
            }
            if (len !== c.length) fail(`overflow chain length ${len} != ${c.length}`);
          }
        }
        return;
      }
      result.interiors++;
      const it = n as InteriorPage;
      if (it.children.length !== it.keys.length + 1) fail(`page ${id} has ${it.children.length} children for ${it.keys.length} keys`);
      if (it.keys.length === 0) fail(`interior page ${id} has no keys`);
      for (let i = 0; i < it.children.length; i++) {
        visit(it.children[i], i === 0 ? lo : it.keys[i - 1], i === it.keys.length ? hi : it.keys[i], depth + 1);
      }
    };
    visit(this.root, undefined, undefined, 0);
    result.depth += 1;
    return result;
  }
}

function prefixSum(a: number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return s;
}

function setInterior(p: InteriorPage, keys: Key[], children: number[]): void {
  if (p.type === PageType.tableInterior) (p as TableInteriorPage).keys = keys as number[];
  else (p as IndexInteriorPage).keys = keys as Value[][];
  p.children = children;
}

export function emptyTableLeaf(): TableLeafPage {
  return { type: PageType.tableLeaf, keys: [], cells: [], size: NODE_HEADER };
}
export function emptyIndexLeaf(): IndexLeafPage {
  return { type: PageType.indexLeaf, keys: [], size: NODE_HEADER };
}

interface Frame {
  node: NodePage;
  idx: number;
}

/**
 * Bidirectional cursor. Keeps the root-to-leaf path on a stack so moving to
 * the neighbouring leaf is amortised O(1) without sibling pointers. A cursor
 * is invalidated by any modification of its tree.
 */
export class Cursor {
  private readonly tree: BTree;
  private stack: Frame[] = [];
  valid = false;

  constructor(tree: BTree) {
    this.tree = tree;
  }

  private node(id: number): NodePage {
    return this.tree.pager.get(id) as NodePage;
  }

  private descendLeft(id: number): void {
    for (;;) {
      const node = this.node(id);
      this.stack.push({ node, idx: 0 });
      if (isLeaf(node)) return;
      id = (node as InteriorPage).children[0];
    }
  }

  private descendRight(id: number): void {
    for (;;) {
      const node = this.node(id);
      if (isLeaf(node)) {
        this.stack.push({ node, idx: node.keys.length - 1 });
        return;
      }
      const it = node as InteriorPage;
      this.stack.push({ node, idx: it.children.length - 1 });
      id = it.children[it.children.length - 1];
    }
  }

  first(): boolean {
    this.stack = [];
    this.descendLeft(this.tree.root);
    return this.settleForward();
  }

  last(): boolean {
    this.stack = [];
    this.descendRight(this.tree.root);
    return this.settleBackward();
  }

  /**
   * Positions at the first entry whose key (compared on the prefix only for
   * index trees) is >= `key`, or > `key` when `strict`.
   */
  seek(key: Key, strict = false): boolean {
    this.stack = [];
    const t = this.tree;
    let id = t.root;
    for (;;) {
      const node = this.node(id);
      // number of keys k with cmpPrefix(k, key) < 0   (or <= 0 when strict)
      let lo = 0;
      let hi = node.keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const c = t.cmpPrefix(node.keys[mid], key);
        if (c < 0 || (strict && c === 0)) lo = mid + 1;
        else hi = mid;
      }
      this.stack.push({ node, idx: lo });
      if (isLeaf(node)) break;
      id = (node as InteriorPage).children[lo];
    }
    return this.settleForward();
  }

  /** Positions at the last entry with key <= `key` (or < `key` when strict). */
  seekLast(key: Key, strict = false): boolean {
    if (this.seek(key, !strict)) return this.prev();
    return this.last();
  }

  private settleForward(): boolean {
    const top = this.stack[this.stack.length - 1];
    if (top.idx < top.node.keys.length) return (this.valid = true);
    return this.nextLeaf();
  }

  private settleBackward(): boolean {
    const top = this.stack[this.stack.length - 1];
    if (top.idx >= 0 && top.idx < top.node.keys.length) return (this.valid = true);
    return this.prevLeaf();
  }

  private nextLeaf(): boolean {
    this.stack.pop();
    while (this.stack.length) {
      const top = this.stack[this.stack.length - 1];
      const it = top.node as InteriorPage;
      top.idx++;
      if (top.idx < it.children.length) {
        this.descendLeft(it.children[top.idx]);
        const leaf = this.stack[this.stack.length - 1];
        if (leaf.node.keys.length > 0) return (this.valid = true);
        this.stack.pop();
        continue;
      }
      this.stack.pop();
    }
    return (this.valid = false);
  }

  private prevLeaf(): boolean {
    this.stack.pop();
    while (this.stack.length) {
      const top = this.stack[this.stack.length - 1];
      const it = top.node as InteriorPage;
      top.idx--;
      if (top.idx >= 0) {
        this.descendRight(it.children[top.idx]);
        const leaf = this.stack[this.stack.length - 1];
        if (leaf.node.keys.length > 0) return (this.valid = true);
        this.stack.pop();
        continue;
      }
      this.stack.pop();
    }
    return (this.valid = false);
  }

  next(): boolean {
    if (!this.valid) return false;
    const top = this.stack[this.stack.length - 1];
    if (++top.idx < top.node.keys.length) return true;
    return this.nextLeaf();
  }

  prev(): boolean {
    if (!this.valid) return false;
    const top = this.stack[this.stack.length - 1];
    if (--top.idx >= 0) return true;
    return this.prevLeaf();
  }

  key(): Key {
    const top = this.stack[this.stack.length - 1];
    return top.node.keys[top.idx];
  }

  rowid(): number {
    const top = this.stack[this.stack.length - 1];
    return (top.node as TableLeafPage).keys[top.idx];
  }

  payload(): Uint8Array {
    const top = this.stack[this.stack.length - 1];
    const c = (top.node as TableLeafPage).cells[top.idx];
    return c instanceof Uint8Array ? c : this.tree.readCell(c);
  }

  /** Page numbers along the current root-to-leaf path (for visualising searches). */
  path(): number[] {
    const ids: number[] = [this.tree.root];
    for (let i = 0; i < this.stack.length - 1; i++) ids.push((this.stack[i].node as InteriorPage).children[this.stack[i].idx]);
    return ids;
  }
}
