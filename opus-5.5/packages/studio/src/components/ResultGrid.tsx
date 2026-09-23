import { useMemo, useRef, useState } from 'react';
import type { ColumnMeta, Value } from '@opusdb/engine';
import { fmtValue } from '../lib/format';

const ROW_H = 28;
const OVERSCAN = 12;

function cellClass(type: string, v: Value): string | undefined {
  if (v === null) return undefined;
  if (typeof v === 'number') return 'n';
  if (type === 'TEXT' && typeof v === 'string' && v.length < 40 && /^[\d\-: ]+$/.test(v)) return 't';
  return undefined;
}

/** Virtualised result table: renders only the visible rows so 100k-row results stay smooth. */
export function ResultGrid({ columns, rows }: { columns: ColumnMeta[]; rows: Value[][] }) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });

  const widths = useMemo(() => {
    return columns.map((c, i) => {
      let w = c.name.length * 8 + (c.type === 'ANY' ? 52 : 62) + 18;
      const sample = Math.min(rows.length, 300);
      for (let r = 0; r < sample; r++) {
        const v = rows[r][i];
        const len = v === null ? 4 : fmtValue(v).length;
        w = Math.max(w, len * 7.7 + 24);
      }
      return Math.min(420, Math.max(72, Math.round(w)));
    });
  }, [columns, rows]);

  // a single multi-line text value (e.g. ASCII art) reads better as a block
  const single = rows.length === 1 && columns.length === 1 && typeof rows[0][0] === 'string' && rows[0][0].includes('\n');
  if (single) {
    return (
      <div className="textblock">
        <div className="label" style={{ marginBottom: 10 }}>
          {columns[0].name}
        </div>
        <pre>{rows[0][0] as string}</pre>
      </div>
    );
  }
  if (!columns.length) return <div className="empty">The statement ran and returned no rows.</div>;

  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.height) / ROW_H) + OVERSCAN);
  const numW = Math.max(44, String(rows.length).length * 8 + 22);
  const total = numW + widths.reduce((a, b) => a + b, 0);

  return (
    <div
      className="grid"
      ref={box}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      tabIndex={0}
      aria-label="Query results"
    >
      <table style={{ width: total }}>
        <colgroup>
          <col style={{ width: numW }} />
          {widths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="rownum">#</th>
            {columns.map((c, i) => (
              <th key={i} title={`${c.name} (${c.type})`}>
                {c.name}
                <span className="type-badge">{c.type === 'ANY' ? 'ANY' : c.type.slice(0, 4)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {first > 0 && (
            <tr style={{ height: first * ROW_H }}>
              <td colSpan={columns.length + 1} style={{ padding: 0, border: 0 }} />
            </tr>
          )}
          {rows.slice(first, last).map((row, k) => {
            const r = first + k;
            return (
              <tr key={r}>
                <td className="rownum">{r + 1}</td>
                {row.map((v, i) => (
                  <td key={i} className={cellClass(columns[i]?.type, v)} title={v !== null && typeof v === 'string' && v.length > 40 ? v : undefined}>
                    {v === null ? <span className="null">NULL</span> : typeof v === 'boolean' ? <span className="bool">{v ? 'true' : 'false'}</span> : fmtValue(v)}
                  </td>
                ))}
              </tr>
            );
          })}
          {last < rows.length && (
            <tr style={{ height: (rows.length - last) * ROW_H }}>
              <td colSpan={columns.length + 1} style={{ padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
