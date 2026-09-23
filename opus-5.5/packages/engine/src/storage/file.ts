/**
 * Minimal random-access file abstraction. The pager only ever talks to these
 * two files (main database + write-ahead log), which lets the same engine run
 * on a real file system in Node and fully in memory in the browser.
 */
export interface StorageFile {
  size(): number;
  /** Reads `length` bytes; bytes beyond the end of the file are zero. */
  read(offset: number, length: number): Uint8Array;
  write(offset: number, data: Uint8Array): void;
  truncate(size: number): void;
  sync(): void;
  close(): void;
}

export interface StorageProvider {
  readonly description: string;
  readonly persistent: boolean;
  openMain(): StorageFile;
  openWal(): StorageFile;
}

export class MemoryFile implements StorageFile {
  private buf = new Uint8Array(0);
  private length = 0;

  size(): number {
    return this.length;
  }
  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    if (offset < this.length) out.set(this.buf.subarray(offset, Math.min(this.length, offset + length)));
    return out;
  }
  write(offset: number, data: Uint8Array): void {
    const end = offset + data.length;
    if (end > this.buf.length) {
      let cap = Math.max(this.buf.length * 2, 64 * 1024);
      while (cap < end) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    this.buf.set(data, offset);
    if (end > this.length) this.length = end;
  }
  truncate(size: number): void {
    if (size < this.length) this.buf.fill(0, size, this.length);
    this.length = size;
    if (size > this.buf.length) {
      const next = new Uint8Array(size);
      next.set(this.buf);
      this.buf = next;
    }
  }
  sync(): void {}
  close(): void {}
  /** Snapshot of the file contents (used by tests and the Studio's "download"). */
  contents(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export class MemoryStorage implements StorageProvider {
  readonly description = 'memory';
  readonly persistent = false;
  readonly main = new MemoryFile();
  readonly wal = new MemoryFile();
  openMain(): StorageFile {
    return this.main;
  }
  openWal(): StorageFile {
    return this.wal;
  }
}
