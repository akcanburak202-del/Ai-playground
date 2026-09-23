import { useEffect, useMemo, useRef, useState } from 'react';
import type { TreeDump } from '@opusdb/engine';

/**
 * Draws a B+tree dump: leaves in key order along the bottom, every interior
 * node centred over its children, one edge per child pointer. Layout changes
 * (splits, merges, root growth) are tweened so pages visibly move.
 */

type DumpNode = TreeDump['nodes'][number];

interface Box {
  id: number;
  x: number;
  y: number;
  w: number;
}

const CELL = 34;
const LEVEL_H = 84;
const GAP = 16;
const TOP = 26;

function nodeWidth(n: DumpNode, compact: boolean): number {
  if (compact) return 132;
  return Math.max(1, n.keys.length) * CELL + 3;
}

function layout(dump: TreeDump, compact: boolean): { boxes: Map<number, Box>; width: number; height: number } {
  const byId = new Map(dump.nodes.map((n) => [n.id, n]));
  const boxes = new Map<number, Box>();
  let cursor = 0;
  let maxDepth = 0;
  const place = (id: number): Box | null => {
    const n = byId.get(id);
    if (!n) return null;
    maxDepth = Math.max(maxDepth, n.depth);
    const w = nodeWidth(n, compact);
    const y = TOP + n.depth * LEVEL_H;
    if (n.leaf) {
      const b = { id, x: cursor, y, w };
      cursor += w + GAP;
      boxes.set(id, b);
      return b;
    }
    const kids = n.children.map(place).filter((b): b is Box => b !== null);
    let x: number;
    if (kids.length === 0) {
      x = cursor;
      cursor += w + GAP;
    } else {
      const first = kids[0];
      const last = kids[kids.length - 1];
      x = (first.x + last.x + last.w) / 2 - w / 2;
    }
    const b = { id, x, y, w };
    boxes.set(id, b);
    return b;
  };
  place(dump.root);
  // shift so nothing starts left of 0
  let minX = Infinity;
  let maxX = 0;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x + b.w);
  }
  const shift = minX < 8 ? 8 - minX : 0;
  for (const b of boxes.values()) b.x += shift;
  return { boxes, width: maxX + shift + 8, height: TOP + maxDepth * LEVEL_H + 44 };
}

export interface TreeDiagramProps {
  dump: TreeDump;
  compact?: boolean;
  path?: Set<number>;
  flash?: Set<number>;
  hitKey?: string;
  newKey?: string;
  selected?: number;
  onSelect?: (id: number) => void;
}

export function TreeDiagram({ dump, compact = false, path, flash, hitKey, newKey, selected, onSelect }: TreeDiagramProps) {
  const target = useMemo(() => layout(dump, compact), [dump, compact]);
  const prev = useRef<Map<number, Box>>(new Map());
  const [t, setT] = useState(1);
  const from = useRef<Map<number, Box>>(new Map());

  useEffect(() => {
    from.current = prev.current;
    prev.current = target.boxes;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from.current.size === 0) {
      setT(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 460);
      setT(p);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    setT(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const ease = 1 - Math.pow(1 - t, 3);
  const pos = (id: number): Box => {
    const to = target.boxes.get(id)!;
    const f = from.current.get(id);
    if (!f || t >= 1) return to;
    return { id, x: f.x + (to.x - f.x) * ease, y: f.y + (to.y - f.y) * ease, w: f.w + (to.w - f.w) * ease };
  };

  const byId = new Map(dump.nodes.map((n) => [n.id, n]));
  const edges: { key: string; x1: number; y1: number; x2: number; y2: number; hot: boolean }[] = [];
  for (const n of dump.nodes) {
    if (n.leaf || !target.boxes.has(n.id)) continue;
    const p = pos(n.id);
    n.children.forEach((c, i) => {
      if (!target.boxes.has(c)) return;
      const q = pos(c);
      const slot = compact ? p.x + ((i + 0.5) / n.children.length) * p.w : p.x + 1.5 + i * CELL;
      edges.push({
        key: `${n.id}-${c}`,
        x1: Math.min(p.x + p.w - 1, Math.max(p.x + 1, slot)),
        y1: p.y + 30,
        x2: q.x + q.w / 2,
        y2: q.y,
        hot: !!(path?.has(n.id) && path.has(c)),
      });
    });
  }
  const missing = dump.truncated;

  return (
    <div className="tree-canvas" style={{ width: target.width, height: target.height }}>
      <svg width={target.width} height={target.height} aria-hidden="true">
        {edges.map((e) => (
          <path
            key={e.key}
            d={`M${e.x1},${e.y1} C${e.x1},${(e.y1 + e.y2) / 2} ${e.x2},${(e.y1 + e.y2) / 2} ${e.x2},${e.y2}`}
            fill="none"
            stroke={e.hot ? 'var(--accent)' : 'var(--rule-strong)'}
            strokeWidth={e.hot ? 2.2 : 1.4}
          />
        ))}
      </svg>
      {dump.nodes.map((n) => {
        if (!target.boxes.has(n.id)) return null;
        const b = pos(n.id);
        const cls = ['bnode', n.leaf ? 'leaf' : 'interior', path?.has(n.id) ? 'path' : '', flash?.has(n.id) ? 'flash' : '', selected === n.id ? 'selected' : ''].join(' ');
        return (
          <div
            key={n.id}
            className={cls}
            style={{ left: b.x, top: b.y, width: b.w }}
            onClick={() => onSelect?.(n.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect?.(n.id);
            }}
            aria-label={`${n.leaf ? 'Leaf' : 'Interior'} page ${n.id} with ${n.keys.length} keys`}
          >
            <span className="pid">
              p{n.id}
              {compact ? ` · ${n.keys.length}` : ''}
            </span>
            {compact ? (
              <span className="k" style={{ flex: 1 }}>
                {n.keys.length ? `${n.keys[0]} … ${n.keys[n.keys.length - 1]}` : 'empty'}
              </span>
            ) : n.keys.length ? (
              n.keys.map((k, i) => (
                <span key={i} className={`k${n.leaf && k === hitKey && path?.has(n.id) ? ' hit' : ''}${n.leaf && k === newKey ? ' new' : ''}`}>
                  {k}
                </span>
              ))
            ) : (
              <span className="k muted">∅</span>
            )}
          </div>
        );
      })}
      {missing && (
        <div className="muted" style={{ position: 'absolute', right: 8, bottom: 4, fontSize: 12 }}>
          showing the first {byId.size} pages
        </div>
      )}
    </div>
  );
}
