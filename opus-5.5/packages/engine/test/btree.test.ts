import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/file.ts';
import { Pager } from '../src/storage/pager.ts';
import { BTree } from '../src/storage/btree.ts';
import type { Value } from '../src/types.ts';
import { compareTuples } from '../src/types.ts';
import { encodeRecord, decodeRecord } from '../src/storage/codec.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function payloadFor(key: number, size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (key * 31 + i) & 0xff;
  return b;
}

function scan(tree: BTree): number[] {
  const c = tree.cursor();
  const out: number[] = [];
  for (let ok = c.first(); ok; ok = c.next()) out.push(c.key() as number);
  return out;
}

function scanReverse(tree: BTree): number[] {
  const c = tree.cursor();
  const out: number[] = [];
  for (let ok = c.last(); ok; ok = c.prev()) out.push(c.key() as number);
  return out;
}

for (const mode of [{ name: 'byte-sized pages', maxKeys: undefined, pageSize: 1024 }, { name: 'teaching mode (maxKeys=4)', maxKeys: 4, pageSize: 4096 }]) {
  test(`table b-tree random insert/delete matches a model (${mode.name})`, () => {
    const pager = new Pager(new MemoryStorage(), { pageSize: mode.pageSize });
    const root = BTree.create(pager, 'table');
    const tree = new BTree(pager, root, 'table', { maxKeys: mode.maxKeys });
    const model = new Map<number, number>();
    const rand = rng(42);
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 150; i++) {
        const key = Math.floor(rand() * 2000);
        const r = rand();
        if (r < 0.6) {
          const size = rand() < 0.05 ? 1500 + Math.floor(rand() * 5000) : Math.floor(rand() * 120);
          const inserted = tree.insert(key, payloadFor(key, size), true);
          assert.equal(inserted, !model.has(key));
          model.set(key, size);
        } else {
          const deleted = tree.delete(key);
          assert.equal(deleted, model.has(key));
          model.delete(key);
        }
      }
      const check = tree.check();
      assert.equal(check.entries, model.size);
      if (round % 3 === 0) pager.commit();
    }
    const keys = [...model.keys()].sort((a, b) => a - b);
    assert.deepEqual(scan(tree), keys);
    assert.deepEqual(scanReverse(tree), keys.slice().reverse());
    for (const k of keys.slice(0, 200)) {
      const p = tree.get(k)!;
      assert.equal(p.length, model.get(k));
      assert.deepEqual(p, payloadFor(k, model.get(k)!));
    }
    // seeks
    const c = tree.cursor();
    for (let probe = -5; probe < 2010; probe += 37) {
      const ge = keys.find((k) => k >= probe);
      assert.equal(c.seek(probe) ? c.key() : undefined, ge);
      const gt = keys.find((k) => k > probe);
      assert.equal(c.seek(probe, true) ? c.key() : undefined, gt);
      const le = [...keys].reverse().find((k) => k <= probe);
      assert.equal(c.seekLast(probe) ? c.key() : undefined, le);
      const lt = [...keys].reverse().find((k) => k < probe);
      assert.equal(c.seekLast(probe, true) ? c.key() : undefined, lt);
    }
    // delete everything -> single empty root leaf
    for (const k of keys) assert.ok(tree.delete(k));
    const final = tree.check();
    assert.equal(final.entries, 0);
    assert.equal(final.depth, 1);
  });
}

test('sequential appends pack leaves densely', () => {
  const pager = new Pager(new MemoryStorage(), { pageSize: 4096 });
  const tree = new BTree(pager, BTree.create(pager, 'table'), 'table');
  for (let i = 1; i <= 20000; i++) tree.insert(i, payloadFor(i, 40));
  const check = tree.check();
  assert.equal(check.entries, 20000);
  // each cell is 8 + 1 + 40 = 49 bytes -> ~83 per 4K page when packed full
  assert.ok(check.leaves < 20000 / 75, `expected dense leaves, got ${check.leaves}`);
});

test('index b-tree with tuple keys, prefix seeks and descending columns', () => {
  const pager = new Pager(new MemoryStorage(), { pageSize: 512 });
  const tree = new BTree(pager, BTree.create(pager, 'index'), 'index', { desc: [false, true, false] });
  const rand = rng(7);
  const model: Value[][] = [];
  for (let rowid = 1; rowid <= 3000; rowid++) {
    const a = rand() < 0.1 ? null : Math.floor(rand() * 20);
    const b = 'k' + Math.floor(rand() * 50);
    const key = [a, b, rowid];
    tree.insert(key);
    model.push(key);
  }
  const desc = [false, true, false];
  model.sort((x, y) => compareTuples(x, y, desc));
  tree.check();
  const c = tree.cursor();
  const got: Value[][] = [];
  for (let ok = c.first(); ok; ok = c.next()) got.push(c.key() as Value[]);
  assert.deepEqual(got, model);
  // prefix seek on a = 7: all entries with a = 7 are contiguous
  const expected = model.filter((k) => k[0] === 7);
  const found: Value[][] = [];
  for (let ok = c.seek([7]); ok && tree.cmpPrefix(c.key(), [7]) === 0; ok = c.next()) found.push(c.key() as Value[]);
  assert.deepEqual(found, expected);
  // delete half and re-check
  for (let i = 0; i < model.length; i += 2) assert.ok(tree.delete(model[i]));
  const check = tree.check();
  assert.equal(check.entries, Math.floor(model.length / 2));
});

test('transaction rollback restores the previous tree', () => {
  const storage = new MemoryStorage();
  const pager = new Pager(storage, { pageSize: 1024 });
  const root = BTree.create(pager, 'table');
  const tree = new BTree(pager, root, 'table');
  for (let i = 0; i < 500; i++) tree.insert(i, encodeRecord([i, 'row ' + i]));
  pager.commit();
  const before = scan(tree);
  for (let i = 0; i < 500; i += 2) tree.delete(i);
  for (let i = 1000; i < 1500; i++) tree.insert(i, encodeRecord([i]));
  pager.rollback();
  assert.deepEqual(scan(tree), before);
  tree.check();
});

test('statement rollback inside a transaction', () => {
  const pager = new Pager(new MemoryStorage(), { pageSize: 1024 });
  const tree = new BTree(pager, BTree.create(pager, 'table'), 'table');
  for (let i = 0; i < 300; i++) tree.insert(i, encodeRecord([i]));
  // statement 1 (kept)
  pager.beginStatement();
  for (let i = 300; i < 600; i++) tree.insert(i, encodeRecord([i]));
  pager.endStatement();
  const afterStmt1 = scan(tree);
  // statement 2 (rolled back)
  pager.beginStatement();
  for (let i = 0; i < 600; i += 3) tree.delete(i);
  for (let i = 600; i < 900; i++) tree.insert(i, encodeRecord([i, 'x'.repeat(50)]));
  pager.rollbackStatement();
  assert.deepEqual(scan(tree), afterStmt1);
  tree.check();
  pager.commit();
  assert.deepEqual(scan(tree), afterStmt1);
});

test('WAL recovery: committed data survives reopen, torn tail is ignored', () => {
  const storage = new MemoryStorage();
  let pager = new Pager(storage, { pageSize: 1024 });
  const root = BTree.create(pager, 'table');
  pager.setHeader({ catalogRoot: root });
  let tree = new BTree(pager, root, 'table');
  for (let i = 0; i < 200; i++) tree.insert(i, encodeRecord([i, 'first']));
  pager.commit();
  const walSizeAfterFirst = storage.wal.size();
  for (let i = 200; i < 400; i++) tree.insert(i, encodeRecord([i, 'second']));
  pager.commit();

  // simulate a crash in the middle of writing the second transaction
  const walBytes = storage.wal.contents();
  const torn = new MemoryStorage();
  torn.wal.write(0, walBytes.subarray(0, walSizeAfterFirst + Math.floor((walBytes.length - walSizeAfterFirst) / 2)));
  pager = new Pager(torn, {});
  tree = new BTree(pager, pager.header.catalogRoot, 'table');
  assert.equal(tree.count(), 200);
  tree.check();

  // full WAL -> everything visible; then checkpoint and reopen from the main file only
  pager = new Pager(storage, {});
  tree = new BTree(pager, pager.header.catalogRoot, 'table');
  assert.equal(tree.count(), 400);
  assert.deepEqual(decodeRecord(tree.get(399)!), [399, 'second']);
  pager.checkpoint();
  assert.equal(storage.wal.size(), 32);
  pager = new Pager(storage, {});
  tree = new BTree(pager, pager.header.catalogRoot, 'table');
  assert.equal(tree.count(), 400);
  tree.check();
});

test('free pages are reused', () => {
  const pager = new Pager(new MemoryStorage(), { pageSize: 1024 });
  const tree = new BTree(pager, BTree.create(pager, 'table'), 'table');
  for (let i = 0; i < 2000; i++) tree.insert(i, payloadFor(i, 60));
  pager.commit();
  const pages = pager.header.pageCount;
  for (let i = 0; i < 2000; i++) tree.delete(i);
  pager.commit();
  assert.ok(pager.header.freeCount > 0);
  for (let i = 0; i < 2000; i++) tree.insert(i, payloadFor(i, 60));
  pager.commit();
  assert.ok(pager.header.pageCount <= pages + 2, `page count grew from ${pages} to ${pager.header.pageCount}`);
});
