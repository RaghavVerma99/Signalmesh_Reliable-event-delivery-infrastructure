'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataFile = path.join(os.tmpdir(), 'signalmesh-api-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
process.env.SIGNALMESH_STORAGE = 'json';
process.env.SIGNALMESH_DATA_FILE = dataFile;
process.env.SIGNALMESH_RATE_LIMIT = 'false';
process.env.SIGNALMESH_ENABLE_DASHBOARD = 'false';
process.env.SIGNALMESH_ENV = 'development';

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

async function req(method, p, options) {
  const opts = options || {};
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (opts.key) headers.authorization = 'Bearer ' + opts.key;
  const res = await fetch(base + p, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

test('tenant-scoped API flow', async () => {
  const boot = await req('POST', '/v1/keys', { body: { name: 'primary', organization: 'acme' } });
  assert.equal(boot.status, 201);
  assert.ok(boot.body.key.key.startsWith('rel_'));
  assert.ok(boot.body.organization_id);
  const keyA = boot.body.key.key;

  const ep = await req('POST', '/v1/endpoints', {
    key: keyA,
    body: { name: 'hook', url: base + '/demo/orders', event_types: ['x'] },
  });
  assert.equal(ep.status, 201);
  assert.equal(ep.body.endpoint.event_types[0], 'x');

  // Second tenant created directly (bootstrap only works once).
  const orgB = await store.createOrganization('beta');
  const keyB = (await store.createKey({ name: 'beta', organizationId: orgB.id })).key;

  // Isolation: B cannot see A's endpoints.
  const listB = await req('GET', '/v1/endpoints', { key: keyB });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.total, 0);
  const listA = await req('GET', '/v1/endpoints', { key: keyA });
  assert.equal(listA.body.total, 1);

  // Ingest + idempotency.
  const event = { event_type: 'x', data: { n: 1 } };
  const first = await req('POST', '/v1/events', { key: keyA, headers: { 'idempotency-key': 'k1' }, body: event });
  assert.equal(first.status, 202);
  assert.equal(first.body.deliveries_created, 1);

  const dup = await req('POST', '/v1/events', { key: keyA, headers: { 'idempotency-key': 'k1' }, body: event });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.idempotent, true);
  assert.equal(dup.body.event_id, first.body.event_id);

  const conflict = await req('POST', '/v1/events', { key: keyA, headers: { 'idempotency-key': 'k1' }, body: { event_type: 'x', data: { n: 2 } } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');

  // PATCH is tenant scoped.
  const patch = await req('PATCH', '/v1/endpoints/' + ep.body.endpoint.id, { key: keyA, body: { name: 'renamed' } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.endpoint.name, 'renamed');
  const crossPatch = await req('PATCH', '/v1/endpoints/' + ep.body.endpoint.id, { key: keyB, body: { name: 'hijack' } });
  assert.equal(crossPatch.status, 404);

  // Secret rotation returns the new secret once and is tenant scoped.
  const rotate = await req('POST', '/v1/endpoints/' + ep.body.endpoint.id + '/rotate-secret', { key: keyA });
  assert.equal(rotate.status, 200);
  assert.ok(rotate.body.signing_secret.startsWith('whsec_'));
  assert.notEqual(rotate.body.signing_secret, ep.body.signing_secret);
  const crossRotate = await req('POST', '/v1/endpoints/' + ep.body.endpoint.id + '/rotate-secret', { key: keyB });
  assert.equal(crossRotate.status, 404);

  // Deliveries are tenant scoped.
  assert.equal((await req('GET', '/v1/deliveries', { key: keyB })).body.total, 0);
  assert.equal((await req('GET', '/v1/deliveries', { key: keyA })).body.total, 1);

  // Audit is tenant scoped.
  const auditA = await req('GET', '/v1/audit', { key: keyA });
  assert.ok(auditA.body.data.some((a) => a.action === 'endpoint.created'));
  assert.ok(auditA.body.data.some((a) => a.action === 'event.accepted'));
  assert.equal((await req('GET', '/v1/audit', { key: keyB })).body.total, 0);

  // Readiness and dashboard gating.
  const ready = await fetch(base + '/readyz');
  assert.equal(ready.status, 200);
  const dashboard = await fetch(base + '/dashboard');
  assert.equal(dashboard.status, 404);
});
