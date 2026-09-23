import type { BExpr } from './bound.ts';
import { describeValue } from '../types.ts';

/** Compact SQL-ish rendering of a bound expression, used in EXPLAIN output. */
export function showExpr(e: BExpr): string {
  switch (e.k) {
    case 'const':
      return describeValue(e.value);
    case 'col':
      return e.name;
    case 'param':
      return `$${e.index + 1}`;
    case 'unary':
      return e.op === 'NOT' ? `NOT ${wrap(e.arg)}` : `${e.op}${wrap(e.arg)}`;
    case 'binary':
      return `${wrap(e.left)} ${e.op} ${wrap(e.right)}`;
    case 'is':
      return `${wrap(e.left)} IS ${e.not ? 'NOT ' : ''}${wrap(e.right)}`;
    case 'isnull':
      return `${wrap(e.arg)} IS ${e.not ? 'NOT ' : ''}NULL`;
    case 'like':
      return `${wrap(e.arg)} ${e.not ? 'NOT ' : ''}${e.op} ${wrap(e.pattern)}`;
    case 'between':
      return `${wrap(e.arg)} ${e.not ? 'NOT ' : ''}BETWEEN ${wrap(e.low)} AND ${wrap(e.high)}`;
    case 'inlist':
      return `${wrap(e.arg)} ${e.not ? 'NOT ' : ''}IN (${e.list.map(showExpr).join(', ')})`;
    case 'insub':
      return `${wrap(e.arg)} ${e.not ? 'NOT ' : ''}IN (SubPlan)`;
    case 'exists':
      return 'EXISTS (SubPlan)';
    case 'scalar':
      return '(SubPlan)';
    case 'func':
      return `${e.name.toLowerCase()}(${e.args.map(showExpr).join(', ')})`;
    case 'case':
      return `CASE${e.operand ? ' ' + showExpr(e.operand) : ''} ${e.whens.map((w) => `WHEN ${showExpr(w.when)} THEN ${showExpr(w.then)}`).join(' ')}${e.else ? ` ELSE ${showExpr(e.else)}` : ''} END`;
    case 'cast':
      return `CAST(${showExpr(e.arg)} AS ${e.type})`;
  }
}

function wrap(e: BExpr): string {
  const s = showExpr(e);
  return e.k === 'binary' || e.k === 'between' || e.k === 'like' || e.k === 'is' ? `(${s})` : s;
}
