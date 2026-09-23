import { Database, loadDemo, OpusError } from '@opusdb/engine';
import type { DatabaseEvent, PageInfo, QueryResult, SchemaInfo, TreeDump } from '@opusdb/engine';

export type StorageInfo = ReturnType<Database['inspect']['storage']>;
export type PageDetail = { id: number; bytes: Uint8Array; summary: Record<string, string | number> };

export interface QueryError {
  message: string;
  code: string;
  position?: number;
}

export type QueryOutcome = { ok: true; results: QueryResult[]; ms: number } | { ok: false; error: QueryError; results: QueryResult[]; ms: number };

/**
 * What the Studio needs from a database. `LocalClient` runs OpusDB inside the
 * page; `RemoteClient` talks to an `opusdb` server over HTTP + WebSocket when
 * the Studio is served by one.
 */
export interface StudioClient {
  readonly kind: 'local' | 'remote';
  readonly label: string;
  inTransaction: boolean;
  query(sql: string): Promise<QueryOutcome>;
  schema(): Promise<SchemaInfo>;
  tree(name: string, max?: number): Promise<TreeDump | null>;
  pages(): Promise<PageInfo[]>;
  page(id: number): Promise<PageDetail | null>;
  storage(): Promise<StorageInfo>;
  integrity(): Promise<string[]>;
  checkpoint(): Promise<number>;
  subscribe(fn: (e: DatabaseEvent) => void): () => void;
}

function toError(e: unknown): QueryError {
  if (e instanceof OpusError) return { message: e.message, code: e.code, position: e.position };
  return { message: (e as Error)?.message ?? String(e), code: 'XX000' };
}

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

export class LocalClient implements StudioClient {
  readonly kind = 'local' as const;
  readonly label = 'in-browser · memory';
  readonly db: Database;
  private readonly session;
  readonly demo: { rows: number; ms: number };

  constructor() {
    this.db = new Database({ timeoutMs: 20_000, cacheSize: 100_000 });
    this.demo = loadDemo(this.db);
    this.session = this.db.session();
    this.session.profile = true;
  }

  get inTransaction(): boolean {
    return this.session.inTransaction;
  }

  async query(sql: string): Promise<QueryOutcome> {
    await nextFrame();
    const t0 = performance.now();
    const results: QueryResult[] = [];
    try {
      // run statement by statement so earlier results survive a later error
      for (const r of this.session.exec(sql)) results.push(r);
      return { ok: true, results, ms: performance.now() - t0 };
    } catch (e) {
      return { ok: false, error: toError(e), results, ms: performance.now() - t0 };
    }
  }
  async schema(): Promise<SchemaInfo> {
    return this.db.inspect.schema();
  }
  async tree(name: string, max = 400): Promise<TreeDump | null> {
    return this.db.inspect.tree(name, max);
  }
  async pages(): Promise<PageInfo[]> {
    return this.db.inspect.pages();
  }
  async page(id: number): Promise<PageDetail | null> {
    return this.db.inspect.page(id);
  }
  async storage(): Promise<StorageInfo> {
    return this.db.inspect.storage();
  }
  async integrity(): Promise<string[]> {
    await nextFrame();
    return this.db.inspect.integrityCheck();
  }
  async checkpoint(): Promise<number> {
    return this.db.checkpoint();
  }
  subscribe(fn: (e: DatabaseEvent) => void): () => void {
    return this.db.on(fn);
  }
}

/** Client for an OpusDB server (the Studio served at http://host:8080). */
export class RemoteClient implements StudioClient {
  readonly kind = 'remote' as const;
  readonly label: string;
  inTransaction = false;
  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly pending = new Map<number, (m: RemoteMessage) => void>();
  private readonly listeners = new Set<(e: DatabaseEvent) => void>();
  private opening: Promise<WebSocket> | null = null;

  constructor(label: string) {
    this.label = label;
  }

  static async detect(): Promise<RemoteClient | null> {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch('api/health', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
      const body = (await r.json()) as { ok?: boolean; storage?: string };
      return body.ok ? new RemoteClient(`server · ${body.storage ?? 'opusdb'}`) : null;
    } catch {
      return null;
    }
  }

  private socket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.opening) return this.opening;
    const url = new URL('api/ws', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.opening = new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        this.ws = ws;
        this.opening = null;
        resolve(ws);
      };
      ws.onerror = () => {
        this.opening = null;
        reject(new Error('could not connect to the OpusDB server'));
      };
      ws.onclose = () => {
        this.ws = null;
        this.inTransaction = false;
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as RemoteMessage;
        if (msg.type === 'event' && msg.event) {
          for (const l of this.listeners) l(msg.event);
          return;
        }
        if (typeof msg.id === 'number') {
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        }
      };
    });
    return this.opening;
  }

  async query(sql: string): Promise<QueryOutcome> {
    const t0 = performance.now();
    try {
      const ws = await this.socket();
      const id = ++this.seq;
      const msg = await new Promise<RemoteMessage>((resolve) => {
        this.pending.set(id, resolve);
        ws.send(JSON.stringify({ id, sql }));
      });
      this.inTransaction = !!msg.inTransaction;
      if (msg.error) return { ok: false, error: msg.error, results: msg.results ?? [], ms: performance.now() - t0 };
      return { ok: true, results: msg.results ?? [], ms: performance.now() - t0 };
    } catch (e) {
      return { ok: false, error: toError(e), results: [], ms: performance.now() - t0 };
    }
  }
  private async get<T>(path: string): Promise<T> {
    const r = await fetch(path);
    return (await r.json()) as T;
  }
  schema(): Promise<SchemaInfo> {
    return this.get('api/schema');
  }
  async tree(name: string, max = 400): Promise<TreeDump | null> {
    const r = await fetch(`api/tree?name=${encodeURIComponent(name)}&max=${max}`);
    return r.ok ? ((await r.json()) as TreeDump) : null;
  }
  pages(): Promise<PageInfo[]> {
    return this.get('api/pages');
  }
  async page(): Promise<PageDetail | null> {
    return null;
  }
  storage(): Promise<StorageInfo> {
    return this.get('api/storage');
  }
  async integrity(): Promise<string[]> {
    return (await this.get<{ problems: string[] }>('api/integrity')).problems;
  }
  async checkpoint(): Promise<number> {
    const r = await fetch('api/checkpoint', { method: 'POST' });
    return ((await r.json()) as { pages: number }).pages;
  }
  subscribe(fn: (e: DatabaseEvent) => void): () => void {
    this.listeners.add(fn);
    void this.socket().catch(() => {});
    return () => this.listeners.delete(fn);
  }
}

interface RemoteMessage {
  id?: number;
  type?: string;
  event?: DatabaseEvent;
  results?: QueryResult[];
  error?: QueryError;
  inTransaction?: boolean;
}
