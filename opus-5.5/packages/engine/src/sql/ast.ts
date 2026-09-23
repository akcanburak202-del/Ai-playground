import type { DataType, Value } from '../types.ts';

// ---------------------------------------------------------------- expressions

interface Node {
  /** Character offset of the node in the source SQL (for error messages). */
  pos: number;
}

export interface LiteralExpr extends Node {
  type: 'literal';
  value: Value;
  /** Static type of the literal ('NULL' for NULL). */
  dataType: DataType;
}
export interface ColumnExpr extends Node {
  type: 'column';
  table?: string;
  name: string;
}
export interface StarExpr extends Node {
  type: 'star';
  table?: string;
}
export interface ParamExpr extends Node {
  type: 'param';
  /** Zero-based positional index. */
  index: number;
  name?: string;
}
export interface UnaryExpr extends Node {
  type: 'unary';
  op: '-' | '+' | 'NOT' | '~';
  expr: Expr;
}
export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '||'
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'AND' | 'OR' | '&' | '|' | '<<' | '>>';
export interface BinaryExpr extends Node {
  type: 'binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
}
export interface IsExpr extends Node {
  /** `a IS b` / `a IS NOT b` / `IS [NOT] DISTINCT FROM`: null-safe (in)equality. */
  type: 'is';
  not: boolean;
  left: Expr;
  right: Expr;
}
export interface IsNullExpr extends Node {
  type: 'is_null';
  not: boolean;
  expr: Expr;
}
export interface LikeExpr extends Node {
  type: 'like';
  op: 'LIKE' | 'GLOB';
  not: boolean;
  expr: Expr;
  pattern: Expr;
  escape?: Expr;
}
export interface BetweenExpr extends Node {
  type: 'between';
  not: boolean;
  expr: Expr;
  low: Expr;
  high: Expr;
}
export interface InListExpr extends Node {
  type: 'in_list';
  not: boolean;
  expr: Expr;
  list: Expr[];
}
export interface InSelectExpr extends Node {
  type: 'in_select';
  not: boolean;
  expr: Expr;
  select: SelectStmt;
}
export interface ExistsExpr extends Node {
  type: 'exists';
  select: SelectStmt;
}
export interface SubqueryExpr extends Node {
  type: 'subquery';
  select: SelectStmt;
}
export interface WindowSpec {
  partitionBy: Expr[];
  orderBy: OrderItem[];
  frame?: WindowFrame;
}
export interface WindowFrame {
  mode: 'ROWS' | 'RANGE';
  start: FrameBound;
  end: FrameBound;
}
export type FrameBound =
  | { kind: 'unbounded_preceding' }
  | { kind: 'preceding'; offset: number }
  | { kind: 'current_row' }
  | { kind: 'following'; offset: number }
  | { kind: 'unbounded_following' };

export interface FunctionExpr extends Node {
  type: 'function';
  name: string; // upper-cased
  args: Expr[];
  distinct: boolean;
  /** COUNT(*) */
  star: boolean;
  /** ORDER BY inside an aggregate call: string_agg(x, ',' ORDER BY y) */
  orderBy?: OrderItem[];
  filter?: Expr;
  over?: WindowSpec;
}
export interface CaseExpr extends Node {
  type: 'case';
  operand?: Expr;
  whens: { when: Expr; then: Expr }[];
  else?: Expr;
}
export interface CastExpr extends Node {
  type: 'cast';
  expr: Expr;
  to: DataType;
}

export type Expr =
  | LiteralExpr
  | ColumnExpr
  | StarExpr
  | ParamExpr
  | UnaryExpr
  | BinaryExpr
  | IsExpr
  | IsNullExpr
  | LikeExpr
  | BetweenExpr
  | InListExpr
  | InSelectExpr
  | ExistsExpr
  | SubqueryExpr
  | FunctionExpr
  | CaseExpr
  | CastExpr;

// ---------------------------------------------------------------- select

export interface OrderItem {
  expr: Expr;
  desc: boolean;
  nulls?: 'FIRST' | 'LAST';
}

export interface ResultColumn {
  expr: Expr; // may be a StarExpr
  alias?: string;
  /** Source text of the expression, used to name unaliased columns. */
  text: string;
}

export interface TableRef extends Node {
  type: 'table';
  name: string;
  alias?: string;
}
export interface SubqueryRef extends Node {
  type: 'subquery';
  select: SelectStmt;
  alias?: string;
}
export interface JoinRef extends Node {
  type: 'join';
  kind: 'INNER' | 'LEFT' | 'CROSS' | 'RIGHT' | 'FULL';
  natural: boolean;
  left: FromItem;
  right: FromItem;
  on?: Expr;
  using?: string[];
}
export interface FunctionRef extends Node {
  /** Table-valued function, e.g. generate_series(1, 100). */
  type: 'function_table';
  name: string;
  args: Expr[];
  alias?: string;
}
export type FromItem = TableRef | SubqueryRef | JoinRef | FunctionRef;

export interface SelectCore extends Node {
  type: 'core';
  distinct: boolean;
  columns: ResultColumn[];
  from?: FromItem;
  where?: Expr;
  groupBy?: Expr[];
  having?: Expr;
  windows?: Map<string, WindowSpec>;
}
export interface ValuesBody extends Node {
  type: 'values';
  rows: Expr[][];
}
export interface CompoundBody extends Node {
  type: 'compound';
  op: 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT';
  left: SelectBody;
  right: SelectBody;
}
export type SelectBody = SelectCore | ValuesBody | CompoundBody;

export interface CommonTableExpr {
  name: string;
  columns?: string[];
  select: SelectStmt;
  pos: number;
}
export interface WithClause {
  recursive: boolean;
  ctes: CommonTableExpr[];
}

export interface SelectStmt extends Node {
  type: 'select';
  with?: WithClause;
  body: SelectBody;
  orderBy?: OrderItem[];
  limit?: Expr;
  offset?: Expr;
}

// ---------------------------------------------------------------- DML

export interface InsertStmt extends Node {
  type: 'insert';
  with?: WithClause;
  table: string;
  columns?: string[];
  /** VALUES rows are represented as a SelectStmt whose body is a ValuesBody. */
  source: SelectStmt | 'DEFAULT';
  conflict?: 'REPLACE' | 'IGNORE';
  upsert?: { target?: string[]; action: 'NOTHING' | { set: SetClause[]; where?: Expr } };
  returning?: ResultColumn[];
}
export interface SetClause {
  column: string;
  value: Expr;
  pos: number;
}
export interface UpdateStmt extends Node {
  type: 'update';
  with?: WithClause;
  table: string;
  alias?: string;
  set: SetClause[];
  from?: FromItem;
  where?: Expr;
  returning?: ResultColumn[];
}
export interface DeleteStmt extends Node {
  type: 'delete';
  with?: WithClause;
  table: string;
  alias?: string;
  where?: Expr;
  returning?: ResultColumn[];
}

// ---------------------------------------------------------------- DDL

export interface ColumnDef {
  name: string;
  typeName: string;
  dataType: DataType;
  notNull: boolean;
  primaryKey: boolean;
  primaryKeyDesc: boolean;
  autoincrement: boolean;
  unique: boolean;
  default?: Expr;
  check?: Expr;
  references?: { table: string; column?: string };
  pos: number;
}
export type TableConstraint =
  | { type: 'primary_key'; columns: string[]; pos: number }
  | { type: 'unique'; columns: string[]; pos: number }
  | { type: 'check'; expr: Expr; pos: number }
  | { type: 'foreign_key'; columns: string[]; table: string; refColumns?: string[]; pos: number };

export interface CreateTableStmt extends Node {
  type: 'create_table';
  name: string;
  ifNotExists: boolean;
  columns: ColumnDef[];
  constraints: TableConstraint[];
  as?: SelectStmt;
}
export interface CreateIndexStmt extends Node {
  type: 'create_index';
  name: string;
  table: string;
  unique: boolean;
  ifNotExists: boolean;
  columns: { name: string; desc: boolean; pos: number }[];
}
export interface CreateViewStmt extends Node {
  type: 'create_view';
  name: string;
  ifNotExists: boolean;
  columns?: string[];
  select: SelectStmt;
  /** Source text of the SELECT, stored in the catalog. */
  selectText: string;
}
export interface DropStmt extends Node {
  type: 'drop';
  kind: 'TABLE' | 'INDEX' | 'VIEW';
  name: string;
  ifExists: boolean;
}
export interface AlterTableStmt extends Node {
  type: 'alter_table';
  table: string;
  action:
    | { kind: 'add_column'; column: ColumnDef }
    | { kind: 'rename_table'; to: string }
    | { kind: 'rename_column'; from: string; to: string };
}

// ---------------------------------------------------------------- misc

export interface TransactionStmt extends Node {
  type: 'begin' | 'commit' | 'rollback';
}
export interface ExplainStmt extends Node {
  type: 'explain';
  analyze: boolean;
  stmt: Statement;
}
export interface UtilityStmt extends Node {
  type: 'checkpoint' | 'vacuum' | 'analyze';
  target?: string;
}

export type Statement =
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | CreateTableStmt
  | CreateIndexStmt
  | CreateViewStmt
  | DropStmt
  | AlterTableStmt
  | TransactionStmt
  | ExplainStmt
  | UtilityStmt;

/** A parsed statement together with the slice of source text it came from. */
export interface ParsedStatement {
  stmt: Statement;
  text: string;
  start: number;
  end: number;
  paramCount: number;
  /** Names of named parameters (:name, @name, $name) by position. */
  paramNames: (string | undefined)[];
}
