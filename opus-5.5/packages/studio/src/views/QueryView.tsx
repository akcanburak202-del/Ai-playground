import { useCallback, useEffect, useMemo, useState } from 'react';
import { lineCol, parse } from '@opusdb/engine';
import type { QueryResult, SchemaInfo } from '@opusdb/engine';
import type { QueryOutcome, StudioClient } from '../lib/client';
import { EXAMPLES } from '../lib/examples';
import { copyText, fmtInt, fmtMs, loadPref, savePref, toTsv } from '../lib/format';
import { Editor } from '../components/Editor';
import { ResultGrid } from '../components/ResultGrid';
import { PlanView } from '../components/PlanView';
import { IconChevron, IconCopy, IconKey, IconPlan, IconPlay } from '../components/Icons';

type Tab = 'results' | 'plan' | 'messages' | 'history';

interface HistoryItem {
  sql: string;
  at: number;
  ok: boolean;
  ms: number;
  summary: string;
}

function summarize(r: QueryResult): string {
  if (r.command === 'SELECT' || r.columns.length) return `${fmtInt(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}`;
  if (r.command === 'INSERT' || r.command === 'UPDATE' || r.command === 'DELETE') return `${fmtInt(r.rowsAffected)} row${r.rowsAffected === 1 ? '' : 's'} affected`;
  return 'done';
}

export interface QueryViewProps {
  client: StudioClient;
  schema: SchemaInfo | null;
  onToast: (msg: string) => void;
  onOpenTree: (name: string) => void;
  onTxnChange: () => void;
}

export function QueryView({ client, schema, onToast, onOpenTree, onTxnChange }: QueryViewProps) {
  const [sql, setSql] = useState<string>(() => loadPref('sql', EXAMPLES[0].sql));
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<(QueryOutcome & { sql: string }) | null>(null);
  const [tab, setTab] = useState<Tab>('results');
  const [shown, setShown] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadPref('history', []));

  useEffect(() => savePref('sql', sql), [sql]);

  const run = useCallback(
    async (text: string, opts: { explain?: boolean } = {}) => {
      if (!text.trim() || running) return;
      let toRun = text;
      if (opts.explain) {
        try {
          const stmts = parse(text);
          const target = stmts.find((s) => ['select', 'insert', 'update', 'delete'].includes(s.stmt.type));
          if (!target) {
            onToast('EXPLAIN needs a SELECT, INSERT, UPDATE or DELETE');
            return;
          }
          toRun = 'EXPLAIN ' + target.text;
        } catch {
          toRun = 'EXPLAIN ' + text;
        }
      }
      setRunning(true);
      const res = await client.query(toRun);
      setRunning(false);
      setOutcome({ ...res, sql: toRun });
      onTxnChange();
      // show the last statement that produced rows (or the last one)
      let idx = res.results.length - 1;
      for (let i = res.results.length - 1; i >= 0; i--) {
        if (res.results[i].columns.length) {
          idx = i;
          break;
        }
      }
      setShown(Math.max(0, idx));
      if (!res.ok) setTab(res.results.length ? 'messages' : 'results');
      else if (opts.explain) setTab('plan');
      else setTab((t) => (t === 'history' || t === 'messages' ? 'results' : t));
      const item: HistoryItem = {
        sql: text,
        at: Date.now(),
        ok: res.ok,
        ms: res.ms,
        summary: res.ok ? (res.results.length ? summarize(res.results[res.results.length - 1]) : 'empty') : res.error.message,
      };
      setHistory((h) => {
        const next = [item, ...h.filter((x) => x.sql !== text)].slice(0, 40);
        savePref('history', next);
        return next;
      });
    },
    [client, running, onToast, onTxnChange],
  );

  // open in a working state: run the current query once on first load
  useEffect(() => {
    void run(sql);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = outcome?.results[shown];
  const explainResult = current?.command === 'EXPLAIN' ? current : undefined;
  const plan = explainResult?.plan ?? current?.plan;
  const errorPos = outcome && !outcome.ok ? outcome.error.position : undefined;

  const errorLocation = useMemo(() => {
    if (!outcome || outcome.ok || outcome.error.position === undefined) return null;
    const { line, col } = lineCol(outcome.sql, outcome.error.position);
    const lineText = outcome.sql.split('\n')[line - 1] ?? '';
    return { line, col, lineText };
  }, [outcome]);

  const loadExample = (text: string) => {
    setSql(text);
    void run(text);
  };

  return (
    <div className="query-layout">
      <section className="query-main" aria-label="SQL workspace">
        <Editor value={sql} onChange={setSql} onRun={(t) => void run(t)} error={outcome && !outcome.ok && outcome.sql === sql ? outcome.error : errorPos !== undefined ? null : null} schema={schema} />
        <div className="toolbar">
          <button className="btn primary" onClick={() => void run(sql)} disabled={running} id="run-query">
            <IconPlay /> {running ? 'Running…' : 'Run'} <span className="kbd hide-narrow">Ctrl ↵</span>
          </button>
          <button className="btn" onClick={() => void run(sql, { explain: true })} disabled={running}>
            <IconPlan /> Explain
          </button>
          {outcome && outcome.results.length > 1 && (
            <select className="input" value={shown} onChange={(e) => setShown(Number(e.target.value))} aria-label="Statement result" id="result-select">
              {outcome.results.map((r, i) => (
                <option key={i} value={i}>
                  {i + 1}. {r.command} · {summarize(r)}
                </option>
              ))}
            </select>
          )}
          <div className="status">
            {client.inTransaction && <span className="pill warn">transaction open</span>}
            {outcome && outcome.ok && current && (
              <>
                <span className="num">{summarize(current)}</span>
                <span className="muted num">{fmtMs(outcome.ms)}</span>
              </>
            )}
            {outcome && !outcome.ok && <span className="pill bad">error {outcome.error.code}</span>}
            {current && current.columns.length > 0 && (
              <button
                className="btn ghost small"
                onClick={async () => onToast((await copyText(toTsv(current.columns, current.rows))) ? `Copied ${fmtInt(current.rows.length)} rows as TSV` : 'Clipboard is not available here')}
                title="Copy as tab-separated values"
              >
                <IconCopy /> Copy
              </button>
            )}
          </div>
        </div>
        <div className="results">
          <div className="tabs" role="tablist">
            {(
              [
                ['results', 'Results', current?.columns.length ? fmtInt(current.rows.length) : ''],
                ['plan', 'Plan', ''],
                ['messages', 'Messages', outcome ? String(outcome.results.length + (outcome.ok ? 0 : 1)) : ''],
                ['history', 'History', history.length ? String(history.length) : ''],
              ] as [Tab, string, string][]
            ).map(([id, label, count]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}
                {count && <span className="count">{count}</span>}
              </button>
            ))}
          </div>
          <div className="results-body">
            {tab === 'results' && (
              <>
                {outcome && !outcome.ok && !current && (
                  <div style={{ padding: 14 }}>
                    <ErrorBox error={outcome.error} location={errorLocation} />
                  </div>
                )}
                {current && (explainResult ? <PlanView plan={explainResult.plan} /> : <ResultGrid columns={current.columns} rows={current.rows} />)}
                {!outcome && <div className="empty">Press Run to execute the query.</div>}
              </>
            )}
            {tab === 'plan' && <PlanView plan={plan} />}
            {tab === 'messages' && (
              <div className="log">
                {outcome?.results.map((r, i) => (
                  <div className="log-item" key={i}>
                    <span className="pill good">{r.command}</span>
                    <code>{r.sql}</code>
                    <span className="muted num" style={{ fontSize: 12 }}>
                      {summarize(r)} · {fmtMs(r.timeMs)}
                    </span>
                  </div>
                ))}
                {outcome && !outcome.ok && (
                  <div style={{ padding: 14 }}>
                    <ErrorBox error={outcome.error} location={errorLocation} />
                  </div>
                )}
              </div>
            )}
            {tab === 'history' && (
              <div className="log">
                {history.length === 0 && <div className="empty">Queries you run appear here (kept in this browser).</div>}
                {history.map((h, i) => (
                  <div className="log-item" key={i}>
                    <span className={`pill ${h.ok ? 'good' : 'bad'}`}>{h.ok ? 'ok' : 'error'}</span>
                    <button className="link" onClick={() => setSql(h.sql)} title="Load into the editor">
                      <code>{h.sql}</code>
                    </button>
                    <span className="muted num" style={{ fontSize: 12, textAlign: 'right' }}>
                      {h.summary}
                      <br />
                      {new Date(h.at).toLocaleTimeString()} · {fmtMs(h.ms)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      <aside className="query-side">
        <SchemaPanel schema={schema} onQuery={(t) => loadExample(`SELECT * FROM ${t} LIMIT 100;`)} onOpenTree={onOpenTree} />
        <section className="panel">
          <div className="panel-head">
            <h2>Examples</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              demo shop · click to run
            </span>
          </div>
          <div style={{ padding: 6 }}>
            {EXAMPLES.map((ex) => (
              <button key={ex.id} className="example" onClick={() => loadExample(ex.sql)}>
                <b>{ex.title}</b>
                <span>{ex.blurb}</span>
              </button>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

function ErrorBox({ error, location }: { error: { message: string; code: string }; location: { line: number; col: number; lineText: string } | null }) {
  return (
    <div className="error-box" role="alert">
      <div style={{ minWidth: 0 }}>
        <strong>{error.message}</strong>
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          SQLSTATE {error.code}
          {location && ` · line ${location.line}, column ${location.col}`}
        </div>
        {location && (
          <code style={{ display: 'block', marginTop: 8, whiteSpace: 'pre', overflowX: 'auto' }}>
            {location.lineText}
            {'\n'}
            {' '.repeat(Math.max(0, location.col - 1))}^
          </code>
        )}
      </div>
    </div>
  );
}

function SchemaPanel({ schema, onQuery, onOpenTree }: { schema: SchemaInfo | null; onQuery: (t: string) => void; onOpenTree: (t: string) => void }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Schema</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {schema ? `${schema.tables.length} tables${schema.views.length ? ` · ${schema.views.length} views` : ''}` : 'loading…'}
        </span>
      </div>
      <ul className="tree-list">
        {schema?.tables.map((t) => (
          <li key={t.name}>
            <details>
              <summary>
                <IconChevron className="caret" />
                <span className="tname">{t.name}</span>
                <span className="muted num" style={{ marginLeft: 'auto', fontSize: 12 }}>
                  {fmtInt(t.rowCount)}
                </span>
              </summary>
              <ul className="cols">
                {t.columns.map((c) => (
                  <li key={c.name}>
                    {c.primaryKey ? <IconKey width={12} height={12} style={{ color: 'var(--warn)' }} aria-label="primary key" /> : <span style={{ width: 12 }} />}
                    <span className="cname">{c.name}</span>
                    <span className="type-badge">{c.type}</span>
                    {c.notNull && !c.primaryKey && <span className="muted" style={{ fontSize: 11 }}>not null</span>}
                  </li>
                ))}
                {t.indexes.map((ix) => (
                  <li key={ix.name} className="muted" style={{ fontSize: 12 }}>
                    <span style={{ width: 12 }} />
                    <span className="mono">{ix.auto ? 'unique' : ix.unique ? 'unique index' : 'index'} ({ix.columns.join(', ')})</span>
                  </li>
                ))}
              </ul>
              <div className="actions">
                <button className="btn small" onClick={() => onQuery(t.name)}>
                  Select rows
                </button>
                <button className="btn small ghost" onClick={() => onOpenTree(t.name)}>
                  View B+tree
                </button>
              </div>
            </details>
          </li>
        ))}
        {schema?.views.map((v) => (
          <li key={v.name} style={{ padding: '6px 8px 6px 26px' }}>
            <span className="tname">{v.name}</span> <span className="type-badge">VIEW</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
