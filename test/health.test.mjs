import test from 'node:test';
import assert from 'node:assert/strict';
import { startHealthServer } from '../src/health.mjs';
import { config } from '../src/config.mjs';

test('HTTP: readiness, recent polling, HEAD, method and unknown paths', async t => {
  let current = { ready: false, lastActivity: 0, token: 'must-never-leak' };
  const now = 1000000;
  const server = await startHealthServer({ port: 0, host: '127.0.0.1', status: () => current, now: () => now });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${url}/healthz`);
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('must-never-leak'));
  current = { ...current, ready: true, lastActivity: now - 1000 };
  response = await fetch(`${url}/healthz`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal((await fetch(`${url}/`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${url}/unknown`)).status, 404);
  assert.equal((await fetch(`${url}/healthz`, { method: 'POST' })).status, 405);
  current = { ...current, ready: false, initialized: true };
  assert.equal((await fetch(`${url}/readyz`)).status, 200);
  assert.equal((await fetch(`${url}/healthz`)).status, 503);
  current.ready = true;
  current.lastActivity = now - 180001;
  assert.equal((await fetch(`${url}/healthz`)).status, 503);
});

test('Render port configuration rejects invalid ports and remains optional locally', () => {
  const env = { TELEGRAM_BOT_TOKEN: `1234:${'x'.repeat(30)}`, ALLOWED_TELEGRAM_IDS: '42', GOOGLE_SPREADSHEET_ID: 'x'.repeat(30) };
  assert.equal(config(env).port, null);
  assert.equal(config({ ...env, PORT: '10000' }).port, 10000);
  assert.throws(() => config({ ...env, PORT: 'abc' }), /PORT/);
  assert.throws(() => config({ ...env, PORT: '65536' }), /PORT/);
});
