import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A small, dependency-free server-side WebSocket (RFC 6455) implementation:
 * opening handshake, frame parsing with masking and fragmentation, ping/pong,
 * and the closing handshake. Only text messages are delivered to users.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WebSocketEvents {
  message: [text: string];
  close: [code: number, reason: string];
  error: [err: Error];
}

export class WebSocketConnection extends EventEmitter<WebSocketEvents> {
  private readonly socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOp = 0;
  private closed = false;
  private closeSent = false;

  constructor(socket: Duplex, head: Buffer) {
    super();
    this.socket = socket;
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.finish(1006, 'connection lost'));
    socket.on('error', (e) => this.emit('error', e));
    if (head.length) this.onData(head);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(text: string): void {
    if (this.closed || this.closeSent) return;
    this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.closeSent || this.closed) return;
    const r = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.writeFrame(OP_CLOSE, payload);
    this.closeSent = true;
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode; server frames are never masked
    this.socket.write(Buffer.concat([header, payload]));
  }

  private protocolError(reason: string): void {
    this.close(1002, reason);
    this.finish(1002, reason);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      if (b[0] & 0x70) return this.protocolError('reserved bits set');
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.protocolError('frame too large');
        len = Number(big);
        off = 10;
      }
      if (!masked) return this.protocolError('client frames must be masked');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(off + 4 + len);
      this.handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_PING:
        this.writeFrame(OP_PONG, payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent) this.close(code === 1005 ? 1000 : code);
        this.socket.end();
        this.finish(code, reason);
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragments.length) return this.protocolError('new message inside a fragmented message');
        if (fin) {
          if (opcode === OP_TEXT) this.emit('message', payload.toString('utf8'));
          return;
        }
        this.fragmentOp = opcode;
        this.fragments = [payload];
        return;
      case OP_CONT: {
        if (!this.fragments.length) return this.protocolError('unexpected continuation frame');
        this.fragments.push(payload);
        const total = this.fragments.reduce((s, f) => s + f.length, 0);
        if (total > MAX_MESSAGE) return this.protocolError('message too large');
        if (fin) {
          const msg = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.fragmentOp === OP_TEXT) this.emit('message', msg.toString('utf8'));
        }
        return;
      }
      default:
        this.protocolError(`unknown opcode ${opcode}`);
    }
  }
}

/** Completes the opening handshake for an HTTP upgrade request. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | null {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WebSocketConnection(socket, head);
}
