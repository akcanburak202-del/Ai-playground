import { ErrorCode, OpusError } from '../types.ts';
import type { StorageFile, StorageProvider } from './file.ts';
import { clonePage, decodePage, encodePage, PageType } from './page.ts';
import type { HeaderPage, Page } from './page.ts';

/**
 * The pager owns the page cache and implements atomic commits through a
 * write-ahead log (WAL), in the style of SQLite's WAL mode:
 *
 *  - Modified pages stay in memory until COMMIT ("no-steal"), so rolling back
 *    a transaction is simply dropping the dirty pages.
 *  - COMMIT appends every dirty page to the WAL as a frame. The last frame of
 *    a transaction carries a commit marker. Frames are chained with a running
 *    checksum, so a torn write is detected on recovery and ignored.
 *  - Readers find the newest committed copy of a page through the in-memory
 *    WAL index, falling back to the main database file.
 *  - A checkpoint copies the newest WAL frames into the main file and resets
 *    the log.
 *  - Statement-level rollback (an INSERT failing half-way inside an explicit
 *    transaction) is handled by an undo map holding before-images of pages
 *    first touched by the current statement.
 */

export const WAL_MAGIC = 0x4f505553; // "OPUS"
export const WAL_HEADER_SIZE = 32;
export const FRAME_HEADER_SIZE = 24;
export const DEFAULT_PAGE_SIZE = 4096;

export type SyncMode = 'full' | 'normal' | 'off';

export interface PagerOptions {
  pageSize?: number;
  /** Maximum number of clean pages kept in the cache. */
  cacheSize?: number;
  synchronous?: SyncMode;
  /** Checkpoint automatically once the WAL holds this many frames. */
  checkpointFrames?: number;
}

export interface PagerStats {
  cacheHits: number;
  cacheMisses: number;
  pagesRead: number;
  framesWritten: number;
  commits: number;
  rollbacks: number;
  checkpoints: number;
  syncs: number;
  recoveredFrames: number;
}

interface Entry {
  page: Page;
  dirty: boolean;
  ref: boolean;
}

export interface WalInfo {
  frames: number;
  bytes: number;
  pagesInWal: number;
  salt: [number, number];
  checkpointSeq: number;
  commitsSinceCheckpoint: number;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** SQLite-style cumulative checksum over 32-bit little-endian words. */
function checksum(data: Uint8Array, s0: number, s1: number): [number, number] {
  const n = data.byteLength & ~7;
  if (LITTLE_ENDIAN && (data.byteOffset & 3) === 0) {
    const w = new Uint32Array(data.buffer, data.byteOffset, n >>> 2);
    for (let i = 0; i < w.length; i += 2) {
      s0 = (s0 + w[i] + s1) >>> 0;
      s1 = (s1 + w[i + 1] + s0) >>> 0;
    }
    return [s0, s1];
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < n; i += 8) {
    s0 = (s0 + dv.getUint32(i, true) + s1) >>> 0;
    s1 = (s1 + dv.getUint32(i + 4, true) + s0) >>> 0;
  }
  return [s0, s1];
}

function randomU32(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

export class Pager {
  pageSize: number;
  readonly stats: PagerStats = {
    cacheHits: 0,
    cacheMisses: 0,
    pagesRead: 0,
    framesWritten: 0,
    commits: 0,
    rollbacks: 0,
    checkpoints: 0,
    syncs: 0,
    recoveredFrames: 0,
  };
  readonly storage: StorageProvider;
  private readonly main: StorageFile;
  private readonly wal: StorageFile;
  private readonly cacheSize: number;
  readonly synchronous: SyncMode;
  private readonly checkpointFrames: number;

  private readonly cache = new Map<number, Entry>();
  private readonly dirty = new Set<number>();
  private cleanCount = 0;

  /** page number -> byte offset of the page data of its newest committed WAL frame */
  private readonly walIndex = new Map<number, number>();
  private walEnd = WAL_HEADER_SIZE;
  private walFrames = 0;
  private walCommits = 0;
  private salt1 = 0;
  private salt2 = 0;
  private ck0 = 0;
  private ck1 = 0;
  private checkpointSeq = 0;

  /** Working copy of the header; `committed` is the durable version. */
  header: HeaderPage;
  private committed: HeaderPage;
  private headerDirty = false;

  private stmtUndo: Map<number, Page | null> | null = null;
  private stmtHeader: HeaderPage | null = null;
  private stmtHeaderDirty = false;

  /** Incremented on every rollback so higher layers can drop cached metadata. */
  epoch = 0;
  /** True while the database has just been created and not yet initialised. */
  readonly isNew: boolean;

  constructor(storage: StorageProvider, opts: PagerOptions = {}) {
    this.storage = storage;
    this.main = storage.openMain();
    this.wal = storage.openWal();
    this.cacheSize = opts.cacheSize ?? 4096;
    this.synchronous = opts.synchronous ?? (storage.persistent ? 'normal' : 'off');
    this.checkpointFrames = opts.checkpointFrames ?? 1000;

    const requested = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    if (requested < 512 || requested > 65536 || (requested & (requested - 1)) !== 0) {
      throw new OpusError(ErrorCode.invalidParameter, 'page size must be a power of two between 512 and 65536');
    }
    this.pageSize = requested;

    // --- load the durable header from the main file (if any)
    let header: HeaderPage | null = null;
    if (this.main.size() >= 64) {
      const probe = decodePage(this.main.read(0, 64), 0) as HeaderPage;
      this.pageSize = probe.pageSize;
      header = probe;
    }

    // --- recover committed frames from the WAL
    this.recoverWal(header === null);
    const walHeader = this.walIndex.get(0);
    if (walHeader !== undefined) header = decodePage(this.wal.read(walHeader, this.pageSize), 0) as HeaderPage;

    this.isNew = header === null;
    if (header === null) {
      header = {
        type: 0,
        pageSize: this.pageSize,
        pageCount: 1,
        freeHead: 0,
        freeCount: 0,
        schemaCookie: 0,
        catalogRoot: 0,
        changeCounter: 0,
      };
      this.headerDirty = true;
    }
    this.header = { ...header };
    this.committed = { ...header };
  }

  // ------------------------------------------------------------------ WAL recovery

  private recoverWal(adoptPageSize: boolean): void {
    const size = this.wal.size();
    if (size < WAL_HEADER_SIZE) {
      this.resetWal();
      return;
    }
    const hdr = this.wal.read(0, WAL_HEADER_SIZE);
    const dv = new DataView(hdr.buffer);
    const magic = dv.getUint32(0, true);
    const pageSize = dv.getUint32(8, true);
    const [c0, c1] = checksum(hdr.subarray(0, 24), 0, 0);
    if (magic !== WAL_MAGIC || c0 !== dv.getUint32(24, true) || c1 !== dv.getUint32(28, true)) {
      this.resetWal();
      return;
    }
    if (adoptPageSize) this.pageSize = pageSize;
    else if (pageSize !== this.pageSize) {
      this.resetWal();
      return;
    }
    this.checkpointSeq = dv.getUint32(12, true);
    this.salt1 = dv.getUint32(16, true);
    this.salt2 = dv.getUint32(20, true);
    let s0 = c0;
    let s1 = c1;

    const frameSize = FRAME_HEADER_SIZE + this.pageSize;
    const pending = new Map<number, number>();
    let offset = WAL_HEADER_SIZE;
    let validEnd = WAL_HEADER_SIZE;
    let frames = 0;
    let commits = 0;
    let lastS0 = s0;
    let lastS1 = s1;
    while (offset + frameSize <= size) {
      const frame = this.wal.read(offset, frameSize);
      const fv = new DataView(frame.buffer);
      const pageNo = fv.getUint32(0, true);
      const commit = fv.getUint32(4, true);
      if (fv.getUint32(8, true) !== this.salt1 || fv.getUint32(12, true) !== this.salt2) break;
      [s0, s1] = checksum(frame.subarray(0, 8), s0, s1);
      [s0, s1] = checksum(frame.subarray(FRAME_HEADER_SIZE), s0, s1);
      if (s0 !== fv.getUint32(16, true) || s1 !== fv.getUint32(20, true)) break;
      pending.set(pageNo, offset + FRAME_HEADER_SIZE);
      frames++;
      offset += frameSize;
      if (commit !== 0) {
        for (const [p, o] of pending) this.walIndex.set(p, o);
        pending.clear();
        validEnd = offset;
        commits++;
        lastS0 = s0;
        lastS1 = s1;
        this.stats.recoveredFrames = frames;
      }
    }
    this.walEnd = validEnd;
    this.walFrames = this.stats.recoveredFrames;
    this.walCommits = commits;
    this.ck0 = lastS0;
    this.ck1 = lastS1;
    // discard any torn / uncommitted tail so new frames never chain onto garbage
    if (validEnd < size) this.wal.truncate(validEnd);
  }

  private resetWal(): void {
    this.salt1 = randomU32();
    this.salt2 = randomU32();
    const hdr = new Uint8Array(WAL_HEADER_SIZE);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, WAL_MAGIC, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, this.pageSize, true);
    dv.setUint32(12, this.checkpointSeq, true);
    dv.setUint32(16, this.salt1, true);
    dv.setUint32(20, this.salt2, true);
    const [c0, c1] = checksum(hdr.subarray(0, 24), 0, 0);
    dv.setUint32(24, c0, true);
    dv.setUint32(28, c1, true);
    this.wal.truncate(0);
    this.wal.write(0, hdr);
    this.ck0 = c0;
    this.ck1 = c1;
    this.walEnd = WAL_HEADER_SIZE;
    this.walFrames = 0;
    this.walCommits = 0;
    this.walIndex.clear();
  }

  // ------------------------------------------------------------------ page access

  private readCommitted(id: number): Uint8Array {
    if (id >= this.committed.pageCount) {
      throw new OpusError(ErrorCode.corrupt, `page ${id} is beyond the end of the database (${this.committed.pageCount} pages)`);
    }
    this.stats.pagesRead++;
    const off = this.walIndex.get(id);
    if (off !== undefined) return this.wal.read(off, this.pageSize);
    return this.main.read(id * this.pageSize, this.pageSize);
  }

  private load(id: number): Entry {
    let e = this.cache.get(id);
    if (e) {
      e.ref = true;
      this.stats.cacheHits++;
      return e;
    }
    this.stats.cacheMisses++;
    e = { page: decodePage(this.readCommitted(id), id), dirty: false, ref: true };
    this.cache.set(id, e);
    this.cleanCount++;
    if (this.cleanCount > this.cacheSize) this.evict();
    return e;
  }

  /** Second-chance eviction of clean pages. Dirty pages are never evicted. */
  private evict(): void {
    let budget = this.cache.size * 2;
    for (const [id, e] of this.cache) {
      if (this.cleanCount <= this.cacheSize * 0.9 || budget-- <= 0) break;
      if (e.dirty) continue;
      if (e.ref) {
        e.ref = false;
        continue;
      }
      this.cache.delete(id);
      this.cleanCount--;
    }
  }

  /** Returns a page for reading. The returned object must not be mutated. */
  get(id: number): Page {
    if (id === 0) throw new OpusError(ErrorCode.internal, 'page 0 is the header page');
    return this.load(id).page;
  }

  private recordUndo(id: number, e: Entry | undefined): void {
    if (this.stmtUndo && !this.stmtUndo.has(id)) {
      // shallow clone: node arrays are copied, payloads and keys are immutable
      this.stmtUndo.set(id, e && e.dirty ? clonePage(e.page) : null);
    }
  }

  private markDirty(id: number, e: Entry): void {
    if (!e.dirty) {
      e.dirty = true;
      this.cleanCount--;
      this.dirty.add(id);
    }
  }

  /** Returns a page for modification; the caller mutates the returned object in place. */
  write(id: number): Page {
    const e = this.load(id);
    this.recordUndo(id, e);
    this.markDirty(id, e);
    return e.page;
  }

  /** Replaces the content of a page. */
  put(id: number, page: Page): void {
    let e = this.cache.get(id);
    this.recordUndo(id, e);
    if (e) {
      e.page = page;
      e.ref = true;
      this.markDirty(id, e);
    } else {
      e = { page, dirty: true, ref: true };
      this.cache.set(id, e);
      this.dirty.add(id);
    }
  }

  allocate(page: Page): number {
    let id: number;
    if (this.header.freeHead !== 0) {
      id = this.header.freeHead;
      const free = this.get(id);
      if (free.type !== PageType.free) throw new OpusError(ErrorCode.corrupt, `free list page ${id} is not free`);
      this.header.freeHead = free.next;
      this.header.freeCount--;
    } else {
      id = this.header.pageCount++;
    }
    this.headerDirty = true;
    this.put(id, page);
    return id;
  }

  free(id: number): void {
    this.put(id, { type: PageType.free, next: this.header.freeHead });
    this.header.freeHead = id;
    this.header.freeCount++;
    this.headerDirty = true;
  }

  setHeader(fields: Partial<Omit<HeaderPage, 'type'>>): void {
    Object.assign(this.header, fields);
    this.headerDirty = true;
  }

  get hasChanges(): boolean {
    return this.dirty.size > 0 || this.headerDirty;
  }

  // ------------------------------------------------------------------ statements

  beginStatement(): void {
    this.stmtUndo = new Map();
    this.stmtHeader = { ...this.header };
    this.stmtHeaderDirty = this.headerDirty;
  }

  endStatement(): void {
    this.stmtUndo = null;
    this.stmtHeader = null;
  }

  rollbackStatement(): void {
    const undo = this.stmtUndo;
    if (!undo || !this.stmtHeader) return;
    for (const [id, before] of undo) {
      const e = this.cache.get(id);
      if (before === null) {
        if (e) {
          this.cache.delete(id);
          if (!e.dirty) this.cleanCount--;
        }
        this.dirty.delete(id);
      } else {
        const page = before;
        if (e) e.page = page;
        else this.cache.set(id, { page, dirty: true, ref: true });
        this.dirty.add(id);
      }
    }
    this.header = this.stmtHeader;
    this.headerDirty = this.stmtHeaderDirty;
    this.stmtUndo = null;
    this.stmtHeader = null;
    this.epoch++;
  }

  // ------------------------------------------------------------------ transactions

  commit(): void {
    this.stmtUndo = null;
    this.stmtHeader = null;
    if (!this.hasChanges) return;
    // The header page is only rewritten when its fields changed; the commit
    // marker goes on the last frame of the transaction either way.
    const withHeader = this.headerDirty;
    if (withHeader) this.header.changeCounter = (this.header.changeCounter + 1) >>> 0;

    const ids = [...this.dirty].sort((a, b) => a - b);
    const frameSize = FRAME_HEADER_SIZE + this.pageSize;
    const nFrames = ids.length + (withHeader ? 1 : 0);
    const buf = new Uint8Array(nFrames * frameSize);
    const words = new Uint32Array(buf.buffer);
    const put32 = (at: number, v: number) => {
      buf[at] = v & 0xff;
      buf[at + 1] = (v >>> 8) & 0xff;
      buf[at + 2] = (v >>> 16) & 0xff;
      buf[at + 3] = (v >>> 24) & 0xff;
    };
    let s0 = this.ck0;
    let s1 = this.ck1;
    const offsets: [number, number][] = [];
    for (let f = 0; f < nFrames; f++) {
      // the header page (when written) goes last
      const id = f < ids.length ? ids[f] : 0;
      const page = id === 0 ? this.header : this.cache.get(id)!.page;
      const base = f * frameSize;
      encodePage(page, this.pageSize, buf, base + FRAME_HEADER_SIZE);
      put32(base, id);
      put32(base + 4, f === nFrames - 1 ? this.header.pageCount : 0);
      put32(base + 8, this.salt1);
      put32(base + 12, this.salt2);
      if (LITTLE_ENDIAN) {
        // checksum over the first 8 header bytes and the page, straight from the word view
        const w0 = base >>> 2;
        s0 = (s0 + words[w0] + s1) >>> 0;
        s1 = (s1 + words[w0 + 1] + s0) >>> 0;
        const end = (base + frameSize) >>> 2;
        for (let i = (base + FRAME_HEADER_SIZE) >>> 2; i < end; i += 2) {
          s0 = (s0 + words[i] + s1) >>> 0;
          s1 = (s1 + words[i + 1] + s0) >>> 0;
        }
      } else {
        [s0, s1] = checksum(buf.subarray(base, base + 8), s0, s1);
        [s0, s1] = checksum(buf.subarray(base + FRAME_HEADER_SIZE, base + frameSize), s0, s1);
      }
      put32(base + 16, s0);
      put32(base + 20, s1);
      offsets.push([id, this.walEnd + base + FRAME_HEADER_SIZE]);
    }
    try {
      this.wal.write(this.walEnd, buf);
      if (this.synchronous === 'full') {
        this.wal.sync();
        this.stats.syncs++;
      }
    } catch (err) {
      throw new OpusError(ErrorCode.ioError, `failed to write WAL: ${(err as Error).message}`);
    }
    this.ck0 = s0;
    this.ck1 = s1;
    this.walEnd += buf.length;
    this.walFrames += nFrames;
    this.walCommits++;
    for (const [id, off] of offsets) this.walIndex.set(id, off);
    for (const id of ids) {
      const e = this.cache.get(id);
      if (e) {
        e.dirty = false;
        this.cleanCount++;
      }
    }
    this.dirty.clear();
    this.headerDirty = false;
    this.committed = { ...this.header };
    this.stats.commits++;
    this.stats.framesWritten += nFrames;
    if (this.cleanCount > this.cacheSize) this.evict();
    if (this.walFrames >= this.checkpointFrames) this.checkpoint();
  }

  rollback(): void {
    for (const id of this.dirty) this.cache.delete(id);
    this.dirty.clear();
    this.header = { ...this.committed };
    this.headerDirty = false;
    this.stmtUndo = null;
    this.stmtHeader = null;
    this.stats.rollbacks++;
    this.epoch++;
  }

  /** Copies the newest version of every page in the WAL into the main file and resets the WAL. */
  checkpoint(): number {
    if (this.hasChanges) throw new OpusError(ErrorCode.activeTransaction, 'cannot checkpoint inside a transaction');
    const pages = this.walIndex.size;
    if (pages === 0) return 0;
    const ids = [...this.walIndex.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const data = this.wal.read(this.walIndex.get(id)!, this.pageSize);
      this.main.write(id * this.pageSize, data);
    }
    const expected = this.committed.pageCount * this.pageSize;
    if (this.main.size() < expected) this.main.write(expected - 1, new Uint8Array(1));
    if (this.synchronous !== 'off') {
      this.main.sync();
      this.stats.syncs++;
    }
    this.checkpointSeq++;
    this.resetWal();
    if (this.synchronous !== 'off') {
      this.wal.sync();
      this.stats.syncs++;
    }
    this.stats.checkpoints++;
    return pages;
  }

  walInfo(): WalInfo {
    return {
      frames: this.walFrames,
      bytes: this.walEnd,
      pagesInWal: this.walIndex.size,
      salt: [this.salt1, this.salt2],
      checkpointSeq: this.checkpointSeq,
      commitsSinceCheckpoint: this.walCommits,
    };
  }

  /** Page numbers whose newest version lives in the WAL (for the Studio storage view). */
  walPages(): number[] {
    return [...this.walIndex.keys()];
  }

  cacheInfo(): { cached: number; dirty: number; capacity: number } {
    return { cached: this.cache.size, dirty: this.dirty.size, capacity: this.cacheSize };
  }

  close(): void {
    if (this.hasChanges) this.rollback();
    try {
      if (this.storage.persistent && this.walFrames > 0) this.checkpoint();
    } finally {
      this.main.close();
      this.wal.close();
    }
  }
}
