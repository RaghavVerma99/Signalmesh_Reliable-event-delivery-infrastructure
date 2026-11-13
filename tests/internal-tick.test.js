'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataFile = path.join(os.tmpdir(), 'signalmesh-tick-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
process.env.SIGNALMESH_STORAGE = 'json';
process.env.SIGNALMESH_DATA_FILE = dataFile;
process.env.SIGNALMESH_RATE_LIMIT = 'false';
process.env.SIGNALMESH_ENABLE_DASHBOARD = 'false';
process.env.SIGNALMESH_INTERNAL_TOKEN = 'tick-secret';

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

test('internal worker tick requires the configured token', async () => {
  const missing = await fetch(base + '/internal/worker-tick', { method: 'POST' });
  assert.equal(missing.status, 401);

  const wrong = await fetch(base + '/internal/worker-tick', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(base + '/internal/worker-tick', {
    method: 'POST',
    headers: { authorization: 'Bearer tick-secret' },
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
});
