import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { randomInt } from 'node:crypto';
import { ErrorCode, OpusError, parse } from '@opusdb/engine';
import type { DataType, Database, QueryResult, Session, Value } from '@opusdb/engine';
import { errorPayload, runStatement } from './runner.ts';

/**
 * PostgreSQL frontend/backend protocol v3 — enough for psql, JDBC-style
 * drivers and node-postgres: startup (no TLS, trust auth), the simple query
 * protocol, the extended protocol (Parse/Bind/Describe/Execute/Sync/Close),
 * error reporting with SQLSTATE codes and positions, and query cancellation.
 */

type ParsedStatement = ReturnType<typeof parse>[number];

const PROTOCOL_V3 = 196608;
const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

const OID = { bool: 16, int8: 20, int2: 21, int4: 23, text: 25, float4: 700, float8: 701, numeric: 1700, varchar: 1043, unknown: 705 } as const;

function typeOid(t: DataType): number {
  switch (t) {
    case 'INTEGER':
      return OID.int8;
    case 'REAL':
      return OID.float8;
    case 'BOOLEAN':
      return OID.bool;
    default:
      return OID.text;
  }
}

class Writer {
  private parts: Buffer[] = [];
  private len = 0;
  byte(v: number): this {
    return this.raw(Buffer.from([v]));
  }
  int16(v: number): this {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    return this.raw(b);
  }
  int32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    return this.raw(b);
  }
  cstr(s: string): this {
    return this.raw(Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]));
  }
  raw(b: Buffer): this {
    this.parts.push(b);
    this.len += b.length;
    return this;
  }
  /** Frames the accumulated body as a protocol message of the given type. */
  message(type: string): Buffer {
    const head = Buffer.alloc(5);
    head.write(type, 0, 'ascii');
    head.writeInt32BE(this.len + 4, 1);
    return Buffer.concat([head, ...this.parts]);
  }
}

class Reader {
  private readonly buf: Buffer;
  pos = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  int16(): number {
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int32(): number {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  cstr(): string {
    const end = this.buf.indexOf(0, this.pos);
    const s = this.buf.toString('utf8', this.pos, end < 0 ? this.buf.length : end);
    this.pos = end < 0 ? this.buf.length : end + 1;
    return s;
  }
  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  byte(): number {
    return this.buf[this.pos++];
  }
}

function formatValue(v: Value, t: DataType): string | null {
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    if (t === 'BOOLEAN') return v ? 't' : 'f';
    return String(v);
  }
  return v;
}

function commandTag(r: QueryResult): string {
  switch (r.command) {
    case 'SELECT':
      return `SELECT ${r.rows.length}`;
    case 'INSERT':
      return `INSERT 0 ${r.rowsAffected}`;
    case 'UPDATE':
    case 'DELETE':
      return `${r.command} ${r.rowsAffected}`;
    default:
      return r.command;
  }
}

function decodeParam(raw: Buffer | null, format: number, oid: number): Value {
  if (raw === null) return null;
  if (format === 1) {
    switch (oid) {
      case OID.int2:
        return raw.readInt16BE(0);
      case OID.int4:
        return raw.readInt32BE(0);
      case OID.int8:
        return Number(raw.readBigInt64BE(0));
      case OID.float4:
        return raw.readFloatBE(0);
      case OID.float8:
        return raw.readDoubleBE(0);
      case OID.bool:
        return raw[0] !== 0;
      default:
        return raw.toString('utf8');
    }
  }
  const s = raw.toString('utf8');
  switch (oid) {
    case OID.int2:
    case OID.int4:
    case OID.int8:
    case OID.float4:
    case OID.float8:
    case OID.numeric:
      return Number(s);
    case OID.bool:
      return s === 't' || s === 'true' || s === '1' || s === 'on' || s === 'yes';
    default:
      return s;
  }
}

interface Prepared {
  parsed: ParsedStatement | null; // null = empty query
  paramTypes: number[];
  columns?: { name: string; type: DataType }[];
}

interface Portal {
  stmt: Prepared;
  params: Value[];
  result?: QueryResult;
  sent: number;
}

const connections = new Map<number, PgConnection>();

class PgConnection {
  private readonly socket: Socket;
  private readonly db: Database;
  private readonly session: Session;
  private buf: Buffer = Buffer.alloc(0);
  private started = false;
  private closed = false;
  private readonly prepared = new Map<string, Prepared>();
  private readonly portals = new Map<string, Portal>();
  private skipUntilSync = false;
  private queue: Promise<void> = Promise.resolve();
  readonly pid = randomInt(1, 2 ** 31 - 1);
  readonly secret = randomInt(1, 2 ** 31 - 1);
  private readonly log: (m: string) => void;

  constructor(socket: Socket, db: Database, log: (m: string) => void) {
    this.socket = socket;
    this.db = db;
    this.session = db.session();
    this.log = log;
    socket.setNoDelay(true);
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.cleanup());
    socket.on('error', () => this.cleanup());
  }

  destroy(): void {
    this.socket.destroy();
    this.cleanup();
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    connections.delete(this.pid);
    this.session.close();
  }

  private send(...msgs: Buffer[]): void {
    if (!this.closed) this.socket.write(msgs.length === 1 ? msgs[0] : Buffer.concat(msgs));
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (!this.started) {
        if (this.buf.length < 4) return;
        const len = this.buf.readInt32BE(0);
        if (this.buf.length < len) return;
        const body = this.buf.subarray(4, len);
        this.buf = this.buf.subarray(len);
        this.handleStartup(body);
        if (this.closed) return;
        continue;
      }
      if (this.buf.length < 5) return;
      const type = String.fromCharCode(this.buf[0]);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const body = Buffer.from(this.buf.subarray(5, 1 + len));
      this.buf = this.buf.subarray(1 + len);
      this.queue = this.queue.then(() => this.handle(type, body)).catch((e) => this.log(`pg: ${(e as Error).message}`));
    }
  }

  private handleStartup(body: Buffer): void {
    const r = new Reader(body);
    const code = r.int32();
    if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
      this.socket.write('N');
      return;
    }
    if (code === CANCEL_REQUEST) {
      const pid = r.int32();
      const secret = r.int32();
      const target = connections.get(pid);
      if (target && target.secret === secret) target.session.interrupt();
      this.socket.end();
      this.closed = true;
      return;
    }
    if (code !== PROTOCOL_V3) {
      this.send(this.errorMessage({ message: `unsupported frontend protocol ${code >> 16}.${code & 0xffff}`, code: '0A000' }, 'FATAL'));
      this.socket.end();
      this.closed = true;
      return;
    }
    const params: Record<string, string> = {};
    while (r.pos < body.length) {
      const k = r.cstr();
      if (!k) break;
      params[k] = r.cstr();
    }
    this.started = true;
    connections.set(this.pid, this);
    this.log(`pg: connection from ${params.user ?? '?'}${params.application_name ? ` (${params.application_name})` : ''}`);
    const status = (k: string, v: string) => new Writer().cstr(k).cstr(v).message('S');
    this.send(
      new Writer().int32(0).message('R'),
      status('server_version', '16.0 (OpusDB 0.1.0)'),
      status('server_encoding', 'UTF8'),
      status('client_encoding', 'UTF8'),
      status('DateStyle', 'ISO, MDY'),
      status('integer_datetimes', 'on'),
      status('standard_conforming_strings', 'on'),
      status('TimeZone', 'UTC'),
      status('application_name', params.application_name ?? ''),
      new Writer().int32(this.pid).int32(this.secret).message('K'),
      this.readyMessage(),
    );
  }

  private readyMessage(): Buffer {
    return new Writer().byte(this.session.inTransaction ? 'T'.charCodeAt(0) : 'I'.charCodeAt(0)).message('Z');
  }

  private errorMessage(e: { message: string; code: string; position?: number }, severity = 'ERROR'): Buffer {
    const w = new Writer();
    w.byte('S'.charCodeAt(0)).cstr(severity);
    w.byte('V'.charCodeAt(0)).cstr(severity);
    w.byte('C'.charCodeAt(0)).cstr(e.code);
    w.byte('M'.charCodeAt(0)).cstr(e.message);
    if (e.position !== undefined) w.byte('P'.charCodeAt(0)).cstr(String(e.position + 1));
    w.byte(0);
    return w.message('E');
  }

  private rowDescription(columns: { name: string; type: DataType }[]): Buffer {
    const w = new Writer().int16(columns.length);
    for (const c of columns) {
      w.cstr(c.name).int32(0).int16(0).int32(typeOid(c.type));
      w.int16(c.type === 'INTEGER' || c.type === 'REAL' ? 8 : c.type === 'BOOLEAN' ? 1 : -1);
      w.int32(-1).int16(0);
    }
    return w.message('T');
  }

  private dataRow(row: Value[], columns: { type: DataType }[]): Buffer {
    const w = new Writer().int16(row.length);
    for (let i = 0; i < row.length; i++) {
      const s = formatValue(row[i], columns[i]?.type ?? 'ANY');
      if (s === null) w.int32(-1);
      else {
        const b = Buffer.from(s, 'utf8');
        w.int32(b.length).raw(b);
      }
    }
    return w.message('D');
  }

  private resultMessages(r: QueryResult, withDescription: boolean, from = 0, max = Infinity): { msgs: Buffer[]; sent: number } {
    const msgs: Buffer[] = [];
    const returnsRows = r.columns.length > 0;
    if (withDescription && returnsRows) msgs.push(this.rowDescription(r.columns));
    const end = Math.min(r.rows.length, from + max);
    for (let i = from; i < end; i++) msgs.push(this.dataRow(r.rows[i], r.columns));
    return { msgs, sent: end };
  }

  private async handle(type: string, body: Buffer): Promise<void> {
    if (this.closed) return;
    const r = new Reader(body);
    if (this.skipUntilSync && type !== 'S' && type !== 'X') return;
    switch (type) {
      case 'Q':
        return this.simpleQuery(r.cstr());
      case 'X':
        this.socket.end();
        this.cleanup();
        return;
      case 'P':
        return this.guard(() => this.parseMessage(r));
      case 'B':
        return this.guard(() => this.bindMessage(r));
      case 'D':
        return this.guard(() => this.describeMessage(r));
      case 'E':
        return this.guard(() => this.executeMessage(r));
      case 'C': {
        const kind = String.fromCharCode(r.byte());
        const name = r.cstr();
        if (kind === 'S') this.prepared.delete(name);
        else this.portals.delete(name);
        this.send(new Writer().message('3'));
        return;
      }
      case 'S':
        this.skipUntilSync = false;
        this.send(this.readyMessage());
        return;
      case 'H':
        return;
      default:
        this.send(this.errorMessage({ message: `unsupported message type '${type}'`, code: '0A000' }));
    }
  }

  private async guard(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.send(this.errorMessage(errorPayload(e)));
      this.skipUntilSync = true;
    }
  }

  private async simpleQuery(sql: string): Promise<void> {
    if (!sql.trim().replace(/;/g, '').trim()) {
      this.send(new Writer().message('I'), this.readyMessage());
      return;
    }
    try {
      const stmts = parse(sql);
      for (const p of stmts) {
        const res = await runStatement(this.db, this.session, p, []);
        const { msgs } = this.resultMessages(res, true);
        msgs.push(new Writer().cstr(commandTag(res)).message('C'));
        this.send(...msgs);
      }
    } catch (e) {
      this.send(this.errorMessage(errorPayload(e)));
    }
    this.send(this.readyMessage());
  }

  private parseMessage(r: Reader): void {
    const name = r.cstr();
    const sql = r.cstr();
    const n = r.int16();
    const paramTypes: number[] = [];
    for (let i = 0; i < n; i++) paramTypes.push(r.int32());
    const stmts = parse(sql);
    if (stmts.length > 1) throw new OpusError(ErrorCode.syntax, 'cannot insert multiple commands into a prepared statement');
    this.prepared.set(name, { parsed: stmts[0] ?? null, paramTypes });
    this.send(new Writer().message('1'));
  }

  private bindMessage(r: Reader): void {
    const portal = r.cstr();
    const name = r.cstr();
    const stmt = this.prepared.get(name);
    if (!stmt) throw new OpusError(ErrorCode.invalidStatementName, `prepared statement "${name}" does not exist`);
    const nf = r.int16();
    const formats: number[] = [];
    for (let i = 0; i < nf; i++) formats.push(r.int16());
    const np = r.int16();
    const params: Value[] = [];
    for (let i = 0; i < np; i++) {
      const len = r.int32();
      const raw = len < 0 ? null : r.bytes(len);
      const format = nf === 0 ? 0 : nf === 1 ? formats[0] : formats[i];
      params.push(decodeParam(raw, format, stmt.paramTypes[i] ?? 0));
    }
    const nr = r.int16();
    for (let i = 0; i < nr; i++) if (r.int16() !== 0) throw new OpusError(ErrorCode.featureNotSupported, 'binary result format is not supported');
    this.portals.set(portal, { stmt, params, sent: 0 });
    this.send(new Writer().message('2'));
  }

  private columnsOf(stmt: Prepared): { name: string; type: DataType }[] {
    if (stmt.columns) return stmt.columns;
    const p = stmt.parsed;
    let cols: { name: string; type: DataType }[] = [];
    if (p) {
      const t = p.stmt.type;
      if (t === 'select' || t === 'insert' || t === 'update' || t === 'delete') cols = this.session.compile(p.stmt).columns;
      else if (t === 'explain') cols = [{ name: 'QUERY PLAN', type: 'TEXT' }];
    }
    stmt.columns = cols;
    return cols;
  }

  private describeMessage(r: Reader): void {
    const kind = String.fromCharCode(r.byte());
    const name = r.cstr();
    let stmt: Prepared | undefined;
    if (kind === 'S') {
      stmt = this.prepared.get(name);
      if (!stmt) throw new OpusError(ErrorCode.invalidStatementName, `prepared statement "${name}" does not exist`);
      const count = stmt.parsed?.paramCount ?? 0;
      const w = new Writer().int16(count);
      for (let i = 0; i < count; i++) w.int32(stmt.paramTypes[i] || OID.text);
      this.send(w.message('t'));
    } else {
      stmt = this.portals.get(name)?.stmt;
      if (!stmt) throw new OpusError(ErrorCode.invalidCursorName, `portal "${name}" does not exist`);
    }
    const cols = this.columnsOf(stmt);
    this.send(cols.length ? this.rowDescription(cols) : new Writer().message('n'));
  }

  private async executeMessage(r: Reader): Promise<void> {
    const name = r.cstr();
    const max = r.int32();
    const portal = this.portals.get(name);
    if (!portal) throw new OpusError(ErrorCode.invalidCursorName, `portal "${name}" does not exist`);
    if (!portal.stmt.parsed) {
      this.send(new Writer().message('I'));
      return;
    }
    if (!portal.result) {
      portal.result = await runStatement(this.db, this.session, portal.stmt.parsed, portal.params);
      portal.sent = 0;
    }
    const res = portal.result;
    const { msgs, sent } = this.resultMessages(res, false, portal.sent, max > 0 ? max : Infinity);
    portal.sent = sent;
    if (res.columns.length && sent < res.rows.length) msgs.push(new Writer().message('s'));
    else msgs.push(new Writer().cstr(commandTag(res)).message('C'));
    this.send(...msgs);
  }
}

/** Drops every open client connection (used by tests and on shutdown). */
export function closeAllPgConnections(): void {
  for (const c of connections.values()) c.destroy();
}

export interface PgOptions {
  db: Database;
  port: number;
  host?: string;
  log?: (msg: string) => void;
}

export function startPgServer(opts: PgOptions): Promise<Server> {
  const log = opts.log ?? (() => {});
  const server = createServer((socket) => new PgConnection(socket, opts.db, log));
  return new Promise((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve(server)));
}
