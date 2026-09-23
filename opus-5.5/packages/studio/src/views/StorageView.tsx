import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PageInfo, SchemaInfo, TreeDump } from '@opusdb/engine';
import type { PageDetail, StorageInfo, StudioClient } from '../lib/client';
import { fmtBytes, fmtInt } from '../lib/format';
import { HexDump } from '../components/HexDump';
import { TreeDiagram } from '../components/TreeDiagram';

const KIND_LABEL: Record<string, string> = {
  header: 'Header page',
  catalog: 'Schema catalog',
  'table-leaf': 'Table leaf',
  'table-interior': 'Table interior',
  'index-leaf': 'Index leaf',
  'index-interior': 'Index interior',
  overflow: 'Overflow',
  free: 'Free',
  unused: 'Unused',
};

function kindColor(kind: string): string {
  if (kind.startsWith('table')) return 'var(--series-1)';
  if (kind.startsWith('index')) return 'var(--series-2)';
  if (kind === 'overflow') return 'var(--series-3)';
  if (kind === 'catalog') return 'var(--series-neutral)';
  if (kind === 'header') return 'var(--ink)';
  return 'transparent';
}

export function StorageView({ client, schema, focusTree }: { client: StudioClient; schema: SchemaInfo | null; focusTree?: string }) {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [selected, setSelected] = useState<number>(0);
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; p: PageInfo } | null>(null);
  const [integrity, setIntegrity] = useState<string[] | null>(null);
  const [treeName, setTreeName] = useState<string>(focusTree ?? 'orders');
  const [tree, setTree] = useState<TreeDump | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [p, s] = await Promise.all([client.pages(), client.storage()]);
    setPages(p);
    setInfo(s);
  }, [client]);

  useEffect(() => {
    void refresh();
    return client.subscribe((e) => {
      if (e.type === 'commit' || e.type === 'checkpoint' || e.type === 'rollback' || e.type === 'schema') void refresh();
    });
  }, [client, refresh]);

  useEffect(() => {
    if (focusTree) setTreeName(focusTree);
  }, [focusTree]);

  useEffect(() => {
    void client.tree(treeName, 160).then(setTree);
  }, [client, treeName, pages]);

  useEffect(() => {
    void client.page(selected).then(setDetail);
  }, [client, selected, pages]);

  const byOwner = useMemo(() => {
    const m = new Map<string, { name: string; kind: 'table' | 'index' | 'other'; pages: number; leaves: number; interior: number; overflow: number }>();
    for (const p of pages) {
      if (!p.owner) continue;
      let e = m.get(p.owner);
      if (!e) {
        e = { name: p.owner, kind: p.kind.startsWith('index') ? 'index' : p.kind === 'catalog' ? 'other' : 'table', pages: 0, leaves: 0, interior: 0, overflow: 0 };
        m.set(p.owner, e);
      }
      e.pages++;
      if (p.kind.endsWith('leaf')) e.leaves++;
      else if (p.kind.endsWith('interior')) e.interior++;
      else if (p.kind === 'overflow') e.overflow++;
      if (p.kind.startsWith('index')) e.kind = 'index';
    }
    return [...m.values()].sort((a, b) => b.pages - a.pages);
  }, [pages]);

  const avgFill = useMemo(() => {
    const leaves = pages.filter((p) => p.kind.endsWith('leaf') && p.fill !== undefined);
    return leaves.length ? leaves.reduce((s, p) => s + (p.fill ?? 0), 0) / leaves.length : 0;
  }, [pages]);

  const hitRatio = info ? info.stats.cacheHits / Math.max(1, info.stats.cacheHits + info.stats.cacheMisses) : 0;
  const maxPages = byOwner[0]?.pages ?? 1;
  const trees = [...(schema?.tables ?? []).flatMap((t) => [t.name, ...t.indexes.map((i) => i.name)])];

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Storage</h1>
          <p>
            Every square is one {info ? fmtBytes(info.pageSize) : '4 KiB'} page of the database file, colored by what lives in it; the colored height is how full the page is. A notch in the corner means
            the newest copy of that page is still in the write-ahead log.
          </p>
        </div>
      </div>

      {info && (
        <div className="stat-row">
          <div className="stat">
            <span className="label">database size</span>
            <span className="value">{fmtBytes(info.fileBytes)}</span>
            <span className="sub">
              {fmtInt(info.pageCount)} pages · {fmtInt(info.freePages)} free
            </span>
          </div>
          <div className="stat">
            <span className="label">write-ahead log</span>
            <span className="value">{fmtInt(info.wal.frames)} frames</span>
            <span className="sub">
              {fmtBytes(info.wal.bytes)} · {fmtInt(info.wal.commitsSinceCheckpoint)} commits since checkpoint
            </span>
          </div>
          <div className="stat">
            <span className="label">page cache</span>
            <span className="value">{(hitRatio * 100).toFixed(1)}% hits</span>
            <span className="sub">
              {fmtInt(info.cache.cached)} pages cached · {fmtInt(info.stats.pagesRead)} read
            </span>
          </div>
          <div className="stat">
            <span className="label">leaf fill factor</span>
            <span className="value">{Math.round(avgFill * 100)}%</span>
            <span className="sub">{fmtInt(info.stats.commits)} commits · {fmtInt(info.stats.checkpoints)} checkpoints</span>
          </div>
        </div>
      )}

      <div className="storage-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <section className="panel">
          <div className="panel-head" style={{ flexWrap: 'wrap' }}>
            <h2>Page map</h2>
            <div className="legend" style={{ marginLeft: 'auto' }}>
              <span>
                <i style={{ background: 'var(--series-1)' }} /> table
              </span>
              <span>
                <i style={{ background: 'var(--series-2)' }} /> index
              </span>
              <span>
                <i style={{ background: 'var(--series-3)' }} /> overflow
              </span>
              <span>
                <i style={{ background: 'var(--series-neutral)' }} /> catalog
              </span>
              <span>
                <i style={{ boxShadow: 'inset 0 0 0 1px var(--rule-strong)' }} /> free
              </span>
              <span>
                <i style={{ background: 'var(--series-1)', boxShadow: 'inset 0 0 0 3px var(--series-1), inset 0 0 0 11px var(--surface)' }} /> interior
              </span>
            </div>
          </div>
          <div className="pagemap" onMouseLeave={() => setHover(null)}>
            {pages.map((p) => (
              <button
                key={p.id}
                className={`pagecell ${p.kind === 'free' ? 'free' : ''} ${p.kind.endsWith('interior') ? 'interior' : ''} ${p.inWal ? 'wal' : ''} ${selected === p.id ? 'sel' : ''}`}
                style={{ background: p.kind === 'free' || p.kind === 'unused' ? undefined : 'var(--surface-3)' }}
                aria-label={`Page ${p.id}: ${KIND_LABEL[p.kind]}${p.owner ? ` of ${p.owner}` : ''}`}
                onClick={() => setSelected(p.id)}
                onMouseMove={(e) => setHover({ x: e.clientX, y: e.clientY, p })}
              >
                {p.kind !== 'free' && p.kind !== 'unused' && <i style={{ height: `${Math.max(18, Math.round((p.fill ?? 1) * 100))}%`, background: kindColor(p.kind) }} />}
              </button>
            ))}
          </div>
          <div className="toolbar" style={{ borderBottom: 0 }}>
            <button
              className="btn"
              disabled={busy || !info?.wal.frames}
              onClick={async () => {
                setBusy(true);
                await client.checkpoint();
                await refresh();
                setBusy(false);
              }}
            >
              Checkpoint WAL
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setIntegrity(await client.integrity());
                setBusy(false);
              }}
            >
              Run integrity check
            </button>
            {integrity && (
              <span className={`pill ${integrity.length ? 'bad' : 'good'}`}>
                {integrity.length ? `${integrity.length} problems: ${integrity[0]}` : `OK · all ${fmtInt(pages.length)} pages accounted for`}
              </span>
            )}
          </div>
        </section>
          <section className="panel">
            <div className="panel-head">
              <h2>Pages per object</h2>
            </div>
            <div className="panel-body bar-list">
              {byOwner.map((o) => (
                <div className="bar-row" key={o.name} title={`${o.leaves} leaf, ${o.interior} interior, ${o.overflow} overflow pages`}>
                  <span className="name">{o.name}</span>
                  <span className="track">
                    <i style={{ width: `${(o.pages / maxPages) * 100}%`, background: o.kind === 'index' ? 'var(--series-2)' : o.kind === 'table' ? 'var(--series-1)' : 'var(--series-neutral)' }} />
                  </span>
                  <span className="v">{fmtInt(o.pages)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="panel">
            <div className="panel-head">
              <h2>Page {selected}</h2>
              {pages[selected] && <span className="pill">{KIND_LABEL[pages[selected].kind]}</span>}
              {pages[selected]?.inWal && <span className="pill accent">in WAL</span>}
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {detail ? (
                <>
                  <dl className="kv">
                    {pages[selected]?.owner && (
                      <>
                        <dt>belongs to</dt>
                        <dd>{pages[selected].owner}</dd>
                      </>
                    )}
                    {Object.entries(detail.summary).map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt>{k}</dt>
                        <dd>{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                  <HexDump bytes={detail.bytes} header={selected === 0 ? 16 : 3} limit={160} />
                </>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Page bytes are available for the in-browser database.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head" style={{ flexWrap: 'wrap' }}>
          <h2>B+tree of</h2>
          <select className="input mono" value={treeName} onChange={(e) => setTreeName(e.target.value)} id="storage-tree" aria-label="Table or index">
            {trees.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {tree && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {tree.kind} · root page {tree.root} · {tree.depth} levels · each box is one page with its first and last key
            </span>
          )}
        </div>
        <div className="tree-stage" style={{ minHeight: 220 }}>
          {tree && <TreeDiagram dump={tree} compact onSelect={setSelected} selected={selected} />}
        </div>
      </section>

      {hover && (
        <div className="tooltip" style={{ left: Math.min(hover.x + 14, window.innerWidth - 240), top: hover.y + 14 }}>
          <div className="t-title">
            Page {hover.p.id} · {KIND_LABEL[hover.p.kind]}
          </div>
          {hover.p.owner && (
            <div className="t-row">
              <span>object</span>
              <span className="mono">{hover.p.owner}</span>
            </div>
          )}
          {hover.p.fill !== undefined && (
            <div className="t-row">
              <span>fill</span>
              <span>{Math.round(hover.p.fill * 100)}%</span>
            </div>
          )}
          <div className="t-row">
            <span>newest copy</span>
            <span>{hover.p.inWal ? 'write-ahead log' : 'database file'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
