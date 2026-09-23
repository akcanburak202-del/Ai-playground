import type { PlanNode } from '@opusdb/engine';
import { fmtInt, fmtMs } from '../lib/format';

function totalTime(n: PlanNode): number {
  return n.actual?.timeMs ?? 0;
}

function sumSelf(n: PlanNode): number {
  return (n.actual?.selfMs ?? 0) + n.children.reduce((s, c) => s + sumSelf(c), 0);
}

/** Flags row estimates that were off by 10x or more (the planner's blind spots). */
function misestimate(n: PlanNode): number | null {
  if (!n.actual || n.actual.loops === 0) return null;
  const actual = n.actual.rows / n.actual.loops;
  const est = Math.max(1, n.estRows);
  const ratio = Math.max(actual, 1) / est;
  return ratio >= 10 || ratio <= 0.1 ? ratio : null;
}

function Node({ n, total }: { n: PlanNode; total: number }) {
  const share = total > 0 && n.actual ? n.actual.selfMs / total : 0;
  const off = misestimate(n);
  return (
    <li>
      <div className={`plan-node${share > 0.4 ? ' hot' : ''}`}>
        <div className="op">
          <b>{n.name}</b>
          {n.details[0] && !n.details[0].includes(':') && <span className="muted mono" style={{ fontSize: 12 }}>{n.details[0]}</span>}
        </div>
        {n.details.filter((d, i) => !(i === 0 && !d.includes(':'))).map((d, i) => (
          <div className="detail" key={i}>
            {d}
          </div>
        ))}
        <div className="meta">
          <span title="Planner estimate">est. {fmtInt(n.estRows)} rows</span>
          {n.actual && (
            <>
              <span title="Rows actually produced">
                <b style={{ color: 'var(--ink)' }}>{fmtInt(n.actual.rows)}</b> rows
              </span>
              {n.actual.loops > 1 && <span>{fmtInt(n.actual.loops)} loops</span>}
              <span title="Time spent in this operator excluding its inputs">self {fmtMs(n.actual.selfMs)}</span>
            </>
          )}
          {off && <span className="pill warn">estimate off {off >= 10 ? `${Math.round(off)}×` : `1/${Math.round(1 / off)}`}</span>}
        </div>
        {n.actual && (
          <div className="timebar" title={`${Math.round(share * 100)}% of query time`}>
            <i style={{ width: `${Math.max(1, share * 100)}%` }} />
          </div>
        )}
      </div>
      {n.children.length > 0 && (
        <ul>
          {n.children.map((c, i) => (
            <Node key={i} n={c} total={total} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PlanView({ plan, note }: { plan: PlanNode | undefined; note?: string }) {
  if (!plan) return <div className="empty">{note ?? 'Run a SELECT, INSERT, UPDATE or DELETE to see its plan.'}</div>;
  const total = sumSelf(plan) || totalTime(plan);
  const ops = new Set<string>();
  const walk = (n: PlanNode) => {
    ops.add(n.name.replace(/ on \w+$/, ''));
    n.children.forEach(walk);
  };
  walk(plan);
  return (
    <div className="plan">
      <div className="plan-summary">
        {plan.actual && (
          <span>
            <span className="label">executed in</span> <b className="num">{fmtMs(totalTime(plan))}</b>
          </span>
        )}
        <span>
          <span className="label">operators</span> {[...ops].join(' · ')}
        </span>
        {!plan.actual && <span className="pill">estimates only</span>}
      </div>
      <ul className="plan-tree">
        <Node n={plan} total={total} />
      </ul>
    </div>
  );
}
