import type * as A from './ast.ts';
import { describeValue } from '../types.ts';

/** Renders AST expressions back to SQL (used for canonical DDL and EXPLAIN output). */

function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function quoteIdent(name: string): string {
  return ident(name);
}

export function exprToSql(e: A.Expr): string {
  switch (e.type) {
    case 'literal':
      return describeValue(e.value);
    case 'column':
      return e.table ? `${ident(e.table)}.${ident(e.name)}` : ident(e.name);
    case 'star':
      return e.table ? `${ident(e.table)}.*` : '*';
    case 'param':
      return e.name ? `:${e.name}` : `?${e.index + 1}`;
    case 'unary':
      return e.op === 'NOT' ? `NOT ${exprToSql(e.expr)}` : `${e.op}${wrap(e.expr)}`;
    case 'binary':
      return `${wrap(e.left)} ${e.op} ${wrap(e.right)}`;
    case 'is':
      return `${wrap(e.left)} IS ${e.not ? 'NOT ' : ''}${wrap(e.right)}`;
    case 'is_null':
      return `${wrap(e.expr)} IS ${e.not ? 'NOT ' : ''}NULL`;
    case 'like':
      return `${wrap(e.expr)} ${e.not ? 'NOT ' : ''}${e.op} ${wrap(e.pattern)}${e.escape ? ` ESCAPE ${wrap(e.escape)}` : ''}`;
    case 'between':
      return `${wrap(e.expr)} ${e.not ? 'NOT ' : ''}BETWEEN ${wrap(e.low)} AND ${wrap(e.high)}`;
    case 'in_list':
      return `${wrap(e.expr)} ${e.not ? 'NOT ' : ''}IN (${e.list.map(exprToSql).join(', ')})`;
    case 'in_select':
      return `${wrap(e.expr)} ${e.not ? 'NOT ' : ''}IN (…)`;
    case 'exists':
      return 'EXISTS (…)';
    case 'subquery':
      return '(…)';
    case 'function': {
      if (e.star) return `${e.name}(*)`;
      return `${e.name}(${e.distinct ? 'DISTINCT ' : ''}${e.args.map(exprToSql).join(', ')})${e.over ? ' OVER (…)' : ''}`;
    }
    case 'case': {
      let s = 'CASE';
      if (e.operand) s += ' ' + exprToSql(e.operand);
      for (const w of e.whens) s += ` WHEN ${exprToSql(w.when)} THEN ${exprToSql(w.then)}`;
      if (e.else) s += ` ELSE ${exprToSql(e.else)}`;
      return s + ' END';
    }
    case 'cast':
      return `CAST(${exprToSql(e.expr)} AS ${e.to})`;
  }
}

function wrap(e: A.Expr): string {
  const s = exprToSql(e);
  if (e.type === 'binary' || e.type === 'between' || e.type === 'like' || e.type === 'is' || e.type === 'in_list') return `(${s})`;
  return s;
}
