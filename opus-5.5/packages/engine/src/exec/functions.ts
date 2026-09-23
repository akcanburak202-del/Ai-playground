import type { DataType, Value } from '../types.ts';
import { compareValues, ErrorCode, formatReal, OpusError, valueToText } from '../types.ts';

// ------------------------------------------------------------------ conversions (SQLite semantics)

const NUMERIC_PREFIX = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;

/** Converts a value to a number the way SQLite does in a numeric context. */
export function toNumber(v: Value): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const m = NUMERIC_PREFIX.exec(v);
  return m ? Number(m[0]) : 0;
}

export function toInteger(v: Value): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  if (!Number.isFinite(n)) return n > 0 ? Number.MAX_SAFE_INTEGER : n < 0 ? Number.MIN_SAFE_INTEGER : 0;
  return Math.trunc(n);
}

/** SQL truthiness: NULL stays unknown, numbers are true when non-zero. */
export function toBool(v: Value): boolean | null {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const n = toNumber(v);
  return n !== 0;
}

export function toText(v: Value, type: DataType = 'ANY'): string | null {
  return valueToText(v, type);
}

export function castValue(v: Value, to: DataType, from: DataType = 'ANY'): Value {
  if (v === null) return null;
  switch (to) {
    case 'INTEGER':
      if (typeof v === 'string') {
        const m = /^\s*[+-]?\d+/.exec(v);
        if (!m) {
          const n = toNumber(v);
          return n === null ? null : Math.trunc(n);
        }
        return Number(m[0]);
      }
      return toInteger(v);
    case 'REAL':
      return toNumber(v);
    case 'TEXT':
      return valueToText(v, from);
    case 'BOOLEAN':
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === 't' || s === 'yes' || s === 'y' || s === 'on') return true;
        if (s === 'false' || s === 'f' || s === 'no' || s === 'n' || s === 'off') return false;
      }
      return toBool(v);
    default:
      return v;
  }
}

// ------------------------------------------------------------------ LIKE / GLOB

function asciiLower(s: string): string {
  let out = '';
  let changed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      if (!changed) {
        out = s.slice(0, i);
        changed = true;
      }
      out += String.fromCharCode(c + 32);
    } else if (changed) out += s[i];
  }
  return changed ? out : s;
}

function escapeRegex(ch: string): string {
  return ch.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

const likeCache = new Map<string, RegExp>();

/** LIKE: % and _ wildcards, ASCII case-insensitive (SQLite default). */
export function likeMatch(value: string, pattern: string, escape?: string): boolean {
  const cacheKey = (escape ?? '') + '\u0000' + pattern;
  let re = likeCache.get(cacheKey);
  if (!re) {
    let src = '^';
    const p = asciiLower(pattern);
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (escape !== undefined && ch === escape) {
        i++;
        if (i < p.length) src += escapeRegex(p[i]);
        continue;
      }
      if (ch === '%') src += '[\\s\\S]*';
      else if (ch === '_') src += '[\\s\\S]';
      else src += escapeRegex(ch);
    }
    re = new RegExp(src + '$', 'u');
    if (likeCache.size > 500) likeCache.clear();
    likeCache.set(cacheKey, re);
  }
  return re.test(asciiLower(value));
}

const globCache = new Map<string, RegExp>();

/** GLOB: * ? [...] wildcards, case sensitive. */
export function globMatch(value: string, pattern: string): boolean {
  let re = globCache.get(pattern);
  if (!re) {
    let src = '^';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*') src += '[\\s\\S]*';
      else if (ch === '?') src += '[\\s\\S]';
      else if (ch === '[') {
        const close = pattern.indexOf(']', i + 2);
        if (close < 0) {
          src += '\\[';
          continue;
        }
        let body = pattern.slice(i + 1, close);
        let neg = false;
        if (body.startsWith('^')) {
          neg = true;
          body = body.slice(1);
        }
        src += '[' + (neg ? '^' : '') + body.replace(/[\\\]]/g, '\\$&') + ']';
        i = close;
      } else src += escapeRegex(ch);
    }
    re = new RegExp(src + '$', 'u');
    if (globCache.size > 500) globCache.clear();
    globCache.set(pattern, re);
  }
  return re.test(value);
}

// ------------------------------------------------------------------ date / time

interface DateParts {
  ms: number; // milliseconds since unix epoch (UTC)
}

function parseTime(v: Value, now: () => number): DateParts | null {
  if (v === null) return null;
  if (typeof v === 'number') {
    // SQLite treats bare numbers as julian day numbers
    return { ms: (v - 2440587.5) * 86400000 };
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.toLowerCase() === 'now') return { ms: now() };
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '', tz] = m;
    let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, frac ? Math.round(Number(frac) * 1000) : 0);
    if (tz && tz !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      ms -= sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * 60000;
    }
    return { ms };
  }
  const t = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(s);
  if (t) return { ms: Date.UTC(2000, 0, 1, +t[1], +t[2], +(t[3] ?? 0), t[4] ? Math.round(Number(t[4]) * 1000) : 0) };
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return { ms: (Number(s) - 2440587.5) * 86400000 };
  return null;
}

function applyModifier(p: DateParts, mod: string): DateParts | null {
  const m = mod.trim().toLowerCase();
  const d = new Date(p.ms);
  const rel = /^([+-]?\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?$/.exec(m);
  if (rel) {
    const n = Number(rel[1]);
    switch (rel[2]) {
      case 'second':
        return { ms: p.ms + n * 1000 };
      case 'minute':
        return { ms: p.ms + n * 60000 };
      case 'hour':
        return { ms: p.ms + n * 3600000 };
      case 'day':
        return { ms: p.ms + n * 86400000 };
      case 'month':
        d.setUTCMonth(d.getUTCMonth() + Math.trunc(n));
        return { ms: d.getTime() };
      case 'year':
        d.setUTCFullYear(d.getUTCFullYear() + Math.trunc(n));
        return { ms: d.getTime() };
    }
  }
  if (m === 'start of day') return { ms: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) };
  if (m === 'start of month') return { ms: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
  if (m === 'start of year') return { ms: Date.UTC(d.getUTCFullYear(), 0, 1) };
  if (m === 'unixepoch') return p;
  if (m === 'utc' || m === 'localtime') return p;
  const wd = /^weekday\s+(\d)$/.exec(m);
  if (wd) {
    const target = Number(wd[1]);
    const cur = d.getUTCDay();
    return { ms: p.ms + ((target - cur + 7) % 7) * 86400000 };
  }
  return null;
}

function pad(n: number, w = 2): string {
  return String(Math.trunc(n)).padStart(w, '0');
}

function strftime(fmt: string, ms: number): string {
  const d = new Date(ms);
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== '%' || i + 1 >= fmt.length) {
      out += ch;
      continue;
    }
    const f = fmt[++i];
    switch (f) {
      case 'Y':
        out += pad(d.getUTCFullYear(), 4);
        break;
      case 'm':
        out += pad(d.getUTCMonth() + 1);
        break;
      case 'd':
        out += pad(d.getUTCDate());
        break;
      case 'H':
        out += pad(d.getUTCHours());
        break;
      case 'M':
        out += pad(d.getUTCMinutes());
        break;
      case 'S':
        out += pad(d.getUTCSeconds());
        break;
      case 'f':
        out += pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3);
        break;
      case 'j': {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        out += pad(Math.floor((ms - start) / 86400000) + 1, 3);
        break;
      }
      case 'w':
        out += String(d.getUTCDay());
        break;
      case 'u':
        out += String(d.getUTCDay() || 7);
        break;
      case 's':
        out += String(Math.floor(ms / 1000));
        break;
      case 'J':
        out += String(ms / 86400000 + 2440587.5);
        break;
      case 'W': {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        const yday = Math.floor((ms - start) / 86400000);
        const wday = (d.getUTCDay() + 6) % 7;
        out += pad(Math.floor((yday + 7 - wday) / 7));
        break;
      }
      case '%':
        out += '%';
        break;
      default:
        out += '%' + f;
    }
  }
  return out;
}

function timeFn(fmt: string | null, args: Value[], now: () => number): Value {
  let p = args.length === 0 ? { ms: now() } : parseTime(args[0], now);
  if (!p) return null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === null) return null;
    p = applyModifier(p, String(args[i]));
    if (!p) return null;
  }
  if (!Number.isFinite(p.ms)) return null;
  if (fmt === null) return p.ms / 86400000 + 2440587.5;
  return strftime(fmt, p.ms);
}

// ------------------------------------------------------------------ printf

function printf(fmt: string, args: Value[]): string {
  let ai = 0;
  return fmt.replace(/%([-+ 0#,]*)(\d+|\*)?(?:\.(\d+|\*))?([dioufeEgGxXsqcz%])/g, (_m, flags: string, width: string, prec: string, conv: string) => {
    if (conv === '%') return '%';
    if (width === '*') width = String(toInteger(args[ai++]) ?? 0);
    if (prec === '*') prec = String(toInteger(args[ai++]) ?? 0);
    const v = args[ai++] ?? null;
    let s: string;
    switch (conv) {
      case 'd':
      case 'i':
      case 'u': {
        const n = toInteger(v) ?? 0;
        s = String(n);
        if (flags.includes(',')) s = n.toLocaleString('en-US');
        if (flags.includes('+') && n >= 0) s = '+' + s;
        break;
      }
      case 'f':
      case 'F':
        s = (toNumber(v) ?? 0).toFixed(prec === undefined ? 6 : Number(prec));
        break;
      case 'e':
      case 'E':
        s = (toNumber(v) ?? 0).toExponential(prec === undefined ? 6 : Number(prec));
        if (conv === 'E') s = s.toUpperCase();
        break;
      case 'g':
      case 'G':
        s = String(Number((toNumber(v) ?? 0).toPrecision(prec === undefined ? 6 : Math.max(1, Number(prec)))));
        break;
      case 'x':
      case 'X':
        s = (toInteger(v) ?? 0).toString(16);
        if (conv === 'X') s = s.toUpperCase();
        break;
      case 'o':
        s = (toInteger(v) ?? 0).toString(8);
        break;
      case 'c':
        s = (toText(v) ?? '').slice(0, 1);
        break;
      case 'q':
        s = (toText(v) ?? '').replace(/'/g, "''");
        break;
      default:
        s = v === null ? '' : (toText(v) ?? '');
        if (prec !== undefined) s = s.slice(0, Number(prec));
    }
    if (width !== undefined) {
      const w = Number(width);
      if (flags.includes('-')) s = s.padEnd(w);
      else if (flags.includes('0') && /[dfeEgGxX]/.test(conv)) s = s.startsWith('-') ? '-' + s.slice(1).padStart(w - 1, '0') : s.padStart(w, '0');
      else s = s.padStart(w);
    }
    return s;
  });
}

// ------------------------------------------------------------------ scalar function registry

export interface ScalarFunction {
  min: number;
  max: number;
  type: (args: DataType[]) => DataType;
  /** Return NULL as soon as any argument is NULL (checked by the compiler). */
  strict: boolean;
  deterministic: boolean;
  fn: (args: Value[], types: DataType[], env: FunctionEnv) => Value;
}

export interface FunctionEnv {
  now: () => number;
  random: () => number;
}

const numType = (args: DataType[]): DataType => (args[0] === 'INTEGER' || args[0] === 'BOOLEAN' ? 'INTEGER' : args[0] === 'ANY' ? 'ANY' : 'REAL');
const t = (type: DataType) => () => type;
const firstNonNullType = (args: DataType[]): DataType => {
  let result: DataType = 'NULL';
  for (const a of args) {
    if (a === 'NULL') continue;
    if (result === 'NULL') result = a;
    else if (result !== a) {
      if ((result === 'INTEGER' && a === 'REAL') || (result === 'REAL' && a === 'INTEGER')) result = 'REAL';
      else return 'ANY';
    }
  }
  return result;
};

function chars(s: string): string[] {
  // fast path for BMP-only strings
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) return [...s];
  }
  return s.split('');
}

function charLength(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) return [...s].length;
  }
  return s.length;
}

function sqliteSubstr(s: string, start: number, len: number | undefined): string {
  const cs = chars(s);
  const n = cs.length;
  let p1 = start;
  let p2 = len === undefined ? n + 1 : len;
  let negP2 = false;
  if (p2 < 0) {
    p2 = -p2;
    negP2 = true;
  }
  if (p1 < 0) {
    p1 += n;
    if (p1 < 0) {
      p2 += p1;
      if (p2 < 0) p2 = 0;
      p1 = 0;
    }
  } else if (p1 > 0) p1--;
  else if (p2 > 0) p2--;
  if (negP2) {
    p1 -= p2;
    if (p1 < 0) {
      p2 += p1;
      p1 = 0;
    }
  }
  if (p1 + p2 > n) p2 = Math.max(0, n - p1);
  return cs.slice(p1, p1 + p2).join('');
}

function trimChars(s: string, set: string, left: boolean, right: boolean): string {
  const cs = new Set(chars(set));
  const arr = chars(s);
  let a = 0;
  let b = arr.length;
  if (left) while (a < b && cs.has(arr[a])) a++;
  if (right) while (b > a && cs.has(arr[b - 1])) b--;
  return arr.slice(a, b).join('');
}

function roundHalfAway(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  if (digits <= 0) return Math.sign(x) * Math.round(Math.abs(x));
  const s = Math.abs(x).toFixed(Math.min(digits, 100));
  // toFixed already rounds half away from zero on the decimal expansion
  return Math.sign(x) * Number(s);
}

const text = (v: Value, t: DataType) => toText(v, t) as string;

export const SCALAR_FUNCTIONS: Record<string, ScalarFunction> = {
  ABS: { min: 1, max: 1, type: numType, strict: true, deterministic: true, fn: ([v]) => Math.abs(toNumber(v)!) },
  LENGTH: {
    min: 1,
    max: 1,
    type: t('INTEGER'),
    strict: true,
    deterministic: true,
    fn: ([v], [ty]) => charLength(text(v, ty)),
  },
  CHAR_LENGTH: { min: 1, max: 1, type: t('INTEGER'), strict: true, deterministic: true, fn: ([v], [ty]) => charLength(text(v, ty)) },
  OCTET_LENGTH: { min: 1, max: 1, type: t('INTEGER'), strict: true, deterministic: true, fn: ([v], [ty]) => new TextEncoder().encode(text(v, ty)).length },
  LOWER: { min: 1, max: 1, type: t('TEXT'), strict: true, deterministic: true, fn: ([v], [ty]) => text(v, ty).toLowerCase() },
  UPPER: { min: 1, max: 1, type: t('TEXT'), strict: true, deterministic: true, fn: ([v], [ty]) => text(v, ty).toUpperCase() },
  SUBSTR: {
    min: 2,
    max: 3,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, a, b], [ty]) => sqliteSubstr(text(s, ty), toInteger(a)!, b === undefined ? undefined : toInteger(b)!),
  },
  TRIM: {
    min: 1,
    max: 2,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, c], [ty]) => trimChars(text(s, ty), c === undefined ? ' ' : String(c), true, true),
  },
  LTRIM: {
    min: 1,
    max: 2,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, c], [ty]) => trimChars(text(s, ty), c === undefined ? ' ' : String(c), true, false),
  },
  RTRIM: {
    min: 1,
    max: 2,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, c], [ty]) => trimChars(text(s, ty), c === undefined ? ' ' : String(c), false, true),
  },
  REPLACE: {
    min: 3,
    max: 3,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, a, b], [ts, ta, tb]) => {
      const from = text(a, ta);
      const str = text(s, ts);
      return from === '' ? str : str.split(from).join(text(b, tb));
    },
  },
  INSTR: {
    min: 2,
    max: 2,
    type: t('INTEGER'),
    strict: true,
    deterministic: true,
    fn: ([s, sub], [ts, tsub]) => {
      const hay = text(s, ts);
      const idx = hay.indexOf(text(sub, tsub));
      return idx < 0 ? 0 : charLength(hay.slice(0, idx)) + 1;
    },
  },
  COALESCE: {
    min: 1,
    max: 1000,
    type: firstNonNullType,
    strict: false,
    deterministic: true,
    fn: (args) => {
      for (const a of args) if (a !== null) return a;
      return null;
    },
  },
  IFNULL: { min: 2, max: 2, type: firstNonNullType, strict: false, deterministic: true, fn: ([a, b]) => (a === null ? b : a) },
  NULLIF: {
    min: 2,
    max: 2,
    type: (a) => a[0],
    strict: false,
    deterministic: true,
    fn: ([a, b]) => (a !== null && b !== null && compareValues(a, b) === 0 ? null : a),
  },
  IIF: {
    min: 3,
    max: 3,
    type: (a) => firstNonNullType([a[1], a[2]]),
    strict: false,
    deterministic: true,
    fn: ([c, a, b]) => (toBool(c) === true ? a : b),
  },
  ROUND: {
    min: 1,
    max: 2,
    type: t('REAL'),
    strict: true,
    deterministic: true,
    fn: ([x, d]) => roundHalfAway(toNumber(x)!, d === undefined ? 0 : toInteger(d)!),
  },
  TYPEOF: {
    min: 1,
    max: 1,
    type: t('TEXT'),
    strict: false,
    deterministic: true,
    fn: ([v], [ty]) => {
      if (v === null) return 'null';
      if (typeof v === 'string') return 'text';
      if (typeof v === 'boolean') return 'integer';
      if (ty === 'REAL') return 'real';
      if (ty === 'INTEGER') return 'integer';
      return Number.isInteger(v) ? 'integer' : 'real';
    },
  },
  RANDOM: {
    min: 0,
    max: 0,
    type: t('INTEGER'),
    strict: false,
    deterministic: false,
    fn: (_a, _t, env) => Math.floor((env.random() - 0.5) * 2 * Number.MAX_SAFE_INTEGER),
  },
  MIN: {
    min: 2,
    max: 1000,
    type: firstNonNullType,
    strict: true,
    deterministic: true,
    fn: (args) => args.reduce((a, b) => (compareValues(b, a) < 0 ? b : a)),
  },
  MAX: {
    min: 2,
    max: 1000,
    type: firstNonNullType,
    strict: true,
    deterministic: true,
    fn: (args) => args.reduce((a, b) => (compareValues(b, a) > 0 ? b : a)),
  },
  GREATEST: {
    min: 1,
    max: 1000,
    type: firstNonNullType,
    strict: false,
    deterministic: true,
    fn: (args) => args.filter((a) => a !== null).reduce<Value>((a, b) => (a === null || compareValues(b, a) > 0 ? b : a), null),
  },
  LEAST: {
    min: 1,
    max: 1000,
    type: firstNonNullType,
    strict: false,
    deterministic: true,
    fn: (args) => args.filter((a) => a !== null).reduce<Value>((a, b) => (a === null || compareValues(b, a) < 0 ? b : a), null),
  },
  CHAR: {
    min: 0,
    max: 1000,
    type: t('TEXT'),
    strict: false,
    deterministic: true,
    fn: (args) => String.fromCodePoint(...args.filter((a) => a !== null).map((a) => toInteger(a)!)),
  },
  UNICODE: { min: 1, max: 1, type: t('INTEGER'), strict: true, deterministic: true, fn: ([s], [ty]) => text(s, ty).codePointAt(0) ?? null },
  HEX: {
    min: 1,
    max: 1,
    type: t('TEXT'),
    strict: false,
    deterministic: true,
    fn: ([v], [ty]) =>
      v === null
        ? ''
        : Array.from(new TextEncoder().encode(text(v, ty)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase(),
  },
  SQRT: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => (toNumber(x)! < 0 ? null : Math.sqrt(toNumber(x)!)) },
  POWER: { min: 2, max: 2, type: t('REAL'), strict: true, deterministic: true, fn: ([a, b]) => Math.pow(toNumber(a)!, toNumber(b)!) },
  POW: { min: 2, max: 2, type: t('REAL'), strict: true, deterministic: true, fn: ([a, b]) => Math.pow(toNumber(a)!, toNumber(b)!) },
  EXP: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => Math.exp(toNumber(x)!) },
  LN: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => (toNumber(x)! <= 0 ? null : Math.log(toNumber(x)!)) },
  LOG: {
    min: 1,
    max: 2,
    type: t('REAL'),
    strict: true,
    deterministic: true,
    fn: (args) => {
      if (args.length === 1) return toNumber(args[0])! <= 0 ? null : Math.log10(toNumber(args[0])!);
      const b = toNumber(args[0])!;
      const x = toNumber(args[1])!;
      return b <= 0 || x <= 0 || b === 1 ? null : Math.log(x) / Math.log(b);
    },
  },
  LOG10: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => (toNumber(x)! <= 0 ? null : Math.log10(toNumber(x)!)) },
  LOG2: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => (toNumber(x)! <= 0 ? null : Math.log2(toNumber(x)!)) },
  FLOOR: { min: 1, max: 1, type: numType, strict: true, deterministic: true, fn: ([x]) => Math.floor(toNumber(x)!) },
  CEIL: { min: 1, max: 1, type: numType, strict: true, deterministic: true, fn: ([x]) => Math.ceil(toNumber(x)!) },
  CEILING: { min: 1, max: 1, type: numType, strict: true, deterministic: true, fn: ([x]) => Math.ceil(toNumber(x)!) },
  TRUNC: { min: 1, max: 1, type: numType, strict: true, deterministic: true, fn: ([x]) => Math.trunc(toNumber(x)!) },
  SIGN: { min: 1, max: 1, type: t('INTEGER'), strict: true, deterministic: true, fn: ([x]) => Math.sign(toNumber(x)!) },
  MOD: {
    min: 2,
    max: 2,
    type: (a) => (a[0] === 'INTEGER' && a[1] === 'INTEGER' ? 'INTEGER' : 'REAL'),
    strict: true,
    deterministic: true,
    fn: ([a, b]) => (toNumber(b) === 0 ? null : toNumber(a)! % toNumber(b)!),
  },
  PI: { min: 0, max: 0, type: t('REAL'), strict: false, deterministic: true, fn: () => Math.PI },
  SIN: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => Math.sin(toNumber(x)!) },
  COS: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => Math.cos(toNumber(x)!) },
  TAN: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => Math.tan(toNumber(x)!) },
  ATAN: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => Math.atan(toNumber(x)!) },
  ATAN2: { min: 2, max: 2, type: t('REAL'), strict: true, deterministic: true, fn: ([y, x]) => Math.atan2(toNumber(y)!, toNumber(x)!) },
  DEGREES: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => (toNumber(x)! * 180) / Math.PI },
  RADIANS: { min: 1, max: 1, type: t('REAL'), strict: true, deterministic: true, fn: ([x]) => (toNumber(x)! * Math.PI) / 180 },
  CONCAT: {
    min: 1,
    max: 1000,
    type: t('TEXT'),
    strict: false,
    deterministic: true,
    fn: (args, types) => args.map((a, i) => (a === null ? '' : text(a, types[i]))).join(''),
  },
  CONCAT_WS: {
    min: 2,
    max: 1000,
    type: t('TEXT'),
    strict: false,
    deterministic: true,
    fn: ([sep, ...rest], [tsep, ...types]) =>
      sep === null
        ? null
        : rest
            .map((a, i) => (a === null ? null : text(a, types[i])))
            .filter((a) => a !== null)
            .join(text(sep, tsep)),
  },
  LPAD: {
    min: 2,
    max: 3,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, n, f], [ty]) => {
      const str = text(s, ty);
      const len = toInteger(n)!;
      if (len <= charLength(str)) return chars(str).slice(0, Math.max(0, len)).join('');
      return str.padStart(len, f === undefined ? ' ' : String(f));
    },
  },
  RPAD: {
    min: 2,
    max: 3,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, n, f], [ty]) => {
      const str = text(s, ty);
      const len = toInteger(n)!;
      if (len <= charLength(str)) return chars(str).slice(0, Math.max(0, len)).join('');
      return str.padEnd(len, f === undefined ? ' ' : String(f));
    },
  },
  LEFT: {
    min: 2,
    max: 2,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, n], [ty]) => {
      const cs = chars(text(s, ty));
      const k = toInteger(n)!;
      return (k >= 0 ? cs.slice(0, k) : cs.slice(0, Math.max(0, cs.length + k))).join('');
    },
  },
  RIGHT: {
    min: 2,
    max: 2,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, n], [ty]) => {
      const cs = chars(text(s, ty));
      const k = toInteger(n)!;
      return (k >= 0 ? cs.slice(Math.max(0, cs.length - k)) : cs.slice(Math.min(cs.length, -k))).join('');
    },
  },
  REVERSE: { min: 1, max: 1, type: t('TEXT'), strict: true, deterministic: true, fn: ([s], [ty]) => chars(text(s, ty)).reverse().join('') },
  REPEAT: {
    min: 2,
    max: 2,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, n], [ty]) => {
      const k = toInteger(n)!;
      if (k * text(s, ty).length > 10_000_000) throw new OpusError(ErrorCode.numericOutOfRange, 'string or blob too big');
      return text(s, ty).repeat(Math.max(0, k));
    },
  },
  SPLIT_PART: {
    min: 3,
    max: 3,
    type: t('TEXT'),
    strict: true,
    deterministic: true,
    fn: ([s, d, n], [ts, td]) => {
      const parts = text(s, ts).split(text(d, td));
      const k = toInteger(n)!;
      const i = k > 0 ? k - 1 : parts.length + k;
      return parts[i] ?? '';
    },
  },
  STARTS_WITH: {
    min: 2,
    max: 2,
    type: t('BOOLEAN'),
    strict: true,
    deterministic: true,
    fn: ([s, p], [ts, tp]) => text(s, ts).startsWith(text(p, tp)),
  },
  PRINTF: { min: 1, max: 1000, type: t('TEXT'), strict: false, deterministic: true, fn: ([f, ...rest]) => (f === null ? null : printf(String(f), rest)) },
  FORMAT: { min: 1, max: 1000, type: t('TEXT'), strict: false, deterministic: true, fn: ([f, ...rest]) => (f === null ? null : printf(String(f), rest)) },
  QUOTE: {
    min: 1,
    max: 1,
    type: t('TEXT'),
    strict: false,
    deterministic: true,
    fn: ([v], [ty]) => (v === null ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : text(v, ty)),
  },
  DATE: { min: 0, max: 100, type: t('TEXT'), strict: false, deterministic: false, fn: (args, _t, env) => timeFn('%Y-%m-%d', args, env.now) },
  TIME: { min: 0, max: 100, type: t('TEXT'), strict: false, deterministic: false, fn: (args, _t, env) => timeFn('%H:%M:%S', args, env.now) },
  DATETIME: { min: 0, max: 100, type: t('TEXT'), strict: false, deterministic: false, fn: (args, _t, env) => timeFn('%Y-%m-%d %H:%M:%S', args, env.now) },
  JULIANDAY: { min: 0, max: 100, type: t('REAL'), strict: false, deterministic: false, fn: (args, _t, env) => timeFn(null, args, env.now) },
  UNIXEPOCH: {
    min: 0,
    max: 100,
    type: t('INTEGER'),
    strict: false,
    deterministic: false,
    fn: (args, _t, env) => {
      const r = timeFn('%s', args, env.now);
      return r === null ? null : Number(r);
    },
  },
  STRFTIME: {
    min: 1,
    max: 100,
    type: t('TEXT'),
    strict: false,
    deterministic: false,
    fn: ([f, ...rest], _t, env) => (f === null ? null : timeFn(String(f), rest.length ? rest : ['now'], env.now)),
  },
  CURRENT_TIMESTAMP: { min: 0, max: 0, type: t('TEXT'), strict: false, deterministic: false, fn: (_a, _t, env) => strftime('%Y-%m-%d %H:%M:%S', env.now()) },
  CURRENT_DATE: { min: 0, max: 0, type: t('TEXT'), strict: false, deterministic: false, fn: (_a, _t, env) => strftime('%Y-%m-%d', env.now()) },
  CURRENT_TIME: { min: 0, max: 0, type: t('TEXT'), strict: false, deterministic: false, fn: (_a, _t, env) => strftime('%H:%M:%S', env.now()) },
  NOW: { min: 0, max: 0, type: t('TEXT'), strict: false, deterministic: false, fn: (_a, _t, env) => strftime('%Y-%m-%d %H:%M:%S', env.now()) },
};
SCALAR_FUNCTIONS.SUBSTRING = SCALAR_FUNCTIONS.SUBSTR;
SCALAR_FUNCTIONS.STRPOS = SCALAR_FUNCTIONS.INSTR;
SCALAR_FUNCTIONS.CHARACTER_LENGTH = SCALAR_FUNCTIONS.CHAR_LENGTH;

// ------------------------------------------------------------------ aggregates

export interface AggState {
  step(args: Value[]): void;
  /** Removes a previously added row (enables O(1) sliding windows). */
  unstep?(args: Value[]): void;
  final(): Value;
}

export interface AggregateFunction {
  min: number;
  max: number;
  type: (args: DataType[]) => DataType;
  create: (argTypes: DataType[]) => AggState;
}

/** Kahan-Babuska-Neumaier compensated summation (what SQLite uses for sum/avg). */
class KbnSum {
  sum = 0;
  comp = 0;
  add(x: number): void {
    const t = this.sum + x;
    if (Math.abs(this.sum) >= Math.abs(x)) this.comp += this.sum - t + x;
    else this.comp += x - t + this.sum;
    this.sum = t;
  }
  value(): number {
    return this.sum + this.comp;
  }
}

function sumState(integer: boolean, total: boolean): AggState {
  let count = 0;
  let isum = 0;
  let k = new KbnSum();
  let allInt = integer;
  return {
    step([v]) {
      if (v === null) return;
      const n = toNumber(v)!;
      count++;
      if (allInt && Number.isInteger(n)) isum += n;
      else {
        if (allInt) {
          allInt = false;
          k = new KbnSum();
          k.add(isum);
        }
        k.add(n);
      }
    },
    unstep([v]) {
      if (v === null) return;
      const n = toNumber(v)!;
      count--;
      if (allInt) isum -= n;
      else k.add(-n);
    },
    final() {
      if (count === 0) return total ? 0 : null;
      return allInt ? isum : k.value();
    },
  };
}

function statsState(kind: 'var_samp' | 'var_pop' | 'stddev_samp' | 'stddev_pop'): AggState {
  // Welford's online algorithm
  let n = 0;
  let mean = 0;
  let m2 = 0;
  return {
    step([v]) {
      if (v === null) return;
      const x = toNumber(v)!;
      n++;
      const d = x - mean;
      mean += d / n;
      m2 += d * (x - mean);
    },
    final() {
      const denom = kind.endsWith('samp') ? n - 1 : n;
      if (denom <= 0) return null;
      const variance = m2 / denom;
      return kind.startsWith('stddev') ? Math.sqrt(variance) : variance;
    },
  };
}

export const AGGREGATE_FUNCTIONS: Record<string, AggregateFunction> = {
  COUNT: {
    min: 0,
    max: 1,
    type: () => 'INTEGER',
    create: () => {
      let n = 0;
      return {
        step(args) {
          if (args.length === 0 || args[0] !== null) n++;
        },
        unstep(args) {
          if (args.length === 0 || args[0] !== null) n--;
        },
        final: () => n,
      };
    },
  },
  SUM: {
    min: 1,
    max: 1,
    type: (a) => (a[0] === 'INTEGER' || a[0] === 'BOOLEAN' ? 'INTEGER' : a[0] === 'ANY' ? 'ANY' : 'REAL'),
    create: (types) => sumState(types[0] !== 'REAL', false),
  },
  TOTAL: { min: 1, max: 1, type: () => 'REAL', create: () => sumState(false, true) },
  AVG: {
    min: 1,
    max: 1,
    type: () => 'REAL',
    create: () => {
      const s = new KbnSum();
      let n = 0;
      return {
        step([v]) {
          if (v === null) return;
          s.add(toNumber(v)!);
          n++;
        },
        unstep([v]) {
          if (v === null) return;
          s.add(-toNumber(v)!);
          n--;
        },
        final: () => (n === 0 ? null : s.value() / n),
      };
    },
  },
  MIN: {
    min: 1,
    max: 1,
    type: (a) => a[0],
    create: () => {
      let best: Value = null;
      return {
        step([v]) {
          if (v !== null && (best === null || compareValues(v, best) < 0)) best = v;
        },
        final: () => best,
      };
    },
  },
  MAX: {
    min: 1,
    max: 1,
    type: (a) => a[0],
    create: () => {
      let best: Value = null;
      return {
        step([v]) {
          if (v !== null && (best === null || compareValues(v, best) > 0)) best = v;
        },
        final: () => best,
      };
    },
  },
  GROUP_CONCAT: {
    min: 1,
    max: 2,
    type: () => 'TEXT',
    create: (types) => {
      const parts: string[] = [];
      let seps: string[] = [];
      return {
        step([v, sep]) {
          if (v === null) return;
          if (parts.length) seps.push(sep === undefined ? ',' : sep === null ? '' : String(sep));
          parts.push(text(v, types[0]));
        },
        final() {
          if (!parts.length) return null;
          let s = parts[0];
          for (let i = 1; i < parts.length; i++) s += seps[i - 1] + parts[i];
          seps = seps.slice();
          return s;
        },
      };
    },
  },
  BOOL_AND: {
    min: 1,
    max: 1,
    type: () => 'BOOLEAN',
    create: () => {
      let r: boolean | null = null;
      return {
        step([v]) {
          const b = toBool(v);
          if (b !== null) r = r === null ? b : r && b;
        },
        final: () => r,
      };
    },
  },
  BOOL_OR: {
    min: 1,
    max: 1,
    type: () => 'BOOLEAN',
    create: () => {
      let r: boolean | null = null;
      return {
        step([v]) {
          const b = toBool(v);
          if (b !== null) r = r === null ? b : r || b;
        },
        final: () => r,
      };
    },
  },
  VAR_SAMP: { min: 1, max: 1, type: () => 'REAL', create: () => statsState('var_samp') },
  VAR_POP: { min: 1, max: 1, type: () => 'REAL', create: () => statsState('var_pop') },
  STDDEV_SAMP: { min: 1, max: 1, type: () => 'REAL', create: () => statsState('stddev_samp') },
  STDDEV_POP: { min: 1, max: 1, type: () => 'REAL', create: () => statsState('stddev_pop') },
  MEDIAN: {
    min: 1,
    max: 1,
    type: () => 'REAL',
    create: () => {
      const xs: number[] = [];
      return {
        step([v]) {
          if (v !== null) xs.push(toNumber(v)!);
        },
        final() {
          if (!xs.length) return null;
          xs.sort((a, b) => a - b);
          const m = xs.length >> 1;
          return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
        },
      };
    },
  },
};
AGGREGATE_FUNCTIONS.STRING_AGG = { ...AGGREGATE_FUNCTIONS.GROUP_CONCAT, min: 2, max: 2 };
AGGREGATE_FUNCTIONS.EVERY = AGGREGATE_FUNCTIONS.BOOL_AND;
AGGREGATE_FUNCTIONS.VARIANCE = AGGREGATE_FUNCTIONS.VAR_SAMP;
AGGREGATE_FUNCTIONS.STDDEV = AGGREGATE_FUNCTIONS.STDDEV_SAMP;

export const WINDOW_FUNCTIONS = new Set([
  'ROW_NUMBER',
  'RANK',
  'DENSE_RANK',
  'PERCENT_RANK',
  'CUME_DIST',
  'NTILE',
  'LAG',
  'LEAD',
  'FIRST_VALUE',
  'LAST_VALUE',
  'NTH_VALUE',
]);

export function isAggregateName(name: string, argCount: number): boolean {
  if (!(name in AGGREGATE_FUNCTIONS)) return false;
  if ((name === 'MIN' || name === 'MAX') && argCount !== 1) return false;
  return true;
}

export { formatReal };
