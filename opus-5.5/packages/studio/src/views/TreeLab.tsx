import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, OpusError } from '@opusdb/engine';
import type { TreeDump, TreeEvent } from '@opusdb/engine';
import { TreeDiagram } from '../components/TreeDiagram';
import { HexDump } from '../components/HexDump';

/**
 * B+tree Lab: a separate in-memory OpusDB whose b-trees run in "teaching
 * mode" (a node splits as soon as it holds more than `order` keys) so the
 * structure stays small enough to watch. Every insert and delete goes
 * through real SQL; the event log comes straight from the engine.
 */

interface LogEntry {
  id: number;
  kind: 'split' | 'root' | 'merge' | 'redistribute' | 'collapse' | 'insert' | 'delete' | 'search' | 'info' | 'error';
  text: string;
}

const SEED_KEYS = [42, 17, 88, 5, 63, 29, 71, 11, 95, 36, 54, 23, 80, 2, 47, 66, 90, 14, 33, 58, 77, 8, 39, 85];

function describeEvent(e: TreeEvent): Omit<LogEntry, 'id'> {
  switch (e.type) {
    case 'split':
      return {
        kind: 'split',
        text: e.leaf
          ? `Leaf p${e.page} overflowed and split: the upper half moved to new leaf p${e.newPage}; separator ${e.separator} goes up to the parent.`
          : `Interior p${e.page} overflowed and split into p${e.page} and p${e.newPage}; key ${e.separator} moves up.`,
      };
    case 'root-split':
      return { kind: 'root', text: `The root split: its halves moved to p${e.left} and p${e.right}, and p${e.root} became a new root with key ${e.separator}. The tree grew one level.` };
    case 'merge':
      return { kind: 'merge', text: `${e.leaf ? 'Leaf' : 'Interior'} p${e.from} fell below half full and was merged into p${e.into}; p${e.from} goes to the free list.` };
    case 'redistribute':
      return { kind: 'redistribute', text: `p${e.left} and p${e.right} rebalanced their keys instead of merging; the parent's separator was updated.` };
    case 'root-collapse':
      return { kind: 'collapse', text: `The root had a single child p${e.from}; it absorbed it and the tree shrank one level.` };
    case 'overflow':
      return { kind: 'info', text: `Payload spilled into ${e.pages} overflow page(s) starting at p${e.first}.` };
  }
}

function affected(e: TreeEvent): number[] {
  switch (e.type) {
    case 'split':
      return [e.page, e.newPage];
    case 'root-split':
      return [e.root, e.left, e.right];
    case 'merge':
      return [e.into];
    case 'redistribute':
      return [e.left, e.right];
    case 'root-collapse':
      return [e.root];
    default:
      return [];
  }
}

function makeDb(order: number): Database {
  const db = new Database({ btreeMaxKeys: order, pageSize: 1024 });
  db.exec('CREATE TABLE lab (k INTEGER PRIMARY KEY)');
  return db;
}

export function TreeLab() {
  const [order, setOrder] = useState(4);
  const dbRef = useRef<Database | null>(null);
  const [dump, setDump] = useState<TreeDump | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [value, setValue] = useState('50');
  const [path, setPath] = useState<Set<number>>(new Set());
  const [hitKey, setHitKey] = useState<string | undefined>();
  const [newKey, setNewKey] = useState<string | undefined>();
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | undefined>();
  const seq = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  const [center, setCenter] = useState(0);
  const pending = useRef<TreeEvent[]>([]);

  const refresh = useCallback(() => {
    const db = dbRef.current!;
    setDump(db.inspect.tree('lab', 500));
  }, []);

  const push = useCallback((entries: Omit<LogEntry, 'id'>[]) => {
    setLog((l) => [...entries.map((e) => ({ ...e, id: ++seq.current })).reverse(), ...l].slice(0, 200));
  }, []);

  const reset = useCallback(
    (o: number, seed = true) => {
      const db = makeDb(o);
      dbRef.current = db;
      db.on((e) => {
        if (e.type === 'tree' && e.name === 'lab') pending.current.push(e.event);
      });
      if (seed) {
        db.exec('BEGIN');
        for (const k of SEED_KEYS) db.query('INSERT INTO lab VALUES (?)', [k]);
        db.exec('COMMIT');
      }
      pending.current = [];
      setPath(new Set());
      setHitKey(undefined);
      setNewKey(undefined);
      setSelected(undefined);
      setLog([]);
      setCenter((c) => c + 1);
      push([{ kind: 'info', text: seed ? `New tree of order ${o} (max ${o} keys per page) seeded with ${SEED_KEYS.length} keys.` : `Empty tree of order ${o}.` }]);
      refresh();
    },
    [push, refresh],
  );

  useEffect(() => reset(order), []); // eslint-disable-line react-hooks/exhaustive-deps

  // on narrow screens the tree is wider than the stage: start with the root in view
  useEffect(() => {
    const el = stage.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [center, dump === null]);

  /** Runs one SQL statement against the lab tree and turns the engine's tree events into log lines. */
  const act = (sql: string, params: number[], label: Omit<LogEntry, 'id'>): boolean => {
    const db = dbRef.current!;
    pending.current = [];
    try {
      const r = db.query(sql, params);
      const events = pending.current.splice(0);
      if (r.rowsAffected === 0 && label.kind === 'delete') {
        push([{ kind: 'error', text: `Key ${params[0]} is not in the tree.` }]);
        return false;
      }
      push([label, ...events.map(describeEvent)]);
      setFlash(new Set(events.flatMap(affected)));
      setTimeout(() => setFlash(new Set()), 900);
      return true;
    } catch (e) {
      const msg = e instanceof OpusError && e.code === '23505' ? `Key ${params[0]} is already in the tree (keys are unique).` : (e as Error).message;
      push([{ kind: 'error', text: msg }]);
      return false;
    }
  };

  const parseKey = (): number | null => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < -999999 || n > 999999) {
      push([{ kind: 'error', text: 'Enter a whole number between -999999 and 999999.' }]);
      return null;
    }
    return n;
  };

  const keys = (): number[] => (dbRef.current!.query('SELECT k FROM lab').rows.map((r) => r[0]) as number[]);

  const insert = (k: number) => {
    if (act('INSERT INTO lab VALUES (?)', [k], { kind: 'insert', text: `INSERT ${k}` })) {
      setNewKey(String(k));
      setPath(new Set());
      refresh();
    }
  };
  const remove = (k: number) => {
    if (act('DELETE FROM lab WHERE k = ?', [k], { kind: 'delete', text: `DELETE ${k}` })) {
      setNewKey(undefined);
      setPath(new Set());
      refresh();
    }
  };
  const search = (k: number) => {
    const res = dbRef.current!.inspect.searchPath('lab', k);
    if (!res) return;
    setPath(new Set(res.path));
    setHitKey(res.found ? String(k) : undefined);
    push([
      {
        kind: 'search',
        text: `SEARCH ${k}: visited ${res.path.map((p) => `p${p}`).join(' → ')} (${res.path.length} page reads); ${res.found ? 'found' : 'not present'}.`,
      },
    ]);
  };
  const insertRandom = (n: number) => {
    const have = new Set(keys());
    let added = 0;
    let guard = 0;
    while (added < n && guard++ < 1000) {
      const k = 1 + Math.floor(Math.random() * 999);
      if (have.has(k)) continue;
      have.add(k);
      if (!act('INSERT INTO lab VALUES (?)', [k], { kind: 'insert', text: `INSERT ${k}` })) break;
      setNewKey(String(k));
      added++;
    }
    setPath(new Set());
    refresh();
  };
  const insertSequential = (n: number) => {
    const ks = keys();
    let next = ks.length ? Math.max(...ks) + 1 : 1;
    for (let i = 0; i < n; i++, next++) act('INSERT INTO lab VALUES (?)', [next], { kind: 'insert', text: `INSERT ${next}` });
    setNewKey(String(next - 1));
    setPath(new Set());
    refresh();
  };
  const deleteRandom = (n: number) => {
    const ks = keys();
    for (let i = 0; i < n && ks.length; i++) {
      const k = ks.splice(Math.floor(Math.random() * ks.length), 1)[0];
      act('DELETE FROM lab WHERE k = ?', [k], { kind: 'delete', text: `DELETE ${k}` });
    }
    setNewKey(undefined);
    setPath(new Set());
    refresh();
  };

  const stats = useMemo(() => {
    if (!dump) return null;
    const leaves = dump.nodes.filter((n) => n.leaf);
    const keyCount = leaves.reduce((s, n) => s + n.keys.length, 0);
    const fill = leaves.length ? keyCount / (leaves.length * order) : 0;
    return { height: dump.depth, pages: dump.nodes.length, leaves: leaves.length, keys: keyCount, fill };
  }, [dump, order]);

  const page = selected !== undefined && dbRef.current ? dbRef.current.inspect.page(selected) : null;

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>B+tree Lab</h1>
          <p>
            A live OpusDB table whose B+tree splits at {order} keys per page, so every split, merge and root change is visible. Each button runs real SQL; the log below is emitted by the storage engine
            itself.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head lab-controls">
          <div className="group">
            <label htmlFor="lab-key" className="label">
              Key
            </label>
            <input
              id="lab-key"
              className="input mono"
              style={{ width: 90 }}
              value={value}
              inputMode="numeric"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const k = parseKey();
                  if (k !== null) insert(k);
                }
              }}
            />
            <button className="btn primary" onClick={() => { const k = parseKey(); if (k !== null) insert(k); }}>
              Insert
            </button>
            <button className="btn" onClick={() => { const k = parseKey(); if (k !== null) search(k); }}>
              Search
            </button>
            <button className="btn" onClick={() => { const k = parseKey(); if (k !== null) remove(k); }}>
              Delete
            </button>
          </div>
          <span className="sep" />
          <div className="group">
            <button className="btn small" onClick={() => insertRandom(5)}>
              +5 random
            </button>
            <button className="btn small" onClick={() => insertSequential(8)}>
              +8 in order
            </button>
            <button className="btn small" onClick={() => deleteRandom(5)}>
              −5 random
            </button>
          </div>
          <span className="sep" />
          <div className="group">
            <label htmlFor="lab-order" className="label">
              Order
            </label>
            <select
              id="lab-order"
              className="input"
              value={order}
              onChange={(e) => {
                const o = Number(e.target.value);
                setOrder(o);
                reset(o);
              }}
            >
              {[3, 4, 5, 6, 8].map((o) => (
                <option key={o} value={o}>
                  {o} keys / page
                </option>
              ))}
            </select>
            <button className="btn small ghost" onClick={() => reset(order)}>
              Reset
            </button>
            <button className="btn small ghost" onClick={() => reset(order, false)}>
              Empty
            </button>
          </div>
        </div>
        <div className="tree-stage" ref={stage}>{dump && <TreeDiagram dump={dump} path={path} hitKey={hitKey} newKey={newKey} flash={flash} selected={selected} onSelect={setSelected} />}</div>
        {stats && (
          <div className="legend" style={{ padding: '10px 14px', borderTop: '1px solid var(--rule)' }}>
            <span>
              <b className="num">{stats.height}</b> levels
            </span>
            <span>
              <b className="num">{stats.pages}</b> pages ({stats.leaves} leaves)
            </span>
            <span>
              <b className="num">{stats.keys}</b> keys
            </span>
            <span>
              leaf fill <b className="num">{Math.round(stats.fill * 100)}%</b>
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <i style={{ border: '1.5px solid var(--series-1)', background: 'var(--surface)' }} /> leaf page
            </span>
            <span>
              <i style={{ border: '1.5px solid var(--ink-2)', background: 'var(--surface-2)' }} /> interior page
            </span>
            <span>
              <i style={{ border: '1.5px solid var(--accent)' }} /> search path
            </span>
          </div>
        )}
      </div>

      <div className="lab-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>Engine log</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              newest first
            </span>
          </div>
          <ul className="events">
            {log.map((e) => (
              <li key={e.id} className={e.kind}>
                <span className="kind">{e.kind}</span>
                <span style={{ color: e.kind === 'error' ? 'var(--bad)' : undefined }}>{e.text}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>{page ? `Page ${page.id}` : 'Page inspector'}</h2>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {page ? (
              <>
                <dl className="kv">
                  {Object.entries(page.summary).map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>{k}</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
                <HexDump bytes={page.bytes} header={3} limit={128} />
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Byte 0 is the page type (1 = table leaf, 2 = table interior), bytes 1–2 the key count. Leaf cells are an 8-byte rowid followed by a varint length and the encoded row.
                </p>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Click any page in the tree to see its bytes exactly as they are written to the write-ahead log.
              </p>
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>How this tree behaves</h2>
        </div>
        <div className="panel-body prose">
          <p>
            Keys live only in the leaves (bottom row); interior pages hold separator keys that route a search. A page may hold at most {order} keys; one more makes it split in two, and the separator
            moves up. When the root splits the tree grows a level, which is the only way a B+tree gets taller, so every leaf is always at the same depth.
          </p>
          <p>
            Deleting below {Math.floor(order / 2)} keys makes a page borrow from a sibling or merge with it. On disk OpusDB uses the same code with a byte budget instead of a key count: a 4 KiB page holds
            a few hundred rowids, so a three-level tree indexes millions of rows. Inserting keys in ascending order uses the append fast path in normal mode, leaving pages completely full.
          </p>
        </div>
      </section>
    </div>
  );
}
