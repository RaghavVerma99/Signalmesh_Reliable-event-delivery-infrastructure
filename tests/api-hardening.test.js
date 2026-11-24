'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const defaultConfig = require('../src/config');

function withConfig(overrides) {
  return Object.assign({}, defaultConfig, overrides);
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('malformed JSON errors carry a request id', async () => {
  const app = createApp({ store: {}, config: withConfig({ rateLimit: { enabled: false } }) });
  await withServer(app, async (base) => {
    const res = await fetch(base + '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.request_id, /^req_/);
  });
});

test('bootstrap key creation is rate limited per IP', async () => {
  // countKeys stays 0 so both requests take the unauthenticated bootstrap path.
  const app = createApp({
    store: { kind: 'test', countKeys: async () => 0 },
    config: withConfig({ rateLimit: { enabled: true, burst: 1, perMinute: 1, idleTtlMs: 600000 } }),
  });
  await withServer(app, async (base) => {
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    await fetch(base + '/v1/keys', options); // consumes the single token
    const denied = await fetch(base + '/v1/keys', options);
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('retry-after'), '60');
  });
});

test('an audit write failure does not fail the completed operation', async () => {
  const store = {
    kind: 'test',
    countKeys: async () => 0,
    createOrganization: async (name) => ({ id: 'org_audit', name }),
    createKey: async (input) => Object.assign({ id: 'key_audit', key: 'rel_audit' }, input),
    appendAudit: async () => {
      throw new Error('audit sink down');
    },
  };
  const app = createApp({ store, config: withConfig({ rateLimit: { enabled: false } }) });
  await withServer(app, async (base) => {
    const res = await fetch(base + '/v1/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'audit-test' }),
    });
    assert.equal(res.status, 201, 'the key was created, so the request must report success');
    assert.equal(res.headers.get('x-audit-write-failed'), '1');
    const body = await res.json();
    assert.equal(body.key.name, 'audit-test');
  });
});
