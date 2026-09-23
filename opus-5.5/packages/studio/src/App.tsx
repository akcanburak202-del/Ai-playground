import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SchemaInfo } from '@opusdb/engine';
import { LocalClient, RemoteClient } from './lib/client';
import type { StudioClient } from './lib/client';
import { loadPref, savePref } from './lib/format';
import { QueryView } from './views/QueryView';
import { TreeLab } from './views/TreeLab';
import { StorageView } from './views/StorageView';
import { BenchView } from './views/BenchView';
import { AboutView } from './views/AboutView';
import { IconGauge, IconInfo, IconMoon, IconPages, IconQuery, IconSun, IconTree, Logo } from './components/Icons';

type View = 'query' | 'btree' | 'storage' | 'bench' | 'about';
const VIEWS: { id: View; label: string; icon: typeof IconQuery }[] = [
  { id: 'query', label: 'Query', icon: IconQuery },
  { id: 'btree', label: 'B+tree', icon: IconTree },
  { id: 'storage', label: 'Storage', icon: IconPages },
  { id: 'bench', label: 'Bench', icon: IconGauge },
  { id: 'about', label: 'About', icon: IconInfo },
];

function initialView(): View {
  const h = location.hash.replace('#', '');
  if (VIEWS.some((v) => v.id === h)) return h as View;
  return 'query';
}

export function App() {
  const local = useMemo(() => new LocalClient(), []);
  const [remote, setRemote] = useState<RemoteClient | null>(null);
  const [useRemote, setUseRemote] = useState(false);
  const client: StudioClient = useRemote && remote ? remote : local;
  const [view, setView] = useState<View>(initialView);
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [focusTree, setFocusTree] = useState<string | undefined>();
  const [, setTick] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(() => loadPref('theme', null));

  useEffect(() => {
    void RemoteClient.detect().then(setRemote);
  }, []);

  const refreshSchema = useCallback(() => {
    void client.schema().then(setSchema);
  }, [client]);

  useEffect(() => {
    refreshSchema();
    return client.subscribe((e) => {
      if (e.type === 'schema' || e.type === 'commit' || e.type === 'rollback') refreshSchema();
    });
  }, [client, refreshSchema]);

  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    savePref('theme', theme);
  }, [theme]);

  useEffect(() => {
    const onHash = () => setView(initialView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (v: View) => {
    setView(v);
    try {
      history.replaceState(null, '', `#${v}`);
    } catch {
      // sandboxed frames may refuse history updates
    }
  };

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const isDark = theme === 'dark' || (theme === null && window.matchMedia?.('(prefers-color-scheme: dark)').matches);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#query" onClick={(e) => { e.preventDefault(); go('query'); }}>
          <Logo />
          <span className="brand-name">
            OpusDB <span>Studio</span>
          </span>
        </a>
        <span className="engine-chip" title={local.kind === 'local' ? `Demo data: ${local.demo.rows} rows loaded in ${Math.round(local.demo.ms)} ms` : undefined}>
          <span className={`led${client.inTransaction ? ' txn' : ''}`} />
          {client.label}
          <span className="hide-narrow">· 4 KiB pages · WAL</span>
        </span>
        <span className="spacer" />
        <div className="topbar-actions">
          {remote && (
            <button className="btn small" onClick={() => setUseRemote((u) => !u)} title="Switch between the in-page engine and the OpusDB server">
              {useRemote ? 'Use in-browser engine' : 'Use server'}
            </button>
          )}
          <button className="btn ghost small" onClick={() => setTheme(isDark ? 'light' : 'dark')} aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}>
            {isDark ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>
      <nav className="nav" aria-label="Views">
        {VIEWS.map((v) => (
          <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => go(v.id)}>
            <v.icon />
            {v.label}
          </button>
        ))}
      </nav>
      <main className="main">
        {view === 'query' && (
          <QueryView
            key={client.kind}
            client={client}
            schema={schema}
            onToast={showToast}
            onOpenTree={(name) => {
              setFocusTree(name);
              go('storage');
            }}
            onTxnChange={() => setTick((t) => t + 1)}
          />
        )}
        {view === 'btree' && <TreeLab />}
        {view === 'storage' && <StorageView client={client} schema={schema} focusTree={focusTree} />}
        {view === 'bench' && <BenchView />}
        {view === 'about' && <AboutView />}
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
