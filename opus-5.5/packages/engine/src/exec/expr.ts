import type { DataType, Row, Value } from '../types.ts';
import { compareValues, ErrorCode, hashKey, OpusError, valueToText } from '../types.ts';
import type { BExpr, SubPlan } from '../plan/bound.ts';
import type { ExecContext } from './context.ts';
import { castValue, globMatch, likeMatch, SCALAR_FUNCTIONS, toBool, toNumber } from './functions.ts';
import type { Operator } from './operators.ts';

export type Compiled = (row: Row) => Value;

export interface CompileEnv {
  ctx: ExecContext;
  /** column id -> index in the input row */
  layout: Map<number, number>;
  /** Builds (and caches) the physical operator tree of a subquery. */
  planSub: (sub: SubPlan) => Operator;
}

export function layoutOf(ids: readonly number[]): Map<number, number> {
  const m = new Map<number, number>();
  ids.forEach((id, i) => {
    if (!m.has(id)) m.set(id, i);
  });
  return m;
}

const isNum = (t: DataType) => t === 'INTEGER' || t === 'REAL' || t === 'BOOLEAN';

function num(v: Value): number {
  return typeof v === 'number' ? v : (toNumber(v) as number);
}

/** Evaluates a predicate to true/false/null. */
export function truth(v: Value): boolean | null {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  return toBool(v);
}

export function compileExpr(e: BExpr, env: CompileEnv): Compiled {
  const { ctx } = env;
  switch (e.k) {
    case 'const': {
      const v = e.value;
      return () => v;
    }
    case 'col': {
      const i = env.layout.get(e.id);
      if (i !== undefined) return (row) => row[i];
      const id = e.id;
      const outer = ctx.outer;
      return () => {
        const v = outer[id];
        return v === undefined ? null : v;
      };
    }
    case 'param': {
      const i = e.index;
      return () => {
        if (i >= ctx.params.length) throw new OpusError(ErrorCode.invalidParameter, `missing value for parameter ${i + 1}`);
        const v = ctx.params[i];
        return v === undefined ? null : v;
      };
    }
    case 'unary': {
      const a = compileExpr(e.arg, env);
      if (e.op === 'NOT') {
        return (row) => {
          const t = truth(a(row));
          return t === null ? null : !t;
        };
      }
      if (e.op === '~') {
        return (row) => {
          const v = a(row);
          return v === null ? null : Number(~BigInt.asIntN(64, BigInt(Math.trunc(num(v)))));
        };
      }
      return (row) => {
        const v = a(row);
        return v === null ? null : 0 - num(v);
      };
    }
    case 'binary':
      return compileBinary(e as Extract<BExpr, { k: 'binary' }>, env);
    case 'is': {
      const l = compileExpr(e.left, env);
      const r = compileExpr(e.right, env);
      const not = e.not;
      return (row) => {
        const a = l(row);
        const b = r(row);
        let eq: boolean;
        if (a === null || b === null) eq = a === b;
        else eq = compareValues(a, b) === 0;
        return not ? !eq : eq;
      };
    }
    case 'isnull': {
      const a = compileExpr(e.arg, env);
      return e.not ? (row) => a(row) !== null : (row) => a(row) === null;
    }
    case 'like': {
      const a = compileExpr(e.arg, env);
      const p = compileExpr(e.pattern, env);
      const esc = e.escape ? compileExpr(e.escape, env) : undefined;
      const argType = e.arg.type;
      const glob = e.op === 'GLOB';
      const not = e.not;
      return (row) => {
        const v = a(row);
        const pat = p(row);
        if (v === null || pat === null) return null;
        let escape: string | undefined;
        if (esc) {
          const x = esc(row);
          if (x === null) return null;
          escape = String(x);
          if ([...escape].length !== 1) throw new OpusError(ErrorCode.invalidParameter, 'ESCAPE expression must be a single character');
        }
        const s = typeof v === 'string' ? v : (valueToText(v, argType) as string);
        const ps = typeof pat === 'string' ? pat : (valueToText(pat) as string);
        const m = glob ? globMatch(s, ps) : likeMatch(s, ps, escape);
        return not ? !m : m;
      };
    }
    case 'between': {
      const a = compileExpr(e.arg, env);
      const lo = e.low.type === 'ANY' ? applyAffinity(compileExpr(e.low, env), e.arg.type) : compileExpr(e.low, env);
      const hi = e.high.type === 'ANY' ? applyAffinity(compileExpr(e.high, env), e.arg.type) : compileExpr(e.high, env);
      const not = e.not;
      return (row) => {
        const v = a(row);
        const l = lo(row);
        const h = hi(row);
        const ge = v === null || l === null ? null : compareValues(v, l) >= 0;
        const le = v === null || h === null ? null : compareValues(v, h) <= 0;
        let r: boolean | null;
        if (ge === false || le === false) r = false;
        else if (ge === null || le === null) r = null;
        else r = true;
        return r === null ? null : not ? !r : r;
      };
    }
    case 'inlist': {
      const a = compileExpr(e.arg, env);
      const not = e.not;
      if (e.list.every((x) => x.k === 'const')) {
        const set = new Set<number | string | null>();
        let hasNull = false;
        for (const x of e.list) {
          const v = (x as { value: Value }).value;
          if (v === null) hasNull = true;
          else set.add(hashKey(v));
        }
        return (row) => {
          const v = a(row);
          if (v === null) return null;
          if (set.has(hashKey(v))) return !not;
          return hasNull ? null : not;
        };
      }
      const items = e.list.map((x) => (x.type === 'ANY' ? applyAffinity(compileExpr(x, env), e.arg.type) : compileExpr(x, env)));
      return (row) => {
        const v = a(row);
        if (v === null) return null;
        let sawNull = false;
        for (const it of items) {
          const x = it(row);
          if (x === null) sawNull = true;
          else if (compareValues(v, x) === 0) return !not;
        }
        return sawNull ? null : not;
      };
    }
    case 'insub': {
      const a = compileExpr(e.arg, env);
      const run = subqueryRunner(e.sub, env);
      const not = e.not;
      let cacheExec = -1;
      let cache: { set: Set<number | string | null>; hasNull: boolean } | null = null;
      const correlated = e.sub.freeIds.length > 0 || !!e.sub.usesWork;
      const materialize = (row: Row) => {
        const set = new Set<number | string | null>();
        let hasNull = false;
        run(row, (r) => {
          const v = r[0];
          if (v === null) hasNull = true;
          else set.add(hashKey(v));
          return true;
        });
        return { set, hasNull };
      };
      return (row) => {
        const v = a(row);
        let data: { set: Set<number | string | null>; hasNull: boolean };
        if (correlated) data = materialize(row);
        else {
          if (cacheExec !== ctx.execId || !cache) {
            cache = materialize(row);
            cacheExec = ctx.execId;
          }
          data = cache;
        }
        if (v === null) return data.set.size === 0 && !data.hasNull ? not : null;
        if (data.set.has(hashKey(v))) return !not;
        return data.hasNull ? null : not;
      };
    }
    case 'exists': {
      const run = subqueryRunner(e.sub, env);
      const correlated = e.sub.freeIds.length > 0 || !!e.sub.usesWork;
      let cacheExec = -1;
      let cached = false;
      return (row) => {
        if (!correlated && cacheExec === ctx.execId) return cached;
        let found = false;
        run(row, () => {
          found = true;
          return false;
        });
        if (!correlated) {
          cacheExec = ctx.execId;
          cached = found;
        }
        return found;
      };
    }
    case 'scalar': {
      const run = subqueryRunner(e.sub, env);
      const correlated = e.sub.freeIds.length > 0 || !!e.sub.usesWork;
      let cacheExec = -1;
      let cached: Value = null;
      return (row) => {
        if (!correlated && cacheExec === ctx.execId) return cached;
        let result: Value = null;
        run(row, (r) => {
          result = r[0];
          return false;
        });
        if (!correlated) {
          cacheExec = ctx.execId;
          cached = result;
        }
        return result;
      };
    }
    case 'func': {
      const fn = SCALAR_FUNCTIONS[e.name];
      if (!fn) throw new OpusError(ErrorCode.undefinedFunction, `no such function: ${e.name.toLowerCase()}`);
      const args = e.args.map((x) => compileExpr(x, env));
      const types = e.args.map((x) => x.type);
      const n = args.length;
      const strict = fn.strict;
      const impl = fn.fn;
      const fenv = ctx.env;
      if (n === 1) {
        const a0 = args[0];
        return (row) => {
          const v = a0(row);
          if (strict && v === null) return null;
          return impl([v], types, fenv);
        };
      }
      return (row) => {
        const vals = new Array<Value>(n);
        for (let i = 0; i < n; i++) {
          const v = args[i](row);
          if (strict && v === null) return null;
          vals[i] = v;
        }
        return impl(vals, types, fenv);
      };
    }
    case 'case': {
      const whens = e.whens.map((w) => ({ when: compileExpr(w.when, env), then: compileExpr(w.then, env) }));
      const els = e.else ? compileExpr(e.else, env) : () => null;
      if (e.operand) {
        const op = compileExpr(e.operand, env);
        return (row) => {
          const v = op(row);
          if (v !== null) {
            for (const w of whens) {
              const x = w.when(row);
              if (x !== null && compareValues(v, x) === 0) return w.then(row);
            }
          }
          return els(row);
        };
      }
      return (row) => {
        for (const w of whens) if (truth(w.when(row)) === true) return w.then(row);
        return els(row);
      };
    }
    case 'cast': {
      const a = compileExpr(e.arg, env);
      const to = e.type;
      const from = e.arg.type;
      return (row) => castValue(a(row), to, from);
    }
  }
}

/**
 * Returns a function that executes a subquery, binding correlated values from
 * the current row, and feeds result rows to `sink` until it returns false.
 */
function subqueryRunner(sub: SubPlan, env: CompileEnv): (row: Row, sink: (r: Row) => boolean) => void {
  let op: Operator | undefined;
  const bindings: [number, number][] = [];
  for (const id of sub.freeIds) {
    let i = env.layout.get(id);
    if (i === undefined && sub.alias?.has(id)) i = env.layout.get(sub.alias.get(id)!);
    if (i !== undefined) bindings.push([id, i]);
  }
  const outer = env.ctx.outer;
  return (row, sink) => {
    op ??= env.planSub(sub);
    // Save and restore bound outer values so nested evaluation is re-entrant.
    const saved = bindings.map(([id]) => outer[id]);
    for (const [id, i] of bindings) outer[id] = row[i];
    try {
      op.open();
      for (let r = op.next(); r; r = op.next()) if (!sink(r)) break;
      op.close();
    } finally {
      bindings.forEach(([id], k) => (outer[id] = saved[k]));
    }
  };
}

function compileBinary(e: Extract<BExpr, { k: 'binary' }>, env: CompileEnv): Compiled {
  const l = compileExpr(e.left, env);
  const r = compileExpr(e.right, env);
  const lt = e.left.type;
  const rt = e.right.type;
  switch (e.op) {
    case 'AND':
      return (row) => {
        const a = truth(l(row));
        if (a === false) return false;
        const b = truth(r(row));
        if (b === false) return false;
        if (a === null || b === null) return null;
        return true;
      };
    case 'OR':
      return (row) => {
        const a = truth(l(row));
        if (a === true) return true;
        const b = truth(r(row));
        if (b === true) return true;
        if (a === null || b === null) return null;
        return false;
      };
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compileComparison(e.op, l, r, lt, rt);
    case '||':
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        return (typeof a === 'string' ? a : valueToText(a, lt)!) + (typeof b === 'string' ? b : valueToText(b, rt)!);
      };
    case '+':
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        return num(a) + num(b);
      };
    case '-':
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        return num(a) - num(b);
      };
    case '*':
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        return num(a) * num(b) + 0;
      };
    case '/': {
      const mode = e.type === 'INTEGER' ? 'int' : e.type === 'REAL' ? 'real' : 'any';
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        const x = num(a);
        const y = num(b);
        if (y === 0) return null;
        if (mode === 'int' || (mode === 'any' && Number.isInteger(x) && Number.isInteger(y) && typeof a !== 'string' && typeof b !== 'string')) {
          return Math.trunc(x / y) + 0;
        }
        return x / y;
      };
    }
    case '%': {
      const intResult = e.type === 'INTEGER';
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        const x = num(a);
        const y = num(b);
        if (intResult) {
          if (y === 0) return null;
          return (x % y) + 0;
        }
        // SQLite casts both operands of % to INTEGER
        const d = Math.trunc(y);
        if (d === 0) return null;
        return (Math.trunc(x) % d) + 0;
      };
    }
    case '&':
    case '|':
    case '<<':
    case '>>': {
      const op = e.op;
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        const x = BigInt(Math.trunc(num(a)));
        const y = BigInt(Math.trunc(num(b)));
        let res: bigint;
        if (op === '&') res = x & y;
        else if (op === '|') res = x | y;
        else if (op === '<<') res = y >= 64n ? 0n : y < 0n ? x >> -y : x << y;
        else res = y >= 64n ? (x < 0n ? -1n : 0n) : y < 0n ? x << -y : x >> y;
        return Number(BigInt.asIntN(64, res));
      };
    }
    default:
      throw new OpusError(ErrorCode.internal, `unknown operator ${e.op}`);
  }
}

/** Numeric strings compare as numbers against numeric columns; numbers compare as text against TEXT columns. */
function applyAffinity(f: Compiled, target: DataType): Compiled {
  if (target === 'INTEGER' || target === 'REAL') {
    return (row) => {
      const v = f(row);
      if (typeof v === 'string') {
        const s = v.trim();
        if (s !== '' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
      }
      return v;
    };
  }
  if (target === 'TEXT') return (row) => {
    const v = f(row);
    return typeof v === 'number' ? valueToText(v) : v;
  };
  return f;
}

function compileComparison(op: string, l: Compiled, r: Compiled, lt: DataType, rt: DataType): Compiled {
  // dynamically typed operands (parameters, ANY columns) take the affinity of the typed side
  if (lt === 'ANY' && rt !== 'ANY' && rt !== 'NULL') {
    l = applyAffinity(l, rt);
    lt = 'ANY';
  } else if (rt === 'ANY' && lt !== 'ANY' && lt !== 'NULL') {
    r = applyAffinity(r, lt);
  }
  const fast = (isNum(lt) && isNum(rt)) || (lt === 'TEXT' && rt === 'TEXT');
  if (fast) {
    switch (op) {
      case '=':
        return (row) => {
          const a = l(row);
          if (a === null) return null;
          const b = r(row);
          if (b === null) return null;
          // eslint-disable-next-line eqeqeq
          return a == b;
        };
      case '!=':
        return (row) => {
          const a = l(row);
          if (a === null) return null;
          const b = r(row);
          if (b === null) return null;
          // eslint-disable-next-line eqeqeq
          return a != b;
        };
      case '<':
        return (row) => {
          const a = l(row);
          if (a === null) return null;
          const b = r(row);
          if (b === null) return null;
          return (a as number) < (b as number);
        };
      case '<=':
        return (row) => {
          const a = l(row);
          if (a === null) return null;
          const b = r(row);
          if (b === null) return null;
          return (a as number) <= (b as number);
        };
      case '>':
        return (row) => {
          const a = l(row);
          if (a === null) return null;
          const b = r(row);
          if (b === null) return null;
          return (a as number) > (b as number);
        };
      case '>=':
        return (row) => {
          const a = l(row);
          if (a === null) return null;
          const b = r(row);
          if (b === null) return null;
          return (a as number) >= (b as number);
        };
    }
  }
  let test: (c: number) => boolean;
  switch (op) {
    case '=':
      test = (c) => c === 0;
      break;
    case '!=':
      test = (c) => c !== 0;
      break;
    case '<':
      test = (c) => c < 0;
      break;
    case '<=':
      test = (c) => c <= 0;
      break;
    case '>':
      test = (c) => c > 0;
      break;
    default:
      test = (c) => c >= 0;
  }
  return (row) => {
    const a = l(row);
    if (a === null) return null;
    const b = r(row);
    if (b === null) return null;
    return test(compareValues(a, b));
  };
}

/** Compiles a list of sort keys into a row comparator over pre-computed key arrays. */
export function keyComparator(keys: { desc: boolean; nullsFirst: boolean }[]): (a: Value[], b: Value[]) => number {
  const n = keys.length;
  const desc = keys.map((k) => k.desc);
  const nullsFirst = keys.map((k) => k.nullsFirst);
  return (a, b) => {
    for (let i = 0; i < n; i++) {
      const x = a[i];
      const y = b[i];
      if (x === y) continue;
      if (x === null) return nullsFirst[i] ? -1 : 1;
      if (y === null) return nullsFirst[i] ? 1 : -1;
      let c: number;
      if (typeof x === 'number' && typeof y === 'number') c = x < y ? -1 : x > y ? 1 : 0;
      else c = compareValues(x, y);
      if (c !== 0) return desc[i] ? -c : c;
    }
    return 0;
  };
}
