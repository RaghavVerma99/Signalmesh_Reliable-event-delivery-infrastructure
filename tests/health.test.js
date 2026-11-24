'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const defaultConfig = require('../src/config');

const config = Object.assign({}, defaultConfig, {
  rateLimit: { enabled: false, perMinute: 600, burst: 120 },
  workerHealthMaxAgeMs: 60000,
});

function appWithHeartbeats(heartbeats) {
  const store = {
    kind: 'test',
    ping: async () => true,
    listWorkerHeartbeats: async () => heartbeats,
  };
  return createApp({ store, config });
}

async function get(app, path) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('/healthz/workers reports a fresh heartbeat as healthy', async () => {
  const now = new Date().toISOString();
  const res = await get(appWithHeartbeats([{ worker_id: 'w1', role: 'worker', last_seen_at: now }]), '/healthz/workers');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.workers, 1);
  assert.equal(res.body.stale_workers, 0);
  assert.equal(res.body.worker_last_seen_at, now);
});

test('/healthz/workers rejects stale heartbeats even when rows still exist', async () => {
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const res = await get(appWithHeartbeats([{ worker_id: 'w-old', role: 'worker', last_seen_at: stale }]), '/healthz/workers');
  assert.equal(res.status, 503);
  assert.equal(res.body.status, 'unavailable');
  assert.equal(res.body.workers, 0);
  assert.equal(res.body.stale_workers, 1);
  assert.equal(res.body.worker_last_seen_at, null);
  assert.equal(res.body.max_age_seconds, 60);
});

test('/readyz still accepts traffic when workers are stale, but reports zero workers', async () => {
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const res = await get(appWithHeartbeats([{ worker_id: 'w-old', last_seen_at: stale }]), '/readyz');
  assert.equal(res.status, 200);
  assert.equal(res.body.workers, 0);
  assert.equal(res.body.worker_last_seen_at, null);
});
