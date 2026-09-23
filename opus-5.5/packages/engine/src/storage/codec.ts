import type { Value } from '../types.ts';

/**
 * Binary record format used for table rows and index keys:
 *
 *   record := varint(count) value*
 *   value  := 0x00                      NULL
 *           | 0x01 | 0x02               FALSE | TRUE
 *           | 0x03 i8 | 0x04 i16 | 0x05 i32
 *           | 0x06 f64                  any other number
 *           | 0x07 varint(len) utf8     TEXT
 *
 * Integers are stored in the smallest width that fits, so small keys stay
 * small and pages hold more entries.
 */

const TAG_NULL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_I8 = 3;
const TAG_I16 = 4;
const TAG_I32 = 5;
const TAG_F64 = 6;
const TAG_TEXT = 7;

const textDecoder = new TextDecoder();

export function varintSize(n: number): number {
  if (n < 0x80) return 1;
  if (n < 0x4000) return 2;
  if (n < 0x200000) return 3;
  if (n < 0x10000000) return 4;
  return 5;
}

export function utf8Length(s: string): number {
  let len = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) len += 1;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        len += 2; // 4 bytes for 2 code units
        i++;
      } else len += 2;
    } else len += 2;
  }
  return len;
}

function numberTagSize(v: number): number {
  if (Number.isInteger(v) && !Object.is(v, -0)) {
    if (v >= -128 && v <= 127) return 2;
    if (v >= -32768 && v <= 32767) return 3;
    if (v >= -2147483648 && v <= 2147483647) return 5;
  }
  return 9;
}

export function valueSize(v: Value): number {
  if (v === null || typeof v === 'boolean') return 1;
  if (typeof v === 'number') return numberTagSize(v);
  const n = utf8Length(v);
  return 1 + varintSize(n) + n;
}

export function recordSize(values: readonly Value[]): number {
  let size = varintSize(values.length);
  for (let i = 0; i < values.length; i++) size += valueSize(values[i]);
  return size;
}

export class ByteWriter {
  buf: Uint8Array;
  view: DataView;
  pos = 0;
  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }
  u8(v: number): void {
    this.buf[this.pos++] = v;
  }
  u16(v: number): void {
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }
  f64(v: number): void {
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  varint(n: number): void {
    while (n >= 0x80) {
      this.buf[this.pos++] = (n & 0x7f) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.pos++] = n;
  }
  bytes(b: Uint8Array): void {
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  text(s: string, byteLen: number): void {
    const buf = this.buf;
    let p = this.pos;
    if (byteLen === s.length) {
      for (let i = 0; i < s.length; i++) buf[p++] = s.charCodeAt(i);
    } else {
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) buf[p++] = c;
        else if (c < 0x800) {
          buf[p++] = 0xc0 | (c >> 6);
          buf[p++] = 0x80 | (c & 63);
        } else {
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
              c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
              i++;
              buf[p++] = 0xf0 | (c >> 18);
              buf[p++] = 0x80 | ((c >> 12) & 63);
              buf[p++] = 0x80 | ((c >> 6) & 63);
              buf[p++] = 0x80 | (c & 63);
              continue;
            }
          }
          buf[p++] = 0xe0 | (c >> 12);
          buf[p++] = 0x80 | ((c >> 6) & 63);
          buf[p++] = 0x80 | (c & 63);
        }
      }
    }
    this.pos = p;
  }
  value(v: Value): void {
    if (v === null) this.u8(TAG_NULL);
    else if (v === false) this.u8(TAG_FALSE);
    else if (v === true) this.u8(TAG_TRUE);
    else if (typeof v === 'number') {
      const size = numberTagSize(v);
      if (size === 2) {
        this.u8(TAG_I8);
        this.view.setInt8(this.pos++, v);
      } else if (size === 3) {
        this.u8(TAG_I16);
        this.view.setInt16(this.pos, v, true);
        this.pos += 2;
      } else if (size === 5) {
        this.u8(TAG_I32);
        this.view.setInt32(this.pos, v, true);
        this.pos += 4;
      } else {
        this.u8(TAG_F64);
        this.f64(v);
      }
    } else {
      const n = utf8Length(v);
      this.u8(TAG_TEXT);
      this.varint(n);
      this.text(v, n);
    }
  }
  record(values: readonly Value[]): void {
    this.varint(values.length);
    for (let i = 0; i < values.length; i++) this.value(values[i]);
  }
}

export class ByteReader {
  buf: Uint8Array;
  view: DataView;
  pos: number;
  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }
  u8(): number {
    return this.buf[this.pos++];
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  }
  bytes(n: number): Uint8Array {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  text(n: number): string {
    const buf = this.buf;
    const start = this.pos;
    const end = start + n;
    this.pos = end;
    if (n > 48) return textDecoder.decode(buf.subarray(start, end));
    let s = '';
    for (let i = start; i < end; i++) {
      const c = buf[i];
      if (c < 0x80) s += String.fromCharCode(c);
      else return textDecoder.decode(buf.subarray(start, end));
    }
    return s;
  }
  value(): Value {
    const tag = this.buf[this.pos++];
    switch (tag) {
      case TAG_NULL:
        return null;
      case TAG_FALSE:
        return false;
      case TAG_TRUE:
        return true;
      case TAG_I8:
        return this.view.getInt8(this.pos++);
      case TAG_I16: {
        const v = this.view.getInt16(this.pos, true);
        this.pos += 2;
        return v;
      }
      case TAG_I32: {
        const v = this.view.getInt32(this.pos, true);
        this.pos += 4;
        return v;
      }
      case TAG_F64:
        return this.f64();
      case TAG_TEXT:
        return this.text(this.varint());
      default:
        throw new Error(`corrupt record: unknown value tag ${tag} at ${this.pos - 1}`);
    }
  }
  record(): Value[] {
    const n = this.varint();
    const out = new Array<Value>(n);
    for (let i = 0; i < n; i++) out[i] = this.value();
    return out;
  }
}

export function encodeRecord(values: readonly Value[]): Uint8Array {
  const buf = new Uint8Array(recordSize(values));
  new ByteWriter(buf).record(values);
  return buf;
}

export function decodeRecord(buf: Uint8Array): Value[] {
  return new ByteReader(buf).record();
}
