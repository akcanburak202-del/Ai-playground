// Writer process for the crash test: appends 50-row batches in transactions
// forever and prints "committed <batch>" after each COMMIT returns.
import { openFile } from '../../src/node.ts';

const path = process.argv[2];
const db = openFile(path, { synchronous: 'full', checkpointFrames: 300 });
db.exec('CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, batch INTEGER, payload TEXT)');
let batch = (db.query('SELECT coalesce(max(batch), 0) FROM log').rows[0][0] as number) + 1;
const ins = db.prepare('INSERT INTO log (batch, payload) VALUES (?, ?)');
for (;;) {
  db.exec('BEGIN');
  for (let i = 0; i < 50; i++) ins.run([batch, `row ${i} of batch ${batch} `.repeat(1 + (i % 20))]);
  db.exec('COMMIT');
  process.stdout.write(`committed ${batch}\n`);
  batch++;
}
