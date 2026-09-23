import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { KEYWORDS, SCALAR_FUNCTIONS, AGGREGATE_FUNCTIONS, WINDOW_FUNCTIONS, tokenize } from '@opusdb/engine';
import type { SchemaInfo } from '@opusdb/engine';

/**
 * A lightweight SQL editor: a transparent <textarea> over a highlighted <pre>.
 * Highlighting uses OpusDB's own lexer (in tolerant mode), so what you see is
 * exactly how the engine tokenises the query. Errors reported by the engine
 * are underlined at their character position.
 */

const FUNCTION_NAMES = new Set([...Object.keys(SCALAR_FUNCTIONS), ...Object.keys(AGGREGATE_FUNCTIONS), ...WINDOW_FUNCTIONS]);
const PAD_X = 14;
const PAD_Y = 12;

interface Completion {
  label: string;
  kind: 'keyword' | 'table' | 'column' | 'function';
  detail?: string;
}

export interface EditorProps {
  value: string;
  onChange: (v: string) => void;
  onRun: (sql: string) => void;
  error?: { position?: number; message: string } | null;
  schema: SchemaInfo | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(sql: string, errorPos?: number): string {
  let tokens;
  try {
    tokens = tokenize(sql, { trivia: true, tolerant: true });
  } catch {
    return escapeHtml(sql);
  }
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let cls = '';
    switch (t.kind) {
      case 'word': {
        let j = i + 1;
        while (j < tokens.length && tokens[j].kind === 'space') j++;
        const call = tokens[j]?.kind === 'op' && tokens[j].value === '(';
        if (call && FUNCTION_NAMES.has(t.value)) cls = 'tk-function';
        else if (KEYWORDS.has(t.value)) cls = 'tk-keyword';
        break;
      }
      case 'string':
        cls = 'tk-string';
        break;
      case 'integer':
      case 'real':
        cls = 'tk-number';
        break;
      case 'comment':
        cls = 'tk-comment';
        break;
      case 'param':
        cls = 'tk-param';
        break;
      case 'op':
        cls = 'tk-op';
        break;
      case 'quoted':
        cls = 'tk-quoted';
        break;
    }
    const isErr = errorPos !== undefined && t.kind !== 'space' && errorPos >= t.start && errorPos < Math.max(t.end, t.start + 1);
    if (isErr) cls += ' tk-err';
    const text = escapeHtml(t.text);
    out += cls ? `<span class="${cls.trim()}">${text}</span>` : text;
  }
  if (errorPos !== undefined && errorPos >= sql.length) out += '<span class="tk-err"> </span>';
  return out + '\n';
}

export function Editor({ value, onChange, onRun, error, schema }: EditorProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const [charW, setCharW] = useState(8.1);
  const [lineH, setLineH] = useState(21);
  const [popup, setPopup] = useState<{ items: Completion[]; index: number; x: number; y: number; start: number } | null>(null);
  const html = useMemo(() => highlight(value, error?.position), [value, error?.position]);
  const lines = value.split('\n').length;
  const errLine = error?.position !== undefined ? value.slice(0, error.position).split('\n').length : -1;

  useEffect(() => {
    const measure = () => {
      const c = document.createElement('canvas').getContext('2d');
      if (!c || !ta.current) return;
      const style = getComputedStyle(ta.current);
      c.font = style.font;
      setCharW(c.measureText('0123456789').width / 10);
      setLineH(parseFloat(style.lineHeight) || 21);
    };
    measure();
    void document.fonts?.ready.then(measure);
  }, []);

  const syncScroll = useCallback(() => {
    if (!ta.current) return;
    if (pre.current) {
      pre.current.scrollTop = ta.current.scrollTop;
      pre.current.scrollLeft = ta.current.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = ta.current.scrollTop;
  }, []);
  useLayoutEffect(syncScroll, [html, syncScroll]);

  const candidates = useMemo<Completion[]>(() => {
    const out: Completion[] = [];
    const seen = new Set<string>();
    const add = (c: Completion) => {
      const k = c.kind + c.label.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(c);
      }
    };
    for (const t of schema?.tables ?? []) {
      add({ label: t.name, kind: 'table', detail: `${t.rowCount} rows` });
      for (const c of t.columns) add({ label: c.name, kind: 'column', detail: `${t.name} · ${c.type.toLowerCase()}` });
    }
    for (const v of schema?.views ?? []) add({ label: v.name, kind: 'table', detail: 'view' });
    for (const f of FUNCTION_NAMES) add({ label: f.toLowerCase(), kind: 'function' });
    for (const k of KEYWORDS) add({ label: k, kind: 'keyword' });
    return out;
  }, [schema]);

  const updatePopup = useCallback(
    (text: string, caret: number, force = false) => {
      const before = text.slice(0, caret);
      const m = /([A-Za-z_][\w$]*)$/.exec(before);
      const dot = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)?$/.exec(before);
      let prefix = m ? m[1] : '';
      let pool = candidates;
      if (dot) {
        // "alias.col": offer columns (of the matching table when the alias is a table name)
        prefix = dot[2] ?? '';
        const table = schema?.tables.find((t) => t.name.toLowerCase() === dot[1].toLowerCase());
        pool = candidates.filter((c) => c.kind === 'column' && (!table || c.detail?.startsWith(table.name + ' ')));
      } else if (!force && prefix.length < 2) {
        setPopup(null);
        return;
      }
      const lp = prefix.toLowerCase();
      const items = pool
        .filter((c) => c.label.toLowerCase().startsWith(lp) && c.label.toLowerCase() !== lp)
        .sort((a, b) => {
          const rank = (c: Completion) => (c.kind === 'column' ? 0 : c.kind === 'table' ? 1 : c.kind === 'function' ? 2 : 3);
          return rank(a) - rank(b) || a.label.length - b.label.length;
        })
        .slice(0, 8);
      if (!items.length || !ta.current) {
        setPopup(null);
        return;
      }
      const lineStart = before.lastIndexOf('\n') + 1;
      const row = before.split('\n').length - 1;
      const col = caret - lineStart - prefix.length;
      const x = PAD_X + col * charW - ta.current.scrollLeft;
      const y = PAD_Y + (row + 1) * lineH - ta.current.scrollTop + 2;
      setPopup({ items, index: 0, x: Math.max(4, x), y, start: caret - prefix.length });
    },
    [candidates, charW, lineH, schema],
  );

  const accept = (c: Completion) => {
    const el = ta.current;
    if (!el || !popup) return;
    const caret = el.selectionStart;
    const next = value.slice(0, popup.start) + c.label + value.slice(caret);
    onChange(next);
    const pos = popup.start + c.label.length;
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = pos;
      el.focus();
    });
    setPopup(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      const sel = value.slice(el.selectionStart, el.selectionEnd);
      setPopup(null);
      onRun(sel.trim() ? sel : value);
      return;
    }
    if (popup) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setPopup({ ...popup, index: (popup.index + d + popup.items.length) % popup.items.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(popup.items[popup.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopup(null);
        return;
      }
    }
    if (e.ctrlKey && e.key === ' ') {
      e.preventDefault();
      updatePopup(value, el.selectionStart, true);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = el.selectionStart;
      const next = value.slice(0, s) + '  ' + value.slice(el.selectionEnd);
      onChange(next);
      requestAnimationFrame(() => (el.selectionStart = el.selectionEnd = s + 2));
    }
  };

  return (
    <div className="editor">
      <div className="editor-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={i + 1 === errLine ? 'err' : undefined}>
            {i + 1}
          </div>
        ))}
        <div style={{ height: 40 }} />
      </div>
      <div className="editor-area">
        <pre ref={pre} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
        <textarea
          id="sql-editor"
          ref={ta}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label="SQL editor"
          onChange={(e) => {
            onChange(e.target.value);
            updatePopup(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onScroll={() => {
            syncScroll();
            setPopup(null);
          }}
          onBlur={() => setTimeout(() => setPopup(null), 150)}
          onClick={() => setPopup(null)}
        />
        {popup && (
          <div className="completions" style={{ left: popup.x, top: popup.y }} role="listbox">
            {popup.items.map((c, i) => (
              <button
                key={c.kind + c.label}
                role="option"
                aria-selected={i === popup.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(c);
                }}
              >
                <span>{c.label}</span>
                <span className="kind">{c.detail ?? c.kind}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
