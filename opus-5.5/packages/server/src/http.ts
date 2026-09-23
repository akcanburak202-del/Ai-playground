import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Database, DatabaseEvent } from '@opusdb/engine';
import { acceptWebSocket } from './websocket.ts';
import type { WebSocketConnection } from './websocket.ts';
import { errorPayload, runScript } from './runner.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export interface HttpOptions {
  db: Database;
  port: number;
  host?: string;
  /** Directory with the built Studio (served at /). */
  staticDir?: string;
  log?: (msg: string) => void;
}

function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(data);
}

/**
 * HTTP + WebSocket front end.
 *
 *   POST /api/query      {"sql": "...", "params": [...]}   -> {"results": [...]}
 *   GET  /api/schema | /api/storage | /api/pages | /api/integrity | /api/tree?name=t
 *   POST /api/checkpoint
 *   GET  /api/ws         WebSocket: one session (transactions span messages),
 *                        request {"id","sql","params"} -> {"id","results"|"error"},
 *                        plus pushed {"type":"event"} notifications (commits, schema changes)
 */
export function startHttp(opts: HttpOptions): Promise<Server> {
  const { db } = opts;
  const log = opts.log ?? (() => {});
  const sockets = new Set<WebSocketConnection>();
  const staticDir = opts.staticDir && existsSync(opts.staticDir) ? resolve(opts.staticDir) : undefined;

  db.on((e: DatabaseEvent) => {
    if (e.type === 'tree' || sockets.size === 0) return;
    const msg = JSON.stringify({ type: 'event', event: e });
    for (const s of sockets) s.send(msg);
  });

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const route = url.pathname.replace(/^\/api/, '');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }
      if (route === '/query' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { sql?: string; params?: [] };
        if (typeof body.sql !== 'string') return json(res, 400, { error: { message: 'missing "sql"', code: '22023' } });
        const session = db.session();
        try {
          const results = await runScript(db, session, body.sql, body.params);
          return json(res, 200, { results });
        } catch (e) {
          return json(res, 400, { error: errorPayload(e) });
        } finally {
          session.close();
        }
      }
      if (route === '/schema') return json(res, 200, db.inspect.schema());
      if (route === '/storage') return json(res, 200, db.inspect.storage());
      if (route === '/pages') return json(res, 200, db.inspect.pages());
      if (route === '/integrity') return json(res, 200, { problems: db.inspect.integrityCheck() });
      if (route === '/tree') {
        const t = db.inspect.tree(url.searchParams.get('name') ?? '', Number(url.searchParams.get('max') ?? 400));
        return t ? json(res, 200, t) : json(res, 404, { error: { message: 'no such table or index', code: '42P01' } });
      }
      if (route === '/checkpoint' && req.method === 'POST') return json(res, 200, { pages: db.checkpoint() });
      if (route === '/health') return json(res, 200, { ok: true, storage: db.inspect.storage().description });
      json(res, 404, { error: { message: `unknown endpoint ${url.pathname}`, code: '42883' } });
    } catch (e) {
      json(res, 500, { error: errorPayload(e) });
    }
  };

  const serveStatic = (res: ServerResponse, url: URL) => {
    if (!staticDir) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('OpusDB server is running. Build the Studio (npm run build) to serve it here, or use POST /api/query.\n');
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(staticDir, path);
    if (!file.startsWith(staticDir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      path = '/index.html';
      file = join(staticDir, path);
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) void api(req, res, url);
    else serveStatic(res, url);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    sockets.add(ws);
    const session = db.session();
    log(`websocket session opened (${sockets.size} active)`);
    let queue = Promise.resolve();
    ws.on('message', (text) => {
      // process messages of one connection strictly in order
      queue = queue.then(async () => {
        let id: unknown = null;
        try {
          const msg = JSON.parse(text) as { id?: unknown; sql?: string; params?: [] };
          id = msg.id ?? null;
          if (typeof msg.sql !== 'string') throw new Error('missing "sql"');
          const results = await runScript(db, session, msg.sql, msg.params);
          ws.send(JSON.stringify({ id, results, inTransaction: session.inTransaction }));
        } catch (e) {
          ws.send(JSON.stringify({ id, error: errorPayload(e), inTransaction: session.inTransaction }));
        }
      });
    });
    ws.on('close', () => {
      sockets.delete(ws);
      session.close();
      log(`websocket session closed (${sockets.size} active)`);
    });
    ws.on('error', () => {});
  });

  return new Promise((resolveServer) => server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolveServer(server)));
}
