import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FirestoreState, DurableStore } from '../src/firestore.mjs';
import { Store } from '../src/store.mjs';
import { ApiError } from '../src/http.mjs';

class FakeFirestore {
  constructor() { this.doc = null; this.sequence = 0; this.now = 100000; this.fail = false; this.afterCommit = false; }
  request = async (url, options) => {
    if (this.fail) throw new Error('network down');
    const params = new URL(url).searchParams;
    if (options.method === 'GET') {
      if (!this.doc) throw new ApiError('Firestore', 404);
      return structuredClone(this.doc);
    }
    if (params.get('currentDocument.exists') === 'false' && this.doc) throw new ApiError('Firestore', 409);
    if (params.has('currentDocument.updateTime') && this.doc?.updateTime !== params.get('currentDocument.updateTime')) throw new ApiError('Firestore', 412);
    const body = JSON.parse(options.body);
    this.doc ??= { fields: {} };
    for (const field of params.getAll('updateMask.fieldPaths')) this.doc.fields[field] = body.fields[field];
    this.doc.updateTime = `version-${++this.sequence}`;
    if (this.afterCommit) { this.afterCommit = false; throw new Error('response lost after commit'); }
    return structuredClone(this.doc);
  };
  client(owner) { return new FirestoreState({ projectId: 'test-p2p-project', botId: '1234', token: async () => 'fake', request: this.request, owner, now: () => this.now }); }
}
const empty = () => ({ version: 1, meta: [], drafts: [] });
function localStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'p2p-cloud-test-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test('Firestore: two simultaneous starts cannot both acquire the lease', async () => {
  const server = new FakeFirestore(), first = server.client('first'), second = server.client('second');
  const results = await Promise.all([first.acquire(), second.acquire()]);
  assert.equal(results.filter(r => r.acquired).length, 1);
});
test('Firestore: renewal preserves snapshot and a restart restores cursor and data', async () => {
  const server = new FakeFirestore(), first = server.client('first');
  assert.equal((await first.acquire()).acquired, true);
  const snapshot = { ...empty(), meta: [{ key: 'offset', value: '3456' }] };
  await first.save(snapshot); await first.renew();
  assert.equal((await server.client('second').acquire()).acquired, false);
  await first.release();
  const restored = await server.client('second').acquire();
  assert.equal(restored.acquired, true); assert.deepEqual(restored.snapshot, snapshot);
});
test('Firestore: lease expires after a forced shutdown; old holder cannot write', async () => {
  const server = new FakeFirestore(), first = server.client('first'), second = server.client('second');
  await first.acquire(); server.now += 90001;
  assert.equal((await second.acquire()).acquired, true);
  await assert.rejects(first.save(empty()), /право работы/); assert.equal(first.lost, true);
});
test('Firestore: version precondition fences a stale holder even before local lease expiration', async () => {
  const server = new FakeFirestore(), first = server.client('first'); await first.acquire();
  server.doc.updateTime = 'external-change';
  await assert.rejects(first.renew(), /HTTP 412/); assert.equal(first.lost, true);
});
test('Firestore: a lost save response preserves the committed state for the next instance', async () => {
  const server = new FakeFirestore(), first = server.client('first'); await first.acquire();
  server.afterCommit = true;
  const snapshot = { ...empty(), meta: [{ key: 'offset', value: '777' }] };
  await assert.rejects(first.save(snapshot), /response lost/); assert.equal(first.lost, true);
  server.now += 90001;
  assert.deepEqual((await server.client('second').acquire()).snapshot, snapshot);
});
test('DurableStore: draft and exact string ID are persisted before create resolves', async t => {
  const local = localStore(t), server = new FakeFirestore(), remote = server.client('first'); await remote.acquire();
  const store = new DurableStore(local, remote);
  await store.create({ id: 'aabbccddeeff', userId: '42', chatId: '42', hash: 'image-hash', order: { orderId: '20260000000000000001' } });
  await store.set('offset', 12345);
  const snapshot = JSON.parse(server.doc.fields.snapshot.stringValue);
  const nextLocal = localStore(t); nextLocal.restore(snapshot);
  assert.equal(nextLocal.get('offset'), '12345');
  assert.equal(nextLocal.pending('42')[0].order.orderId, '20260000000000000001');
});
test('DurableStore: failure rolls back cursor and draft; does not acknowledge an unpersisted update', async t => {
  const local = localStore(t), server = new FakeFirestore(), remote = server.client('first'); await remote.acquire();
  local.set('offset', 10); const store = new DurableStore(local, remote); server.fail = true;
  await assert.rejects(store.set('offset', 20), /network down/); assert.equal(local.get('offset'), '10');
});
test('Firestore: refuse snapshots exceeding the document safety limit', async () => {
  const server = new FakeFirestore(), remote = server.client('first'); await remote.acquire();
  await assert.rejects(remote.save({ ...empty(), large: 'x'.repeat(750000) }), /Слишком много/);
  assert.equal(server.doc.fields.snapshot, undefined);
});
test('SQLite snapshot prunes only old closed drafts; all pending drafts remain', t => {
  const local = localStore(t);
  for (let i = 0; i < 205; i++) {
    local.create({ id: String(i), userId: '42', chatId: '42', hash: String(i), order: {} });
    local.finish(String(i), '42', 'saved', 13 + i);
  }
  local.create({ id: 'pending', userId: '42', chatId: '42', hash: 'pending', order: {} });
  const snapshot = local.snapshot();
  assert.equal(snapshot.drafts.length, 201); assert.equal(snapshot.drafts.find(d => d.id === 'pending').status, 'pending');
});
