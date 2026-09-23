import { ErrorCode, OpusError, normalizeTypeName } from '../types.ts';
import type { DataType } from '../types.ts';
import { RESERVED, tokenize } from './lexer.ts';
import type { Token } from './lexer.ts';
import type * as A from './ast.ts';

/**
 * Hand-written recursive-descent parser. Expression precedence follows
 * SQLite (lowest to highest):
 *
 *   OR < AND < NOT < (= == != <> IS IN LIKE BETWEEN) < (< <= > >=)
 *      < (& | << >>) < (+ -) < (* / %) < || < unary < postfix (COLLATE, ::)
 */
export class Parser {
  private readonly sql: string;
  private readonly tokens: Token[];
  private pos = 0;
  private paramCount = 0;
  private readonly named = new Map<string, number>();

  constructor(sql: string) {
    this.sql = sql;
    this.tokens = tokenize(sql);
  }

  // ------------------------------------------------------------ token helpers

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)];
  }
  private advance(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }
  private isWord(word: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'word' && t.value === word;
  }
  private acceptWord(...words: string[]): boolean {
    for (let i = 0; i < words.length; i++) if (!this.isWord(words[i], i)) return false;
    this.pos += words.length;
    return true;
  }
  private expectWord(word: string): Token {
    if (!this.isWord(word)) this.fail(`expected ${word}`);
    return this.advance();
  }
  private isOp(op: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'op' && t.value === op;
  }
  private acceptOp(op: string): boolean {
    if (this.isOp(op)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectOp(op: string): Token {
    if (!this.isOp(op)) this.fail(`expected "${op}"`);
    return this.advance();
  }

  private describe(t: Token): string {
    if (t.kind === 'eof') return 'end of input';
    return `"${t.text}"`;
  }

  private fail(expected: string, t: Token = this.peek()): never {
    throw new OpusError(ErrorCode.syntax, `syntax error at ${this.describe(t)}: ${expected}`, t.start);
  }

  /** Accepts a bare (non-reserved) word or a quoted identifier. */
  private identifier(what = 'identifier'): string {
    const t = this.peek();
    if (t.kind === 'quoted') {
      this.pos++;
      return t.value;
    }
    if (t.kind === 'word' && !RESERVED.has(t.value)) {
      this.pos++;
      return t.text;
    }
    this.fail(`expected ${what}`);
  }
  private isIdentifier(k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'quoted' || (t.kind === 'word' && !RESERVED.has(t.value));
  }

  // ------------------------------------------------------------ entry points

  parseScript(): A.ParsedStatement[] {
    const out: A.ParsedStatement[] = [];
    for (;;) {
      while (this.acceptOp(';'));
      if (this.peek().kind === 'eof') break;
      const startTok = this.peek();
      this.paramCount = 0;
      this.named.clear();
      const stmt = this.parseStatement();
      const endTok = this.tokens[this.pos - 1];
      out.push({
        stmt,
        text: this.sql.slice(startTok.start, endTok.end),
        start: startTok.start,
        end: endTok.end,
        paramCount: this.paramCount,
        paramNames: [...this.named].reduce<(string | undefined)[]>((acc, [n, i]) => ((acc[i] = n), acc), []),
      });
      if (!this.acceptOp(';') && this.peek().kind !== 'eof') this.fail('expected ";" or end of statement');
    }
    return out;
  }

  parseStatement(): A.Statement {
    const t = this.peek();
    if (t.kind === 'word') {
      switch (t.value) {
        case 'SELECT':
        case 'VALUES':
          return this.parseSelect();
        case 'WITH':
          return this.parseWithStatement();
        case 'INSERT':
        case 'REPLACE':
          return this.parseInsert();
        case 'UPDATE':
          return this.parseUpdate();
        case 'DELETE':
          return this.parseDelete();
        case 'CREATE':
          return this.parseCreate();
        case 'DROP':
          return this.parseDrop();
        case 'ALTER':
          return this.parseAlter();
        case 'BEGIN':
        case 'START':
          this.advance();
          if (t.value === 'START') this.expectWord('TRANSACTION');
          this.acceptWord('DEFERRED') || this.acceptWord('IMMEDIATE') || this.acceptWord('EXCLUSIVE');
          this.acceptWord('TRANSACTION') || this.acceptWord('WORK');
          return { type: 'begin', pos: t.start };
        case 'COMMIT':
        case 'END':
          this.advance();
          this.acceptWord('TRANSACTION') || this.acceptWord('WORK');
          return { type: 'commit', pos: t.start };
        case 'ROLLBACK':
          this.advance();
          this.acceptWord('TRANSACTION') || this.acceptWord('WORK');
          return { type: 'rollback', pos: t.start };
        case 'EXPLAIN': {
          this.advance();
          const analyze = this.acceptWord('ANALYZE');
          this.acceptWord('QUERY', 'PLAN');
          return { type: 'explain', analyze, stmt: this.parseStatement(), pos: t.start };
        }
        case 'CHECKPOINT':
          this.advance();
          return { type: 'checkpoint', pos: t.start };
        case 'VACUUM':
          this.advance();
          return { type: 'vacuum', pos: t.start };
        case 'ANALYZE': {
          this.advance();
          const target = this.isIdentifier() ? this.identifier() : undefined;
          return { type: 'analyze', target, pos: t.start };
        }
      }
    }
    if (this.isOp('(')) return this.parseSelect();
    this.fail('expected a SQL statement');
  }

  private parseWithStatement(): A.Statement {
    const save = this.pos;
    const w = this.parseWith();
    if (this.isWord('INSERT') || this.isWord('REPLACE')) {
      const s = this.parseInsert();
      s.with = w;
      return s;
    }
    if (this.isWord('UPDATE')) {
      const s = this.parseUpdate();
      s.with = w;
      return s;
    }
    if (this.isWord('DELETE')) {
      const s = this.parseDelete();
      s.with = w;
      return s;
    }
    this.pos = save;
    return this.parseSelect();
  }

  // ------------------------------------------------------------ SELECT

  private parseWith(): A.WithClause {
    this.expectWord('WITH');
    const recursive = this.acceptWord('RECURSIVE');
    const ctes: A.CommonTableExpr[] = [];
    do {
      const pos = this.peek().start;
      const name = this.identifier('common table expression name');
      let columns: string[] | undefined;
      if (this.acceptOp('(')) {
        columns = this.parseIdentList();
        this.expectOp(')');
      }
      this.expectWord('AS');
      this.acceptWord('NOT');
      this.acceptWord('MATERIALIZED');
      this.expectOp('(');
      const select = this.parseSelect();
      this.expectOp(')');
      ctes.push({ name, columns, select, pos });
    } while (this.acceptOp(','));
    return { recursive, ctes };
  }

  parseSelect(): A.SelectStmt {
    const pos = this.peek().start;
    const w = this.isWord('WITH') ? this.parseWith() : undefined;
    const body = this.parseCompound();
    const stmt: A.SelectStmt = { type: 'select', with: w, body, pos };
    if (this.acceptWord('ORDER')) {
      this.expectWord('BY');
      stmt.orderBy = this.parseOrderList();
    }
    this.parseLimit(stmt);
    return stmt;
  }

  private parseLimit(stmt: A.SelectStmt): void {
    if (this.acceptWord('LIMIT')) {
      const first = this.parseExpr();
      if (this.acceptOp(',')) {
        stmt.offset = first;
        stmt.limit = this.parseExpr();
      } else {
        stmt.limit = first;
        if (this.acceptWord('OFFSET')) stmt.offset = this.parseExpr();
      }
    } else if (this.acceptWord('OFFSET')) {
      stmt.offset = this.parseExpr();
      this.acceptWord('ROWS') || this.acceptWord('ROW');
      if (this.acceptWord('LIMIT')) stmt.limit = this.parseExpr();
    }
    if (this.acceptWord('FETCH')) {
      if (!this.acceptWord('FIRST')) this.expectWord('NEXT');
      stmt.limit = this.isWord('ROWS') || this.isWord('ROW') ? { type: 'literal', value: 1, dataType: 'INTEGER', pos: this.peek().start } : this.parseExpr();
      this.acceptWord('ROWS') || this.acceptWord('ROW');
      this.expectWord('ONLY');
    }
  }

  private parseOrderList(): A.OrderItem[] {
    const items: A.OrderItem[] = [];
    do {
      const expr = this.parseExpr();
      let desc = false;
      if (this.acceptWord('DESC')) desc = true;
      else this.acceptWord('ASC');
      let nulls: 'FIRST' | 'LAST' | undefined;
      if (this.acceptWord('NULLS')) {
        if (this.acceptWord('FIRST')) nulls = 'FIRST';
        else {
          this.expectWord('LAST');
          nulls = 'LAST';
        }
      }
      items.push({ expr, desc, nulls });
    } while (this.acceptOp(','));
    return items;
  }

  private parseCompound(): A.SelectBody {
    let left = this.parseSelectPrimary();
    for (;;) {
      const pos = this.peek().start;
      let op: A.CompoundBody['op'];
      if (this.acceptWord('UNION')) op = this.acceptWord('ALL') ? 'UNION ALL' : (this.acceptWord('DISTINCT'), 'UNION');
      else if (this.acceptWord('INTERSECT')) op = (this.acceptWord('DISTINCT'), 'INTERSECT');
      else if (this.acceptWord('EXCEPT')) op = (this.acceptWord('DISTINCT'), 'EXCEPT');
      else break;
      const right = this.parseSelectPrimary();
      left = { type: 'compound', op, left, right, pos };
    }
    return left;
  }

  private parseSelectPrimary(): A.SelectBody {
    const t = this.peek();
    if (this.isOp('(')) {
      this.advance();
      const inner = this.parseSelect();
      this.expectOp(')');
      if (!inner.orderBy && !inner.limit && !inner.offset && !inner.with) return inner.body;
      return {
        type: 'core',
        distinct: false,
        columns: [{ expr: { type: 'star', pos: t.start }, text: '*' }],
        from: { type: 'subquery', select: inner, pos: t.start },
        pos: t.start,
      };
    }
    if (this.acceptWord('VALUES')) {
      const rows: A.Expr[][] = [];
      do {
        this.expectOp('(');
        rows.push(this.parseExprList());
        this.expectOp(')');
      } while (this.acceptOp(','));
      return { type: 'values', rows, pos: t.start };
    }
    this.expectWord('SELECT');
    let distinct = false;
    if (this.acceptWord('DISTINCT')) distinct = true;
    else this.acceptWord('ALL');
    const columns = this.parseResultColumns();
    const core: A.SelectCore = { type: 'core', distinct, columns, pos: t.start };
    if (this.acceptWord('FROM')) core.from = this.parseFrom();
    if (this.acceptWord('WHERE')) core.where = this.parseExpr();
    if (this.acceptWord('GROUP')) {
      this.expectWord('BY');
      core.groupBy = this.parseExprList();
    }
    if (this.acceptWord('HAVING')) core.having = this.parseExpr();
    if (this.acceptWord('WINDOW')) {
      core.windows = new Map();
      do {
        const name = this.identifier('window name');
        this.expectWord('AS');
        core.windows.set(name.toLowerCase(), this.parseWindowSpec());
      } while (this.acceptOp(','));
    }
    return core;
  }

  private parseResultColumns(): A.ResultColumn[] {
    const cols: A.ResultColumn[] = [];
    do {
      const startTok = this.peek();
      if (this.isOp('*')) {
        this.advance();
        cols.push({ expr: { type: 'star', pos: startTok.start }, text: '*' });
        continue;
      }
      if (this.isIdentifier() && this.isOp('.', 1) && this.isOp('*', 2)) {
        const table = this.identifier();
        this.advance();
        this.advance();
        cols.push({ expr: { type: 'star', table, pos: startTok.start }, text: `${table}.*` });
        continue;
      }
      const expr = this.parseExpr();
      const text = this.sql.slice(startTok.start, this.tokens[this.pos - 1].end);
      let alias: string | undefined;
      if (this.acceptWord('AS')) alias = this.peek().kind === 'string' ? this.advance().value : this.identifier('column alias');
      else if (this.isIdentifier()) alias = this.identifier();
      else if (this.peek().kind === 'string') alias = this.advance().value;
      cols.push({ expr, alias, text });
    } while (this.acceptOp(','));
    return cols;
  }

  private parseFrom(): A.FromItem {
    let left = this.parseTableRef();
    for (;;) {
      const pos = this.peek().start;
      if (this.acceptOp(',')) {
        left = { type: 'join', kind: 'CROSS', natural: false, left, right: this.parseTableRef(), pos };
        continue;
      }
      const natural = this.acceptWord('NATURAL');
      let kind: A.JoinRef['kind'] | undefined;
      if (this.acceptWord('LEFT')) {
        this.acceptWord('OUTER');
        kind = 'LEFT';
      } else if (this.acceptWord('RIGHT')) {
        this.acceptWord('OUTER');
        kind = 'RIGHT';
      } else if (this.acceptWord('FULL')) {
        this.acceptWord('OUTER');
        kind = 'FULL';
      } else if (this.acceptWord('INNER')) kind = 'INNER';
      else if (this.acceptWord('CROSS')) kind = 'CROSS';
      if (kind === undefined && !this.isWord('JOIN')) {
        if (natural) this.fail('expected JOIN');
        break;
      }
      this.expectWord('JOIN');
      const right = this.parseTableRef();
      const join: A.JoinRef = { type: 'join', kind: kind ?? 'INNER', natural, left, right, pos };
      if (this.acceptWord('ON')) join.on = this.parseExpr();
      else if (this.acceptWord('USING')) {
        this.expectOp('(');
        join.using = this.parseIdentList();
        this.expectOp(')');
      }
      left = join;
    }
    return left;
  }

  private parseAlias(): string | undefined {
    if (this.acceptWord('AS')) return this.identifier('alias');
    if (this.isIdentifier()) return this.identifier();
    return undefined;
  }

  private parseTableRef(): A.FromItem {
    const t = this.peek();
    if (this.acceptOp('(')) {
      if (this.isWord('SELECT') || this.isWord('WITH') || this.isWord('VALUES') || this.isOp('(')) {
        const select = this.parseSelect();
        this.expectOp(')');
        return { type: 'subquery', select, alias: this.parseAlias(), pos: t.start };
      }
      const inner = this.parseFrom();
      this.expectOp(')');
      return inner;
    }
    const name = this.identifier('table name');
    if (this.acceptOp('(')) {
      const args = this.isOp(')') ? [] : this.parseExprList();
      this.expectOp(')');
      return { type: 'function_table', name: name.toLowerCase(), args, alias: this.parseAlias(), pos: t.start };
    }
    if (this.acceptOp('.')) {
      // schema-qualified name: ignore the schema ("main.t")
      const real = this.identifier('table name');
      return { type: 'table', name: real, alias: this.parseAlias(), pos: t.start };
    }
    return { type: 'table', name, alias: this.parseAlias(), pos: t.start };
  }

  private parseIdentList(): string[] {
    const out: string[] = [];
    do out.push(this.identifier());
    while (this.acceptOp(','));
    return out;
  }

  private parseExprList(): A.Expr[] {
    const out: A.Expr[] = [];
    do out.push(this.parseExpr());
    while (this.acceptOp(','));
    return out;
  }

  // ------------------------------------------------------------ expressions

  parseExpr(): A.Expr {
    return this.parseOr();
  }

  private parseOr(): A.Expr {
    let left = this.parseAnd();
    while (this.isWord('OR')) {
      const pos = this.advance().start;
      left = { type: 'binary', op: 'OR', left, right: this.parseAnd(), pos };
    }
    return left;
  }

  private parseAnd(): A.Expr {
    let left = this.parseNot();
    while (this.isWord('AND')) {
      const pos = this.advance().start;
      left = { type: 'binary', op: 'AND', left, right: this.parseNot(), pos };
    }
    return left;
  }

  private parseNot(): A.Expr {
    if (this.isWord('NOT')) {
      const pos = this.advance().start;
      return { type: 'unary', op: 'NOT', expr: this.parseNot(), pos };
    }
    return this.parseEquality();
  }

  private parseEquality(): A.Expr {
    let left = this.parseRelational();
    for (;;) {
      const t = this.peek();
      const pos = t.start;
      if (t.kind === 'op' && (t.value === '=' || t.value === '==' || t.value === '!=' || t.value === '<>')) {
        this.advance();
        const op = t.value === '=' || t.value === '==' ? '=' : '!=';
        left = { type: 'binary', op, left, right: this.parseRelational(), pos };
        continue;
      }
      if (t.kind !== 'word') break;
      if (t.value === 'IS') {
        this.advance();
        const not = this.acceptWord('NOT');
        if (this.acceptWord('NULL')) {
          left = { type: 'is_null', not, expr: left, pos };
          continue;
        }
        if (this.acceptWord('DISTINCT')) {
          this.expectWord('FROM');
          left = { type: 'is', not: !not, left, right: this.parseRelational(), pos };
          continue;
        }
        left = { type: 'is', not, left, right: this.parseRelational(), pos };
        continue;
      }
      if (t.value === 'ISNULL') {
        this.advance();
        left = { type: 'is_null', not: false, expr: left, pos };
        continue;
      }
      if (t.value === 'NOTNULL') {
        this.advance();
        left = { type: 'is_null', not: true, expr: left, pos };
        continue;
      }
      let not = false;
      if (t.value === 'NOT') {
        const n = this.peek(1);
        if (n.kind === 'word' && n.value === 'NULL') {
          this.pos += 2;
          left = { type: 'is_null', not: true, expr: left, pos };
          continue;
        }
        if (!(n.kind === 'word' && (n.value === 'IN' || n.value === 'LIKE' || n.value === 'GLOB' || n.value === 'BETWEEN' || n.value === 'ILIKE'))) break;
        this.advance();
        not = true;
      }
      const w = this.peek();
      if (w.kind !== 'word') break;
      if (w.value === 'IN') {
        this.advance();
        left = this.parseInTail(left, not, pos);
        continue;
      }
      if (w.value === 'LIKE' || w.value === 'GLOB' || w.value === 'ILIKE') {
        this.advance();
        const pattern = this.parseRelational();
        let escape: A.Expr | undefined;
        if (this.acceptWord('ESCAPE')) escape = this.parseRelational();
        left = { type: 'like', op: w.value === 'GLOB' ? 'GLOB' : 'LIKE', not, expr: left, pattern, escape, pos };
        continue;
      }
      if (w.value === 'BETWEEN') {
        this.advance();
        const low = this.parseRelational();
        this.expectWord('AND');
        const high = this.parseRelational();
        left = { type: 'between', not, expr: left, low, high, pos };
        continue;
      }
      break;
    }
    return left;
  }

  private parseInTail(expr: A.Expr, not: boolean, pos: number): A.Expr {
    if (this.isIdentifier()) {
      // `x IN tablename` (SQLite extension)
      const name = this.identifier();
      const select: A.SelectStmt = {
        type: 'select',
        pos,
        body: { type: 'core', distinct: false, columns: [{ expr: { type: 'star', pos }, text: '*' }], from: { type: 'table', name, pos }, pos },
      };
      return { type: 'in_select', not, expr, select, pos };
    }
    this.expectOp('(');
    if (this.isWord('SELECT') || this.isWord('WITH') || this.isWord('VALUES')) {
      const select = this.parseSelect();
      this.expectOp(')');
      return { type: 'in_select', not, expr, select, pos };
    }
    const list = this.isOp(')') ? [] : this.parseExprList();
    this.expectOp(')');
    return { type: 'in_list', not, expr, list, pos };
  }

  private parseRelational(): A.Expr {
    let left = this.parseBitwise();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.value === '<' || t.value === '<=' || t.value === '>' || t.value === '>=')) {
        this.advance();
        left = { type: 'binary', op: t.value, left, right: this.parseBitwise(), pos: t.start };
      } else return left;
    }
  }

  private parseBitwise(): A.Expr {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.value === '&' || t.value === '|' || t.value === '<<' || t.value === '>>')) {
        this.advance();
        left = { type: 'binary', op: t.value, left, right: this.parseAdditive(), pos: t.start };
      } else return left;
    }
  }

  private parseAdditive(): A.Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.value === '+' || t.value === '-')) {
        this.advance();
        left = { type: 'binary', op: t.value, left, right: this.parseMultiplicative(), pos: t.start };
      } else return left;
    }
  }

  private parseMultiplicative(): A.Expr {
    let left = this.parseConcat();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.advance();
        left = { type: 'binary', op: t.value, left, right: this.parseConcat(), pos: t.start };
      } else return left;
    }
  }

  private parseConcat(): A.Expr {
    let left = this.parseUnary();
    while (this.isOp('||')) {
      const pos = this.advance().start;
      left = { type: 'binary', op: '||', left, right: this.parseUnary(), pos };
    }
    return left;
  }

  private parseUnary(): A.Expr {
    const t = this.peek();
    if (t.kind === 'op' && (t.value === '-' || t.value === '+' || t.value === '~')) {
      this.advance();
      const expr = this.parseUnary();
      // fold negative numeric literals so that "-5" is an INTEGER literal
      if (t.value === '-' && expr.type === 'literal' && typeof expr.value === 'number') {
        return { ...expr, value: -expr.value, pos: t.start };
      }
      if (t.value === '+' && expr.type === 'literal' && typeof expr.value === 'number') return expr;
      return { type: 'unary', op: t.value, expr, pos: t.start };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): A.Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.acceptWord('COLLATE')) {
        this.identifier('collation name'); // collations are accepted and ignored (binary only)
        continue;
      }
      if (this.isOp('::')) {
        const pos = this.advance().start;
        const { dataType } = this.parseTypeName();
        expr = { type: 'cast', expr, to: dataType, pos };
        continue;
      }
      return expr;
    }
  }

  private parseParam(t: Token): A.ParamExpr {
    const text = t.text;
    let index: number;
    let name: string | undefined;
    if (text === '?') index = this.paramCount;
    else if (/^[?$]\d+$/.test(text)) index = Number(text.slice(1)) - 1;
    else {
      name = text.slice(1);
      const existing = this.named.get(name);
      if (existing !== undefined) index = existing;
      else {
        index = this.paramCount;
        this.named.set(name, index);
      }
    }
    if (index < 0) throw new OpusError(ErrorCode.syntax, `invalid parameter ${text}`, t.start);
    this.paramCount = Math.max(this.paramCount, index + 1);
    return { type: 'param', index, name, pos: t.start };
  }

  private parsePrimary(): A.Expr {
    const t = this.peek();
    switch (t.kind) {
      case 'integer': {
        this.advance();
        const v = Number(t.value);
        return { type: 'literal', value: v, dataType: Number.isSafeInteger(v) ? 'INTEGER' : 'REAL', pos: t.start };
      }
      case 'real':
        this.advance();
        return { type: 'literal', value: Number(t.value), dataType: 'REAL', pos: t.start };
      case 'string':
        this.advance();
        return { type: 'literal', value: t.value, dataType: 'TEXT', pos: t.start };
      case 'param':
        this.advance();
        return this.parseParam(t);
      case 'quoted':
        return this.parseColumnOrFunction();
      case 'op':
        if (t.value === '(') {
          this.advance();
          if (this.isWord('SELECT') || this.isWord('WITH') || this.isWord('VALUES')) {
            const select = this.parseSelect();
            this.expectOp(')');
            return { type: 'subquery', select, pos: t.start };
          }
          const e = this.parseExpr();
          if (this.isOp(',')) this.fail('row values are not supported');
          this.expectOp(')');
          return e;
        }
        break;
      case 'word':
        switch (t.value) {
          case 'NULL':
            this.advance();
            return { type: 'literal', value: null, dataType: 'NULL', pos: t.start };
          case 'TRUE':
            this.advance();
            return { type: 'literal', value: true, dataType: 'BOOLEAN', pos: t.start };
          case 'FALSE':
            this.advance();
            return { type: 'literal', value: false, dataType: 'BOOLEAN', pos: t.start };
          case 'CASE':
            return this.parseCase();
          case 'CAST': {
            this.advance();
            this.expectOp('(');
            const expr = this.parseExpr();
            this.expectWord('AS');
            const { dataType } = this.parseTypeName();
            this.expectOp(')');
            return { type: 'cast', expr, to: dataType, pos: t.start };
          }
          case 'EXISTS': {
            this.advance();
            this.expectOp('(');
            const select = this.parseSelect();
            this.expectOp(')');
            return { type: 'exists', select, pos: t.start };
          }
          case 'CURRENT_TIMESTAMP':
          case 'CURRENT_DATE':
          case 'CURRENT_TIME':
            this.advance();
            return { type: 'function', name: t.value, args: [], distinct: false, star: false, pos: t.start };
        }
        if (!RESERVED.has(t.value)) return this.parseColumnOrFunction();
        // a few reserved words are also function names
        if ((t.value === 'LIKE' || t.value === 'GLOB' || t.value === 'REPLACE') && this.isOp('(', 1)) return this.parseColumnOrFunction();
        break;
    }
    this.fail('expected an expression');
  }

  private parseColumnOrFunction(): A.Expr {
    const t = this.advance();
    const first = t.kind === 'quoted' ? t.value : t.text;
    if (t.kind === 'word' && this.isOp('(')) return this.parseFunctionCall(t.value, t.start);
    if (this.acceptOp('.')) {
      const nt = this.peek();
      if (nt.kind === 'quoted' || nt.kind === 'word') {
        this.advance();
        const name = nt.kind === 'quoted' ? nt.value : nt.text;
        // schema.table.column -> ignore schema
        if (this.acceptOp('.')) {
          const ct = this.advance();
          return { type: 'column', table: name, name: ct.kind === 'quoted' ? ct.value : ct.text, pos: t.start };
        }
        return { type: 'column', table: first, name, pos: t.start };
      }
      this.fail('expected column name');
    }
    return { type: 'column', name: first, pos: t.start };
  }

  private parseFunctionCall(name: string, pos: number): A.FunctionExpr {
    this.expectOp('(');
    const fn: A.FunctionExpr = { type: 'function', name, args: [], distinct: false, star: false, pos };
    if (this.acceptOp('*')) fn.star = true;
    else if (!this.isOp(')')) {
      if (this.acceptWord('DISTINCT')) fn.distinct = true;
      else this.acceptWord('ALL');
      fn.args = this.parseExprList();
      if (this.acceptWord('ORDER')) {
        this.expectWord('BY');
        fn.orderBy = this.parseOrderList();
      }
    }
    this.expectOp(')');
    if (this.acceptWord('FILTER')) {
      this.expectOp('(');
      this.expectWord('WHERE');
      fn.filter = this.parseExpr();
      this.expectOp(')');
    }
    if (this.acceptWord('OVER')) {
      if (this.isIdentifier()) {
        // named window: resolved by the binder via a sentinel partition
        const ref = this.identifier();
        fn.over = { partitionBy: [], orderBy: [], frame: undefined };
        (fn.over as A.WindowSpec & { ref?: string }).ref = ref.toLowerCase();
      } else fn.over = this.parseWindowSpec();
    }
    return fn;
  }

  private parseWindowSpec(): A.WindowSpec {
    this.expectOp('(');
    const spec: A.WindowSpec & { ref?: string } = { partitionBy: [], orderBy: [] };
    if (this.isIdentifier() && !this.isWord('PARTITION') && !this.isWord('ORDER') && !this.isWord('ROWS') && !this.isWord('RANGE')) {
      spec.ref = this.identifier().toLowerCase();
    }
    if (this.acceptWord('PARTITION')) {
      this.expectWord('BY');
      spec.partitionBy = this.parseExprList();
    }
    if (this.acceptWord('ORDER')) {
      this.expectWord('BY');
      spec.orderBy = this.parseOrderList();
    }
    if (this.isWord('ROWS') || this.isWord('RANGE')) {
      const mode = this.advance().value as 'ROWS' | 'RANGE';
      if (this.acceptWord('BETWEEN')) {
        const start = this.parseFrameBound();
        this.expectWord('AND');
        const end = this.parseFrameBound();
        spec.frame = { mode, start, end };
      } else {
        spec.frame = { mode, start: this.parseFrameBound(), end: { kind: 'current_row' } };
      }
    }
    this.expectOp(')');
    return spec;
  }

  private parseFrameBound(): A.FrameBound {
    if (this.acceptWord('UNBOUNDED')) {
      if (this.acceptWord('PRECEDING')) return { kind: 'unbounded_preceding' };
      this.expectWord('FOLLOWING');
      return { kind: 'unbounded_following' };
    }
    if (this.acceptWord('CURRENT')) {
      this.expectWord('ROW');
      return { kind: 'current_row' };
    }
    const t = this.peek();
    if (t.kind !== 'integer') this.fail('expected frame offset');
    this.advance();
    const offset = Number(t.value);
    if (this.acceptWord('PRECEDING')) return { kind: 'preceding', offset };
    this.expectWord('FOLLOWING');
    return { kind: 'following', offset };
  }

  private parseCase(): A.CaseExpr {
    const pos = this.expectWord('CASE').start;
    const node: A.CaseExpr = { type: 'case', whens: [], pos };
    if (!this.isWord('WHEN')) node.operand = this.parseExpr();
    while (this.acceptWord('WHEN')) {
      const when = this.parseExpr();
      this.expectWord('THEN');
      node.whens.push({ when, then: this.parseExpr() });
    }
    if (node.whens.length === 0) this.fail('expected WHEN');
    if (this.acceptWord('ELSE')) node.else = this.parseExpr();
    this.expectWord('END');
    return node;
  }

  /** Parses a type name such as INTEGER, VARCHAR(20), DOUBLE PRECISION, UNSIGNED BIG INT. */
  private parseTypeName(): { typeName: string; dataType: DataType } {
    const start = this.peek();
    const words: string[] = [];
    while (this.peek().kind === 'word' && !TYPE_STOP_WORDS.has(this.peek().value)) {
      words.push(this.advance().value);
      if (words.length > 0 && this.isOp('(')) break;
    }
    if (words.length === 0) this.fail('expected a type name');
    if (this.acceptOp('(')) {
      // precision / length arguments are accepted and ignored
      while (!this.isOp(')') && this.peek().kind !== 'eof') this.advance();
      this.expectOp(')');
    }
    const typeName = words.join(' ');
    return { typeName, dataType: normalizeTypeName(typeName, start.start) };
  }

  // ------------------------------------------------------------ DML

  private parseReturning(): A.ResultColumn[] | undefined {
    if (!this.acceptWord('RETURNING')) return undefined;
    return this.parseResultColumns();
  }

  private parseInsert(): A.InsertStmt {
    const pos = this.peek().start;
    let conflict: A.InsertStmt['conflict'];
    if (this.acceptWord('REPLACE')) conflict = 'REPLACE';
    else {
      this.expectWord('INSERT');
      if (this.acceptWord('OR')) {
        if (this.acceptWord('REPLACE')) conflict = 'REPLACE';
        else if (this.acceptWord('IGNORE')) conflict = 'IGNORE';
        else this.fail('expected REPLACE or IGNORE');
      }
    }
    this.expectWord('INTO');
    const table = this.parseQualifiedName();
    if (this.acceptWord('AS')) this.identifier();
    let columns: string[] | undefined;
    if (this.isOp('(') && !(this.isWord('SELECT', 1) || this.isWord('WITH', 1) || this.isWord('VALUES', 1))) {
      this.advance();
      columns = this.parseIdentList();
      this.expectOp(')');
    }
    let source: A.InsertStmt['source'];
    if (this.acceptWord('DEFAULT')) {
      this.expectWord('VALUES');
      source = 'DEFAULT';
    } else source = this.parseSelect();
    const stmt: A.InsertStmt = { type: 'insert', table, columns, source, conflict, pos };
    if (this.acceptWord('ON')) {
      this.expectWord('CONFLICT');
      let target: string[] | undefined;
      if (this.acceptOp('(')) {
        target = this.parseIdentList();
        this.expectOp(')');
      }
      this.expectWord('DO');
      if (this.acceptWord('NOTHING')) stmt.upsert = { target, action: 'NOTHING' };
      else {
        this.expectWord('UPDATE');
        this.expectWord('SET');
        const set = this.parseSetList();
        const where = this.acceptWord('WHERE') ? this.parseExpr() : undefined;
        stmt.upsert = { target, action: { set, where } };
      }
    }
    stmt.returning = this.parseReturning();
    return stmt;
  }

  private parseQualifiedName(): string {
    const name = this.identifier('table name');
    if (this.acceptOp('.')) return this.identifier('table name');
    return name;
  }

  private parseSetList(): A.SetClause[] {
    const set: A.SetClause[] = [];
    do {
      const pos = this.peek().start;
      const column = this.identifier('column name');
      this.expectOp('=');
      set.push({ column, value: this.parseExpr(), pos });
    } while (this.acceptOp(','));
    return set;
  }

  private parseUpdate(): A.UpdateStmt {
    const pos = this.expectWord('UPDATE').start;
    if (this.acceptWord('OR')) this.advance();
    const table = this.parseQualifiedName();
    const alias = this.parseAlias();
    this.expectWord('SET');
    const set = this.parseSetList();
    const stmt: A.UpdateStmt = { type: 'update', table, alias, set, pos };
    if (this.acceptWord('FROM')) stmt.from = this.parseFrom();
    if (this.acceptWord('WHERE')) stmt.where = this.parseExpr();
    stmt.returning = this.parseReturning();
    return stmt;
  }

  private parseDelete(): A.DeleteStmt {
    const pos = this.expectWord('DELETE').start;
    this.expectWord('FROM');
    const table = this.parseQualifiedName();
    const alias = this.parseAlias();
    const stmt: A.DeleteStmt = { type: 'delete', table, alias, pos };
    if (this.acceptWord('WHERE')) stmt.where = this.parseExpr();
    stmt.returning = this.parseReturning();
    return stmt;
  }

  // ------------------------------------------------------------ DDL

  private parseIfNotExists(): boolean {
    return this.acceptWord('IF', 'NOT', 'EXISTS');
  }

  private parseCreate(): A.Statement {
    const pos = this.expectWord('CREATE').start;
    this.acceptWord('TEMP') || this.acceptWord('TEMPORARY');
    const unique = this.acceptWord('UNIQUE');
    if (this.acceptWord('INDEX')) {
      const ifNotExists = this.parseIfNotExists();
      const name = this.identifier('index name');
      this.expectWord('ON');
      const table = this.parseQualifiedName();
      this.expectOp('(');
      const columns: A.CreateIndexStmt['columns'] = [];
      do {
        const cpos = this.peek().start;
        const cname = this.identifier('column name');
        if (this.acceptWord('COLLATE')) this.identifier();
        const desc = this.acceptWord('DESC') ? true : (this.acceptWord('ASC'), false);
        columns.push({ name: cname, desc, pos: cpos });
      } while (this.acceptOp(','));
      this.expectOp(')');
      return { type: 'create_index', name, table, unique, ifNotExists, columns, pos };
    }
    if (unique) this.fail('expected INDEX');
    if (this.acceptWord('VIEW')) {
      const ifNotExists = this.parseIfNotExists();
      const name = this.identifier('view name');
      let columns: string[] | undefined;
      if (this.acceptOp('(')) {
        columns = this.parseIdentList();
        this.expectOp(')');
      }
      this.expectWord('AS');
      const startTok = this.peek();
      const select = this.parseSelect();
      const selectText = this.sql.slice(startTok.start, this.tokens[this.pos - 1].end);
      return { type: 'create_view', name, ifNotExists, columns, select, selectText, pos };
    }
    this.expectWord('TABLE');
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseQualifiedName();
    const stmt: A.CreateTableStmt = { type: 'create_table', name, ifNotExists, columns: [], constraints: [], pos };
    if (this.acceptWord('AS')) {
      stmt.as = this.parseSelect();
      return stmt;
    }
    this.expectOp('(');
    do {
      if (this.isWord('PRIMARY') || this.isWord('UNIQUE') || this.isWord('CHECK') || this.isWord('FOREIGN') || this.isWord('CONSTRAINT')) {
        stmt.constraints.push(this.parseTableConstraint());
      } else stmt.columns.push(this.parseColumnDef());
    } while (this.acceptOp(','));
    this.expectOp(')');
    // trailing table options such as WITHOUT ROWID / STRICT are accepted and ignored
    while (this.acceptWord('WITHOUT') || this.acceptWord('STRICT') || this.acceptWord('ROWID')) this.acceptOp(',');
    return stmt;
  }

  private parseTableConstraint(): A.TableConstraint {
    const pos = this.peek().start;
    if (this.acceptWord('CONSTRAINT')) this.identifier('constraint name');
    if (this.acceptWord('PRIMARY')) {
      this.expectWord('KEY');
      this.expectOp('(');
      const columns = this.parseIndexedColumnNames();
      this.expectOp(')');
      return { type: 'primary_key', columns, pos };
    }
    if (this.acceptWord('UNIQUE')) {
      this.expectOp('(');
      const columns = this.parseIndexedColumnNames();
      this.expectOp(')');
      return { type: 'unique', columns, pos };
    }
    if (this.acceptWord('CHECK')) {
      this.expectOp('(');
      const expr = this.parseExpr();
      this.expectOp(')');
      return { type: 'check', expr, pos };
    }
    this.expectWord('FOREIGN');
    this.expectWord('KEY');
    this.expectOp('(');
    const columns = this.parseIdentList();
    this.expectOp(')');
    const ref = this.parseReferences();
    return { type: 'foreign_key', columns, table: ref.table, refColumns: ref.columns, pos };
  }

  private parseIndexedColumnNames(): string[] {
    const out: string[] = [];
    do {
      out.push(this.identifier('column name'));
      this.acceptWord('ASC') || this.acceptWord('DESC');
    } while (this.acceptOp(','));
    return out;
  }

  private parseReferences(): { table: string; columns?: string[] } {
    this.expectWord('REFERENCES');
    const table = this.identifier('table name');
    let columns: string[] | undefined;
    if (this.acceptOp('(')) {
      columns = this.parseIdentList();
      this.expectOp(')');
    }
    // ON DELETE/UPDATE actions and MATCH/DEFERRABLE clauses are parsed and ignored
    for (;;) {
      if (this.acceptWord('ON')) {
        this.advance(); // DELETE | UPDATE
        if (this.acceptWord('SET')) this.advance();
        else if (this.acceptWord('NO')) this.expectWord('ACTION');
        else this.advance(); // CASCADE | RESTRICT
      } else if (this.acceptWord('MATCH')) this.advance();
      else if (this.acceptWord('DEFERRABLE') || this.acceptWord('NOT', 'DEFERRABLE')) {
        if (this.acceptWord('INITIALLY')) this.advance();
      } else break;
    }
    return { table, columns };
  }

  private parseColumnDef(): A.ColumnDef {
    const pos = this.peek().start;
    const name = this.identifier('column name');
    let typeName = '';
    let dataType: DataType = 'ANY';
    if (this.peek().kind === 'word' && !TYPE_STOP_WORDS.has(this.peek().value)) {
      ({ typeName, dataType } = this.parseTypeName());
    }
    const col: A.ColumnDef = {
      name,
      typeName,
      dataType,
      notNull: false,
      primaryKey: false,
      primaryKeyDesc: false,
      autoincrement: false,
      unique: false,
      pos,
    };
    for (;;) {
      if (this.acceptWord('CONSTRAINT')) this.identifier('constraint name');
      if (this.acceptWord('PRIMARY')) {
        this.expectWord('KEY');
        col.primaryKey = true;
        if (this.acceptWord('DESC')) col.primaryKeyDesc = true;
        else this.acceptWord('ASC');
        if (this.acceptWord('AUTOINCREMENT')) col.autoincrement = true;
      } else if (this.acceptWord('NOT')) {
        this.expectWord('NULL');
        col.notNull = true;
      } else if (this.acceptWord('NULL')) {
        // explicit nullability, nothing to do
      } else if (this.acceptWord('UNIQUE')) col.unique = true;
      else if (this.acceptWord('DEFAULT')) {
        if (this.acceptOp('(')) {
          col.default = this.parseExpr();
          this.expectOp(')');
        } else col.default = this.parseUnary();
      } else if (this.acceptWord('CHECK')) {
        this.expectOp('(');
        col.check = this.parseExpr();
        this.expectOp(')');
      } else if (this.isWord('REFERENCES')) {
        const r = this.parseReferences();
        col.references = { table: r.table, column: r.columns?.[0] };
      } else if (this.acceptWord('COLLATE')) this.identifier('collation');
      else break;
    }
    return col;
  }

  private parseDrop(): A.DropStmt {
    const pos = this.expectWord('DROP').start;
    let kind: A.DropStmt['kind'];
    if (this.acceptWord('TABLE')) kind = 'TABLE';
    else if (this.acceptWord('INDEX')) kind = 'INDEX';
    else if (this.acceptWord('VIEW')) kind = 'VIEW';
    else this.fail('expected TABLE, INDEX or VIEW');
    const ifExists = this.acceptWord('IF', 'EXISTS');
    const name = this.parseQualifiedName();
    return { type: 'drop', kind, name, ifExists, pos };
  }

  private parseAlter(): A.AlterTableStmt {
    const pos = this.expectWord('ALTER').start;
    this.expectWord('TABLE');
    const table = this.parseQualifiedName();
    if (this.acceptWord('ADD')) {
      this.acceptWord('COLUMN');
      return { type: 'alter_table', table, action: { kind: 'add_column', column: this.parseColumnDef() }, pos };
    }
    this.expectWord('RENAME');
    if (this.acceptWord('TO')) return { type: 'alter_table', table, action: { kind: 'rename_table', to: this.identifier('table name') }, pos };
    this.acceptWord('COLUMN');
    const from = this.identifier('column name');
    this.expectWord('TO');
    return { type: 'alter_table', table, action: { kind: 'rename_column', from, to: this.identifier('column name') }, pos };
  }
}

const TYPE_STOP_WORDS = new Set([
  'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'DEFAULT', 'CHECK', 'REFERENCES', 'CONSTRAINT', 'COLLATE', 'GENERATED', 'AS',
  'ASC', 'DESC', 'AUTOINCREMENT',
]);

export function parse(sql: string): A.ParsedStatement[] {
  return new Parser(sql).parseScript();
}

export function parseOne(sql: string): A.Statement {
  const stmts = parse(sql);
  if (stmts.length !== 1) throw new OpusError(ErrorCode.syntax, `expected exactly one statement, got ${stmts.length}`, 0);
  return stmts[0].stmt;
}

export function parseExpression(sql: string): A.Expr {
  const p = new Parser(sql);
  return p.parseExpr();
}
