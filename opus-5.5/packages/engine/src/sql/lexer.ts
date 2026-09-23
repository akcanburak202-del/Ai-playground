import { ErrorCode, OpusError } from '../types.ts';

export type TokenKind =
  | 'word' // keyword or bare identifier (parser decides)
  | 'quoted' // "quoted identifier"
  | 'integer'
  | 'real'
  | 'string'
  | 'param'
  | 'op'
  | 'comment'
  | 'space'
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  /** Normalised value: upper-cased word, unquoted identifier/string, operator text. */
  value: string;
  start: number;
  end: number;
}

/** Words that can never be used as a bare identifier or implicit alias. */
export const RESERVED = new Set([
  'ALL', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CHECK', 'COLLATE', 'CREATE', 'CROSS', 'DEFAULT',
  'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXISTS', 'EXPLAIN', 'FALSE', 'FROM',
  'FULL', 'GLOB', 'GROUP', 'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'ISNULL', 'JOIN',
  'LEFT', 'LIKE', 'LIMIT', 'NATURAL', 'NOT', 'NOTNULL', 'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY',
  'REFERENCES', 'RETURNING', 'RIGHT', 'SELECT', 'SET', 'TABLE', 'THEN', 'TRUE', 'UNION', 'UNIQUE', 'UPDATE', 'USING',
  'VALUES', 'WHEN', 'WHERE', 'WITH', 'WINDOW', 'OVER', 'FILTER',
]);

/** Every keyword the parser understands; used for syntax highlighting and completion. */
export const KEYWORDS = new Set([
  ...RESERVED,
  'ABORT', 'ACTION', 'ADD', 'ALTER', 'ANALYZE', 'AUTOINCREMENT', 'BEGIN', 'CHECKPOINT', 'COLUMN', 'COMMIT', 'CONFLICT',
  'CURRENT', 'DEFERRED', 'DO', 'FIRST', 'FOLLOWING', 'IF', 'IGNORE', 'KEY', 'LAST', 'NOTHING', 'NULLS', 'PARTITION',
  'PRECEDING', 'RANGE', 'RECURSIVE', 'RENAME', 'REPLACE', 'ROLLBACK', 'ROW', 'ROWS', 'TO', 'TRANSACTION', 'UNBOUNDED',
  'VACUUM', 'WORK', 'SAVEPOINT', 'RELEASE', 'COLUMN', 'TEMP', 'TEMPORARY', 'VIEW', 'SHOW', 'TABLES', 'DESCRIBE',
]);

const OPERATORS = ['||', '<=', '>=', '<>', '!=', '==', '<<', '>>', '->', '::', '=', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', ';', '.', '&', '|', '~'];

function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127;
}
function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57) || c === 36;
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

export interface TokenizeOptions {
  /** Keep whitespace and comments (used by the Studio syntax highlighter). */
  trivia?: boolean;
  /** Never throw; unterminated strings/comments become tokens that run to EOF. */
  tolerant?: boolean;
}

export function tokenize(sql: string, opts: TokenizeOptions = {}): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, value?: string) => {
    if (!opts.trivia && (kind === 'space' || kind === 'comment')) return;
    const text = sql.slice(start, end);
    tokens.push({ kind, text, value: value ?? text, start, end });
  };

  while (i < n) {
    const c = sql.charCodeAt(i);
    const start = i;

    // whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) {
      while (i < n) {
        const d = sql.charCodeAt(i);
        if (d === 32 || d === 9 || d === 10 || d === 13 || d === 12) i++;
        else break;
      }
      push('space', start, i);
      continue;
    }

    // -- line comment
    if (c === 45 && sql.charCodeAt(i + 1) === 45) {
      while (i < n && sql.charCodeAt(i) !== 10) i++;
      push('comment', start, i);
      continue;
    }

    // /* block comment */
    if (c === 47 && sql.charCodeAt(i + 1) === 42) {
      const close = sql.indexOf('*/', i + 2);
      if (close < 0) {
        if (!opts.tolerant) throw new OpusError(ErrorCode.syntax, 'unterminated block comment', start);
        i = n;
      } else i = close + 2;
      push('comment', start, i);
      continue;
    }

    // words
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(sql.charCodeAt(i))) i++;
      const text = sql.slice(start, i);
      push('word', start, i, text.toUpperCase());
      continue;
    }

    // numbers
    if (isDigit(c) || (c === 46 && isDigit(sql.charCodeAt(i + 1)))) {
      let isReal = false;
      if (c === 48 && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(sql[i])) i++;
        push('integer', start, i, String(Number.parseInt(sql.slice(start + 2, i), 16)));
        continue;
      }
      while (i < n && isDigit(sql.charCodeAt(i))) i++;
      if (sql.charCodeAt(i) === 46) {
        isReal = true;
        i++;
        while (i < n && isDigit(sql.charCodeAt(i))) i++;
      }
      if (sql[i] === 'e' || sql[i] === 'E') {
        const save = i;
        i++;
        if (sql[i] === '+' || sql[i] === '-') i++;
        if (isDigit(sql.charCodeAt(i))) {
          isReal = true;
          while (i < n && isDigit(sql.charCodeAt(i))) i++;
        } else i = save;
      }
      if (i < n && isIdentStart(sql.charCodeAt(i)) && !opts.tolerant) {
        throw new OpusError(ErrorCode.syntax, `unrecognized token "${sql.slice(start, i + 1)}"`, start);
      }
      push(isReal ? 'real' : 'integer', start, i);
      continue;
    }

    // 'string literal'
    if (c === 39) {
      let value = '';
      i++;
      let closed = false;
      while (i < n) {
        const d = sql.charCodeAt(i);
        if (d === 39) {
          if (sql.charCodeAt(i + 1) === 39) {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += sql[i];
        i++;
      }
      if (!closed && !opts.tolerant) throw new OpusError(ErrorCode.syntax, 'unterminated string literal', start);
      push('string', start, i, value);
      continue;
    }

    // "quoted identifier" or `quoted identifier` or [quoted identifier]
    if (c === 34 || c === 96 || c === 91) {
      const close = c === 91 ? ']' : sql[i];
      let value = '';
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += sql[i];
        i++;
      }
      if (!closed && !opts.tolerant) throw new OpusError(ErrorCode.syntax, 'unterminated quoted identifier', start);
      push('quoted', start, i, value);
      continue;
    }

    // parameters: ?  ?NNN  $NNN  :name  @name
    if (c === 63 || c === 36 || ((c === 58 || c === 64) && isIdentStart(sql.charCodeAt(i + 1)))) {
      i++;
      while (i < n && isIdentPart(sql.charCodeAt(i))) i++;
      push('param', start, i);
      continue;
    }

    // operators
    let matched = false;
    for (const op of OPERATORS) {
      if (sql.startsWith(op, i)) {
        i += op.length;
        push('op', start, i);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (opts.tolerant) {
      i++;
      push('op', start, i);
      continue;
    }
    throw new OpusError(ErrorCode.syntax, `unexpected character "${sql[i]}"`, start);
  }
  if (!opts.trivia) tokens.push({ kind: 'eof', text: '', value: '', start: n, end: n });
  return tokens;
}

/** Converts a character offset into a 1-based line/column pair. */
export function lineCol(sql: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else col++;
  }
  return { line, col };
}
