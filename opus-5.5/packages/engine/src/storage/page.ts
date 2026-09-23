import type { Value } from '../types.ts';
import { ErrorCode, OpusError } from '../types.ts';
import { ByteReader, ByteWriter, recordSize, varintSize } from './codec.ts';

/**
 * On-disk page formats. Pages are decoded into plain JS objects when they
 * enter the page cache and encoded back to bytes only when they are written
 * to the WAL, so the B+tree code manipulates ordinary arrays.
 *
 *   header page (page 0)
 *     0  "OpusDB format 1\0"  16 bytes
 *     16 page size            u32
 *     20 page count           u32
 *     24 first free page      u32
 *     28 free page count      u32
 *     32 schema cookie        u32
 *     36 catalog root page    u32
 *     40 change counter       u32
 *
 *   every other page starts with a type byte and a u16 entry count:
 *     table leaf      [1][n]         n x (rowid f64, varint(len*2|ovf), payload | u32 overflow page)
 *     table interior  [2][n][child0] n x (rowid f64, child u32)
 *     index leaf      [3][n]         n x (varint(len), key record)
 *     index interior  [4][n][child0] n x (varint(len), key record, child u32)
 *     overflow        [5][next u32][len u16] data
 *     free            [6][next u32]
 */

export const PageType = {
  header: 0,
  tableLeaf: 1,
  tableInterior: 2,
  indexLeaf: 3,
  indexInterior: 4,
  overflow: 5,
  free: 6,
} as const;

export const MAGIC = 'OpusDB format 1\u0000';
export const NODE_HEADER = 3;
export const INTERIOR_HEADER = 7;
export const OVERFLOW_HEADER = 7;

/** Reference to a payload stored in a chain of overflow pages. */
export interface OverflowRef {
  first: number;
  length: number;
}
export type Cell = Uint8Array | OverflowRef;

export interface TableLeafPage {
  type: 1;
  keys: number[];
  cells: Cell[];
  size: number;
}
export interface TableInteriorPage {
  type: 2;
  keys: number[];
  children: number[];
  size: number;
}
export interface IndexLeafPage {
  type: 3;
  keys: Value[][];
  size: number;
}
export interface IndexInteriorPage {
  type: 4;
  keys: Value[][];
  children: number[];
  size: number;
}
export interface OverflowPage {
  type: 5;
  next: number;
  data: Uint8Array;
}
export interface FreePage {
  type: 6;
  next: number;
}
export interface HeaderPage {
  type: 0;
  pageSize: number;
  pageCount: number;
  freeHead: number;
  freeCount: number;
  schemaCookie: number;
  catalogRoot: number;
  changeCounter: number;
}

export type LeafPage = TableLeafPage | IndexLeafPage;
export type InteriorPage = TableInteriorPage | IndexInteriorPage;
export type NodePage = LeafPage | InteriorPage;
export type Page = NodePage | OverflowPage | FreePage | HeaderPage;

export function isLeaf(p: NodePage): p is LeafPage {
  return p.type === PageType.tableLeaf || p.type === PageType.indexLeaf;
}

export function tableCellSize(cell: Cell): number {
  if (cell instanceof Uint8Array) return 8 + varintSize(cell.length * 2) + cell.length;
  return 8 + varintSize(cell.length * 2 + 1) + 4;
}
export function indexKeySize(key: readonly Value[]): number {
  const n = recordSize(key);
  return varintSize(n) + n;
}
export const TABLE_SEPARATOR_SIZE = 12;

/** Recomputes the encoded size of a node page from scratch. */
export function computeNodeSize(p: NodePage): number {
  switch (p.type) {
    case PageType.tableLeaf: {
      let s = NODE_HEADER;
      for (const c of p.cells) s += tableCellSize(c);
      return s;
    }
    case PageType.tableInterior:
      return INTERIOR_HEADER + p.keys.length * TABLE_SEPARATOR_SIZE;
    case PageType.indexLeaf: {
      let s = NODE_HEADER;
      for (const k of p.keys) s += indexKeySize(k);
      return s;
    }
    case PageType.indexInterior: {
      let s = INTERIOR_HEADER;
      for (const k of p.keys) s += indexKeySize(k) + 4;
      return s;
    }
  }
}

export function encodePage(page: Page, pageSize: number, target?: Uint8Array, offset = 0): Uint8Array {
  const buf = target ?? new Uint8Array(pageSize);
  const w = new ByteWriter(buf, offset);
  switch (page.type) {
    case PageType.header:
      for (let i = 0; i < MAGIC.length; i++) w.u8(MAGIC.charCodeAt(i));
      w.u32(page.pageSize);
      w.u32(page.pageCount);
      w.u32(page.freeHead);
      w.u32(page.freeCount);
      w.u32(page.schemaCookie);
      w.u32(page.catalogRoot);
      w.u32(page.changeCounter);
      break;
    case PageType.tableLeaf:
      w.u8(page.type);
      w.u16(page.keys.length);
      for (let i = 0; i < page.keys.length; i++) {
        w.f64(page.keys[i]);
        const c = page.cells[i];
        if (c instanceof Uint8Array) {
          w.varint(c.length * 2);
          w.bytes(c);
        } else {
          w.varint(c.length * 2 + 1);
          w.u32(c.first);
        }
      }
      break;
    case PageType.tableInterior:
      w.u8(page.type);
      w.u16(page.keys.length);
      w.u32(page.children[0]);
      for (let i = 0; i < page.keys.length; i++) {
        w.f64(page.keys[i]);
        w.u32(page.children[i + 1]);
      }
      break;
    case PageType.indexLeaf:
      w.u8(page.type);
      w.u16(page.keys.length);
      for (const k of page.keys) {
        w.varint(recordSize(k));
        w.record(k);
      }
      break;
    case PageType.indexInterior:
      w.u8(page.type);
      w.u16(page.keys.length);
      w.u32(page.children[0]);
      for (let i = 0; i < page.keys.length; i++) {
        w.varint(recordSize(page.keys[i]));
        w.record(page.keys[i]);
        w.u32(page.children[i + 1]);
      }
      break;
    case PageType.overflow:
      w.u8(page.type);
      w.u32(page.next);
      w.u16(page.data.length);
      w.bytes(page.data);
      break;
    case PageType.free:
      w.u8(page.type);
      w.u32(page.next);
      break;
  }
  if (w.pos - offset > pageSize) throw new OpusError(ErrorCode.internal, `page overflow while encoding (${w.pos - offset} > ${pageSize})`);
  return buf;
}

export function decodePage(buf: Uint8Array, pageNo: number): Page {
  const r = new ByteReader(buf);
  if (pageNo === 0) {
    let magic = '';
    for (let i = 0; i < MAGIC.length; i++) magic += String.fromCharCode(r.u8());
    if (magic !== MAGIC) throw new OpusError(ErrorCode.corrupt, 'file is not an OpusDB database (bad magic)');
    return {
      type: 0,
      pageSize: r.u32(),
      pageCount: r.u32(),
      freeHead: r.u32(),
      freeCount: r.u32(),
      schemaCookie: r.u32(),
      catalogRoot: r.u32(),
      changeCounter: r.u32(),
    };
  }
  const type = r.u8();
  switch (type) {
    case PageType.tableLeaf: {
      const n = r.u16();
      const keys = new Array<number>(n);
      const cells = new Array<Cell>(n);
      for (let i = 0; i < n; i++) {
        keys[i] = r.f64();
        const tag = r.varint();
        const len = Math.floor(tag / 2);
        // copy the payload out of the page buffer so the page bytes can be dropped
        cells[i] = tag & 1 ? { first: r.u32(), length: len } : r.bytes(len).slice();
      }
      const p: TableLeafPage = { type, keys, cells, size: 0 };
      p.size = r.pos;
      return p;
    }
    case PageType.tableInterior: {
      const n = r.u16();
      const keys = new Array<number>(n);
      const children = new Array<number>(n + 1);
      children[0] = r.u32();
      for (let i = 0; i < n; i++) {
        keys[i] = r.f64();
        children[i + 1] = r.u32();
      }
      return { type, keys, children, size: r.pos };
    }
    case PageType.indexLeaf: {
      const n = r.u16();
      const keys = new Array<Value[]>(n);
      for (let i = 0; i < n; i++) {
        r.varint();
        keys[i] = r.record();
      }
      return { type, keys, size: r.pos };
    }
    case PageType.indexInterior: {
      const n = r.u16();
      const keys = new Array<Value[]>(n);
      const children = new Array<number>(n + 1);
      children[0] = r.u32();
      for (let i = 0; i < n; i++) {
        r.varint();
        keys[i] = r.record();
        children[i + 1] = r.u32();
      }
      return { type, keys, children, size: r.pos };
    }
    case PageType.overflow: {
      const next = r.u32();
      const len = r.u16();
      return { type, next, data: r.bytes(len).slice() };
    }
    case PageType.free:
      return { type, next: r.u32() };
    default:
      throw new OpusError(ErrorCode.corrupt, `page ${pageNo} has unknown type ${type}`);
  }
}

/** Deep-ish copy of a node page (arrays are copied, immutable payloads shared). */
export function clonePage(p: Page): Page {
  switch (p.type) {
    case PageType.tableLeaf:
      return { type: p.type, keys: p.keys.slice(), cells: p.cells.slice(), size: p.size };
    case PageType.tableInterior:
      return { type: p.type, keys: p.keys.slice(), children: p.children.slice(), size: p.size };
    case PageType.indexLeaf:
      return { type: p.type, keys: p.keys.slice(), size: p.size };
    case PageType.indexInterior:
      return { type: p.type, keys: p.keys.slice(), children: p.children.slice(), size: p.size };
    default:
      return { ...p };
  }
}
