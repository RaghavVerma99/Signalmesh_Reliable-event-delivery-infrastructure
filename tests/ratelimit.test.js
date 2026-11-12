'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataFile = path.join(os.tmpdir(), 'signalmesh-rl-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
process.env.SIGNALMESH_STORAGE = 'json';
process.env.SIGNALMESH_DATA_FILE = dataFile;
process.env.SIGNALMESH_RATE_LIMIT = 'true';
process.env.SIGNALMESH_RATE_LIMIT_PER_MINUTE = '1';
process.env.SIGNALMESH_RATE_LIMIT_BURST = '1';
process.env.SIGNALMESH_ENABLE_DASHBOARD = 'false';

const store = require('../src/store');
const { createApp } = require('../src/app');

let server;
let base;

before(async () => {
  await store.init();
  const app = createApp({ store });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await store.close();
  try {
    fs.unlinkSync(dataFile);
  } catch {
    /* ignore */
  }
});

test('tenant rate limit returns 429 with Retry-After', async () => {
  const boot = await fetch(base + '/v1/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'rl', organization: 'rl-org' }),
  });
  assert.equal(boot.status, 201);
  const key = (await boot.json()).key.key;

  const first = await fetch(base + '/v1/endpoints', { headers: { authorization: 'Bearer ' + key } });
  assert.equal(first.status, 200);

  const second = await fetch(base + '/v1/endpoints', { headers: { authorization: 'Bearer ' + key } });
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
  const body = await second.json();
  assert.equal(body.error.code, 'rate_limited');
});
