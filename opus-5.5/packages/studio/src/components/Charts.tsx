import { useState } from 'react';
import type { ReactNode } from 'react';

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const node = tip ? (
    <div className="tooltip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: tip.y + 14 }}>
      {tip.content}
    </div>
  ) : null;
  return { setTip, node };
}

export interface RatioRow {
  label: string;
  ratio: number; // OpusDB time / SQLite time
  detail: { name: string; value: string }[];
}

/**
 * Diverging bars on a log2 scale around 1×: left of the line OpusDB was
 * faster, right of it SQLite was faster.
 */
export function RatioChart({ rows }: { rows: RatioRow[] }) {
  const { setTip, node } = useTip();
  const lo = Math.min(0.25, ...rows.map((r) => r.ratio));
  const hi = Math.max(16, Math.pow(2, Math.ceil(Math.log2(Math.max(...rows.map((r) => r.ratio)) * 1.7))));
  const l0 = Math.log2(lo);
  const l1 = Math.log2(hi);
  const pos = (r: number) => ((Math.log2(r) - l0) / (l1 - l0)) * 100;
  const ticks: number[] = [];
  for (let t = Math.pow(2, Math.ceil(l0)); t <= hi; t *= 2) ticks.push(t);
  const one = pos(1);
  const fmt = (r: number) => (r >= 10 ? `${r.toFixed(0)}×` : `${r.toFixed(2).replace(/0$/, '')}×`);
  return (
    <div>
      <div className="legend" style={{ marginBottom: 12 }}>
        <span>
          <i style={{ background: 'var(--series-1)' }} /> OpusDB faster
        </span>
        <span>
          <i style={{ background: 'var(--series-2)' }} /> SQLite faster
        </span>
        <span className="muted">bar length = time ratio on a log scale</span>
      </div>
      <div className="ratio-chart" role="img" aria-label="OpusDB time divided by SQLite time per workload">
        <div className="ratio-row ratio-axis">
          <span />
          <span className="ratio-track">
            {ticks.map((t) => (
              <span key={t} className="ratio-tick" style={{ left: `${pos(t)}%` }}>
                {t < 1 ? `${t}×` : `${t}×`}
              </span>
            ))}
          </span>
          <span />
        </div>
        {rows.map((r) => {
          const p = pos(r.ratio);
          const faster = r.ratio < 1;
          const left = Math.min(p, one);
          const width = Math.max(0.6, Math.abs(p - one));
          return (
            <div
              className="ratio-row"
              key={r.label}
              onMouseMove={(e) =>
                setTip({
                  x: e.clientX,
                  y: e.clientY,
                  content: (
                    <>
                      <div className="t-title">{r.label}</div>
                      {r.detail.map((d) => (
                        <div className="t-row" key={d.name}>
                          <span>{d.name}</span>
                          <span>{d.value}</span>
                        </div>
                      ))}
                    </>
                  ),
                })
              }
              onMouseLeave={() => setTip(null)}
            >
              <span className="ratio-label">{r.label}</span>
              <span className="ratio-track">
                {ticks.map((t) => (
                  <i key={t} className={t === 1 ? 'ratio-one' : 'ratio-grid'} style={{ left: `${pos(t)}%` }} />
                ))}
                <b
                  className="ratio-bar"
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: faster ? 'var(--series-1)' : 'var(--series-2)',
                    borderRadius: faster ? '4px 0 0 4px' : '0 4px 4px 0',
                  }}
                />
                <span className="ratio-value" style={faster ? { right: `${100 - left + 1}%` } : { left: `${left + width + 1}%` }}>
                  {fmt(r.ratio)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      {node}
    </div>
  );
}

export interface BarRow {
  label: string;
  value: number;
  text: string;
  sub?: string;
}

/** Single-series horizontal bars with the value at the tip. */
export function BarChart({ rows, color = 'var(--series-1)' }: { rows: BarRow[]; color?: string }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div className="bar-list">
      {rows.map((r) => (
        <div className="bar-row wide" key={r.label}>
          <span className="name" title={r.label} style={{ fontFamily: 'var(--font-ui)' }}>
            {r.label}
          </span>
          <span className="track">
            <i style={{ width: `${Math.max(0.5, (r.value / max) * 100)}%`, background: color }} />
          </span>
          <span className="v" title={r.sub}>
            {r.text}
          </span>
        </div>
      ))}
    </div>
  );
}
