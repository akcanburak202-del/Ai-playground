#!/usr/bin/env node
/**
 * OpusDB server.
 *
 *   node src/main.ts [--data ./opus.opusdb | --memory] [--http 8080] [--pg 5433] [--host 127.0.0.1] [--demo]
 *
 * Serves the HTTP/JSON API, WebSocket sessions and the Studio on --http and
 * speaks the PostgreSQL wire protocol on --pg, so `psql -h 127.0.0.1 -p 5433`
 * works out of the box.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Database, loadDemo } from '@opusdb/engine';
import { openFile } from '@opusdb/engine/node';
import { startHttp } from './http.ts';
import { startPgServer } from './pgwire.ts';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const host = opt('host', '127.0.0.1')!;
const httpPort = Number(opt('http', '8080'));
const pgPort = Number(opt('pg', '5433'));
const memory = args.includes('--memory');
const dataPath = resolve(opt('data', 'opus.opusdb')!);
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = opt('static', join(here, '../../studio/dist'));

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const db = memory ? new Database() : openFile(dataPath);
if (args.includes('--demo') && db.inspect.schema().tables.length === 0) {
  const { rows, ms } = loadDemo(db);
  log(`loaded the demo dataset (${rows} rows in ${Math.round(ms)} ms)`);
}

const http = await startHttp({ db, port: httpPort, host, staticDir, log });
const pg = await startPgServer({ db, port: pgPort, host, log });
log(`OpusDB ${memory ? '(in-memory)' : dataPath}`);
log(`HTTP + Studio   http://${host}:${httpPort}`);
log(`WebSocket       ws://${host}:${httpPort}/api/ws`);
log(`PostgreSQL      psql -h ${host} -p ${pgPort}`);

const shutdown = () => {
  log('shutting down (checkpointing)…');
  http.close();
  pg.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
