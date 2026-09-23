import type { DataType, Value } from './types.ts';
import { describeValue } from './types.ts';
import type { Database } from './database.ts';
import { encodePage, PageType } from './storage/page.ts';
import type { FreePage, NodePage } from './storage/page.ts';
import type { DumpNode } from './storage/btree.ts';
import { exprToSql } from './sql/printer.ts';
import { indexToSql, tableToSql } from './catalog.ts';

export interface SchemaInfo {
  tables: {
    name: string;
    columns: { name: string; type: DataType; notNull: boolean; primaryKey: boolean; default?: string }[];
    indexes: { name: string; columns: string[]; unique: boolean; auto: boolean; rootPage: number; sql: string }[];
    rowCount: number;
    rootPage: number;
    sql: string;
  }[];
  views: { name: string; sql: string; columns?: string[] }[];
}

export type PageKind = 'header' | 'catalog' | 'table-leaf' | 'table-interior' | 'index-leaf' | 'index-interior' | 'overflow' | 'free' | 'unused';

export interface PageInfo {
  id: number;
  kind: PageKind;
  owner?: string;
  /** Fill factor 0..1 for b-tree pages. */
  fill?: number;
  inWal?: boolean;
}

export interface TreeDump {
  name: string;
  kind: 'table' | 'index';
  root: number;
  depth: number;
  nodes: (Omit<DumpNode, 'keys'> & { keys: string[]; fill: number })[];
  truncated: boolean;
}

function fmtKey(k: number | Value[]): string {
  if (typeof k === 'number') return String(k);
  return k.length === 1 ? describeValue(k[0]) : `(${k.map(describeValue).join(', ')})`;
}

/** Read-only introspection used by the Studio (schema tree, b-tree and page visualisations). */
export class Inspector {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  schema(): SchemaInfo {
    const cat = this.db.catalog;
    cat.refresh();
    const tables = [...cat.tables.values()].map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, notNull: c.notNull, primaryKey: c.primaryKey, default: c.default ? exprToSql(c.default) : undefined })),
      indexes: t.indexes.map((ix) => ({
        name: ix.name,
        columns: ix.columns.map((i) => t.columns[i].name),
        unique: ix.unique,
        auto: ix.auto,
        rootPage: ix.root,
        sql: indexToSql(ix, t),
      })),
      rowCount: cat.tableTree(t).count(),
      rootPage: t.root,
      sql: tableToSql(t),
    }));
    const views = [...cat.views.values()].map((v) => ({ name: v.name, sql: v.sql, columns: v.columns }));
    return { tables, views };
  }

  tree(name: string, maxNodes = 400): TreeDump | null {
    const cat = this.db.catalog;
    cat.refresh();
    const t = cat.tables.get(name.toLowerCase());
    const ix = cat.indexes.get(name.toLowerCase());
    const tree = t ? cat.tableTree(t) : ix ? cat.indexTree(ix) : null;
    if (!tree) return null;
    const nodes = tree.dump(maxNodes + 1);
    const pageSize = this.db.pager.pageSize;
    return {
      name: t ? t.name : ix!.name,
      kind: t ? 'table' : 'index',
      root: tree.root,
      depth: tree.depth(),
      truncated: nodes.length > maxNodes,
      nodes: nodes.slice(0, maxNodes).map((n) => ({ ...n, keys: n.keys.map(fmtKey), fill: Math.min(1, n.size / pageSize) })),
    };
  }

  /** Classifies every page of the database file. */
  pages(): PageInfo[] {
    const { pager, catalog } = this.db;
    catalog.refresh();
    const count = pager.header.pageCount;
    const out: PageInfo[] = Array.from({ length: count }, (_, id) => ({ id, kind: 'unused' as PageKind }));
    out[0] = { id: 0, kind: 'header' };
    const pageSize = pager.pageSize;
    for (const { name, kind, tree } of catalog.trees()) {
      const check = tree.check();
      for (const id of check.pages) {
        const p = pager.get(id);
        let k: PageKind;
        let fill: number | undefined;
        if (p.type === PageType.overflow) k = 'overflow';
        else {
          const node = p as NodePage;
          fill = Math.min(1, node.size / pageSize);
          if (kind === 'catalog') k = 'catalog';
          else if (p.type === PageType.tableLeaf) k = 'table-leaf';
          else if (p.type === PageType.tableInterior) k = 'table-interior';
          else if (p.type === PageType.indexLeaf) k = 'index-leaf';
          else k = 'index-interior';
        }
        if (id < count) out[id] = { id, kind: k, owner: name, fill };
      }
    }
    let free = pager.header.freeHead;
    let guard = 0;
    while (free !== 0 && guard++ < count) {
      out[free] = { id: free, kind: 'free' };
      free = (pager.get(free) as FreePage).next;
    }
    const inWal = new Set(pager.walPages());
    for (const p of out) if (inWal.has(p.id)) p.inWal = true;
    return out;
  }

  /** Full structural check of every b-tree plus page accounting; returns a list of problems. */
  integrityCheck(): string[] {
    const problems: string[] = [];
    const { pager, catalog } = this.db;
    catalog.refresh();
    const seen = new Map<number, string>();
    const claim = (id: number, owner: string) => {
      const prev = seen.get(id);
      if (prev) problems.push(`page ${id} is used by both ${prev} and ${owner}`);
      seen.set(id, owner);
    };
    claim(0, 'header');
    for (const { name, tree, kind } of catalog.trees()) {
      try {
        const res = tree.check();
        for (const id of res.pages) claim(id, name);
        if (kind === 'table') {
          const t = catalog.tables.get(name.toLowerCase())!;
          for (const ix of t.indexes) {
            const n = catalog.indexTree(ix).count();
            if (n !== res.entries) problems.push(`index ${ix.name} has ${n} entries but table ${t.name} has ${res.entries} rows`);
          }
        }
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    let free = pager.header.freeHead;
    let freeCount = 0;
    while (free !== 0) {
      claim(free, 'freelist');
      freeCount++;
      if (freeCount > pager.header.pageCount) {
        problems.push('free list contains a cycle');
        break;
      }
      free = (pager.get(free) as FreePage).next;
    }
    if (freeCount !== pager.header.freeCount) problems.push(`free list has ${freeCount} pages, header says ${pager.header.freeCount}`);
    for (let id = 1; id < pager.header.pageCount; id++) if (!seen.has(id)) problems.push(`page ${id} is never used (leaked)`);
    return problems;
  }

  storage(): {
    pageSize: number;
    pageCount: number;
    freePages: number;
    fileBytes: number;
    schemaCookie: number;
    changeCounter: number;
    wal: ReturnType<Database['pager']['walInfo']>;
    cache: ReturnType<Database['pager']['cacheInfo']>;
    stats: Database['pager']['stats'];
    persistent: boolean;
    description: string;
  } {
    const p = this.db.pager;
    return {
      pageSize: p.pageSize,
      pageCount: p.header.pageCount,
      freePages: p.header.freeCount,
      fileBytes: p.header.pageCount * p.pageSize,
      schemaCookie: p.header.schemaCookie,
      changeCounter: p.header.changeCounter,
      wal: p.walInfo(),
      cache: p.cacheInfo(),
      stats: { ...p.stats },
      persistent: p.storage.persistent,
      description: p.storage.description,
    };
  }

  /** Pages visited when searching `key` in a table (rowid) or index (first column) b-tree. */
  searchPath(name: string, key: Value): { path: number[]; found: boolean } | null {
    const cat = this.db.catalog;
    cat.refresh();
    const t = cat.tables.get(name.toLowerCase());
    const ix = cat.indexes.get(name.toLowerCase());
    const tree = t ? cat.tableTree(t) : ix ? cat.indexTree(ix) : null;
    if (!tree) return null;
    const c = tree.cursor();
    const probe = t ? Number(key) : [key];
    const ok = c.seek(probe as never);
    const path = ok ? c.path() : [];
    if (!ok) {
      // key is past the last entry: the search still walked the rightmost path
      c.last();
      path.push(...c.path());
    }
    const found = ok && tree.cmpPrefix(c.key(), probe as never) === 0;
    return { path, found };
  }

  /** Raw bytes of a page as it would be written to disk, plus a short decoded summary. */
  page(id: number): { id: number; bytes: Uint8Array; summary: Record<string, string | number> } | null {
    const pager = this.db.pager;
    if (id < 0 || id >= pager.header.pageCount) return null;
    const p = id === 0 ? pager.header : pager.get(id);
    const bytes = encodePage(p, pager.pageSize);
    const summary: Record<string, string | number> = {};
    switch (p.type) {
      case PageType.header:
        Object.assign(summary, { type: 'header', pageSize: p.pageSize, pageCount: p.pageCount, freePages: p.freeCount, catalogRoot: p.catalogRoot, schemaCookie: p.schemaCookie, changeCounter: p.changeCounter });
        break;
      case PageType.overflow:
        Object.assign(summary, { type: 'overflow', next: p.next, bytes: p.data.length });
        break;
      case PageType.free:
        Object.assign(summary, { type: 'free', next: p.next });
        break;
      default: {
        const n = p as NodePage;
        const names = { 1: 'table leaf', 2: 'table interior', 3: 'index leaf', 4: 'index interior' } as const;
        Object.assign(summary, { type: names[n.type], entries: n.keys.length, used: n.size, free: pager.pageSize - n.size });
        if (n.keys.length) summary.range = `${fmtKey(n.keys[0])} … ${fmtKey(n.keys[n.keys.length - 1])}`;
      }
    }
    return { id, bytes, summary };
  }

  tableSql(name: string): string | undefined {
    const t = this.db.catalog.tables.get(name.toLowerCase());
    return t ? tableToSql(t) : undefined;
  }
}
