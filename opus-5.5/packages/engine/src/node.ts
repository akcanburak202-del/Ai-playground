import * as fs from 'node:fs';
import type { StorageFile, StorageProvider } from './storage/file.ts';
import { Database } from './database.ts';
import type { DatabaseOptions } from './database.ts';

/** File-backed storage for Node.js: `<path>` holds the database, `<path>-wal` the write-ahead log. */
export class NodeFile implements StorageFile {
  private fd: number;
  private length: number;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.fd = fs.openSync(path, fs.existsSync(path) ? 'r+' : 'w+');
    this.length = fs.fstatSync(this.fd).size;
  }
  size(): number {
    return this.length;
  }
  read(offset: number, length: number): Uint8Array {
    const buf = new Uint8Array(length);
    let done = 0;
    while (done < length && offset + done < this.length) {
      const n = fs.readSync(this.fd, buf, done, length - done, offset + done);
      if (n === 0) break;
      done += n;
    }
    return buf;
  }
  write(offset: number, data: Uint8Array): void {
    let done = 0;
    while (done < data.length) done += fs.writeSync(this.fd, data, done, data.length - done, offset + done);
    if (offset + data.length > this.length) this.length = offset + data.length;
  }
  truncate(size: number): void {
    fs.ftruncateSync(this.fd, size);
    this.length = size;
  }
  sync(): void {
    fs.fsyncSync(this.fd);
  }
  close(): void {
    if (this.fd >= 0) fs.closeSync(this.fd);
    this.fd = -1;
  }
}

export class NodeFileStorage implements StorageProvider {
  readonly persistent = true;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  get description(): string {
    return this.path;
  }
  openMain(): StorageFile {
    return new NodeFile(this.path);
  }
  openWal(): StorageFile {
    return new NodeFile(this.path + '-wal');
  }
}

/** Opens (or creates) a database file. */
export function openFile(path: string, opts: Omit<DatabaseOptions, 'storage'> = {}): Database {
  return new Database({ ...opts, storage: new NodeFileStorage(path) });
}

export * from './index.ts';
