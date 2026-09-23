/**
 * Core value model shared by every layer of the engine.
 *
 * OpusDB is statically typed at plan time (like PostgreSQL) but follows
 * SQLite's runtime semantics where they differ from the standard (NULL sorts
 * first, integer division truncates, division by zero yields NULL, LIKE is
 * ASCII case-insensitive). This keeps results comparable against SQLite in
 * the differential fuzzer while still giving precise type errors up front.
 */

export type Value = null | number | string | boolean;
export type Row = Value[];

export type DataType = 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN' | 'NULL' | 'ANY';

/** SQLSTATE-style error codes, reused verbatim by the PostgreSQL wire protocol. */
export const ErrorCode = {
  syntax: '42601',
  undefinedTable: '42P01',
  undefinedColumn: '42703',
  undefinedFunction: '42883',
  ambiguousColumn: '42702',
  duplicateTable: '42P07',
  duplicateObject: '42710',
  duplicateColumn: '42701',
  datatypeMismatch: '42804',
  groupingError: '42803',
  invalidParameter: '22023',
  numericOutOfRange: '22003',
  invalidText: '22P02',
  notNullViolation: '23502',
  uniqueViolation: '23505',
  checkViolation: '23514',
  cardinalityViolation: '21000',
  activeTransaction: '25001',
  noActiveTransaction: '25P01',
  lockNotAvailable: '55P03',
  featureNotSupported: '0A000',
  ioError: '58030',
  corrupt: 'XX001',
  internal: 'XX000',
} as const;
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class OpusError extends Error {
  readonly code: ErrorCodeValue;
  /** Character offset into the SQL text the error refers to, when known. */
  position: number | undefined;
  constructor(code: ErrorCodeValue, message: string, position?: number) {
    super(message);
    this.name = 'OpusError';
    this.code = code;
    this.position = position;
  }
}

export function isNumericType(t: DataType): boolean {
  return t === 'INTEGER' || t === 'REAL' || t === 'BOOLEAN';
}

/** Maps an arbitrary declared column type to one of OpusDB's storage types. */
export function normalizeTypeName(name: string, position?: number): DataType {
  const n = name.toUpperCase();
  if (n.includes('INT')) return 'INTEGER';
  if (n.includes('BOOL')) return 'BOOLEAN';
  if (n.includes('CHAR') || n.includes('CLOB') || n.includes('TEXT') || n === 'STRING' || n === 'UUID' || n === 'JSON') return 'TEXT';
  if (n.includes('REAL') || n.includes('FLOA') || n.includes('DOUB') || n === 'NUMERIC' || n.startsWith('DECIMAL')) return 'REAL';
  if (n.includes('DATE') || n.includes('TIME')) return 'TEXT';
  throw new OpusError(ErrorCode.datatypeMismatch, `unknown data type "${name}"`, position);
}

/** Type tag used when ordering values of different kinds (SQLite order: NULL < numbers < text). */
function typeRank(v: Value): number {
  if (v === null) return 0;
  if (typeof v === 'string') return 2;
  return 1;
}

/**
 * Total order over values. NULL is the smallest value, booleans compare as
 * 0/1 alongside numbers, and text compares by UTF-16 code unit.
 */
export function compareValues(a: Value, b: Value): number {
  if (a === b) return 0;
  const ta = typeof a;
  const tb = typeof b;
  if (ta === 'number' && tb === 'number') return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ta === 'string' && tb === 'string') return (a as string) < (b as string) ? -1 : 1;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  const na = typeof a === 'boolean' ? (a ? 1 : 0) : (a as number);
  const nb = typeof b === 'boolean' ? (b ? 1 : 0) : (b as number);
  return na < nb ? -1 : na > nb ? 1 : 0;
}

export function compareTuples(a: readonly Value[], b: readonly Value[], desc?: readonly boolean[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareValues(a[i], b[i]);
    if (c !== 0) return desc && desc[i] ? -c : c;
  }
  return a.length - b.length;
}

/** Normalises a value into something usable as a Map/Set key with SQL equality semantics. */
export function hashKey(v: Value): number | string | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function tupleKey(values: readonly Value[]): string {
  let s = '';
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) s += '\u0000N';
    else if (typeof v === 'string') s += '\u0000S' + v;
    else if (typeof v === 'boolean') s += '\u0000#' + (v ? 1 : 0);
    else s += '\u0000#' + v;
  }
  return s;
}

/** Formats a REAL the way SQLite does (printf "%!.15g": 15 significant digits, always a decimal point). */
export function formatReal(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? 'Inf' : n < 0 ? '-Inf' : 'NaN';
  if (n === 0) return '0.0';
  const exp = Number(n.toExponential(14).split('e')[1]);
  if (exp < -4 || exp >= 15) {
    const [m, e] = n.toExponential(14).split('e');
    let mant = m.replace(/0+$/, '');
    if (mant.endsWith('.')) mant += '0';
    const sign = e[0] === '-' ? '-' : '+';
    const digits = e.replace(/^[+-]/, '').padStart(2, '0');
    return `${mant}e${sign}${digits}`;
  }
  let s = n.toFixed(Math.max(0, 14 - exp));
  if (s.includes('.')) s = s.replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  if (!s.includes('.')) s += '.0';
  return s;
}

export function valueToText(v: Value, type: DataType = 'ANY'): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (type === 'REAL') return formatReal(v);
  if (Number.isInteger(v)) return String(v);
  return formatReal(v);
}

export function describeValue(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

export function typeOfValue(v: Value): DataType {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return 'TEXT';
  if (typeof v === 'boolean') return 'BOOLEAN';
  return Number.isInteger(v) ? 'INTEGER' : 'REAL';
}
