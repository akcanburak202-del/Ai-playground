import { ErrorCode, OpusError, parse } from '@opusdb/engine';
import type { Database, Params, QueryResult, Session, Value } from '@opusdb/engine';

type ParsedStatement = ReturnType<typeof parse>[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ErrorPayload {
  message: string;
  code: string;
  position?: number;
}

export function errorPayload(e: unknown): ErrorPayload {
  if (e instanceof OpusError) return { message: e.message, code: e.code, position: e.position };
  return { message: (e as Error)?.message ?? String(e), code: ErrorCode.internal };
}

/**
 * Runs a script statement by statement on a session. The engine is
 * synchronous and serialises transactions with a database lock; when another
 * session holds the lock we wait (asynchronously) instead of failing, so
 * concurrent clients queue up the way they would on a real server.
 */
export async function runScript(
  db: Database,
  session: Session,
  sql: string,
  params: Params | undefined,
  opts: { lockTimeoutMs?: number; onResult?: (r: QueryResult) => void } = {},
): Promise<QueryResult[]> {
  const stmts = parse(sql);
  const results: QueryResult[] = [];
  const timeout = opts.lockTimeoutMs ?? 5000;
  for (const p of stmts) {
    let values: Value[] = [];
    if (Array.isArray(params)) values = params;
    else if (params) {
      values = [];
      for (let i = 0; i < p.paramCount; i++) {
        const name = p.paramNames[i];
        values.push(name !== undefined && name in params ? params[name] : null);
      }
    }
    const r = await runStatement(db, session, p, values, timeout);
    results.push(r);
    opts.onResult?.(r);
  }
  return results;
}

/** Runs one parsed statement, waiting (up to `timeoutMs`) while another session holds the database lock. */
export async function runStatement(db: Database, session: Session, p: ParsedStatement, values: Value[], timeoutMs = 5000): Promise<QueryResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return session.run(p, values);
    } catch (e) {
      if (e instanceof OpusError && e.position !== undefined && e.position < p.start) e.position += p.start;
      const waiting = e instanceof OpusError && e.code === ErrorCode.lockNotAvailable && db.lockOwner && db.lockOwner !== session;
      if (waiting && Date.now() < deadline) {
        await sleep(5);
        continue;
      }
      throw e;
    }
  }
}
