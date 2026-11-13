'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataFile = path.join(os.tmpdir(), 'signalmesh-saas-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
process.env.SIGNALMESH_STORAGE = 'json';
process.env.SIGNALMESH_DATA_FILE = dataFile;
process.env.SIGNALMESH_RATE_LIMIT = 'false';
process.env.SIGNALMESH_ENABLE_DASHBOARD = 'false';
process.env.SIGNALMESH_ENV = 'development';

const store = require('../src/store');
const { createApp } = require('../src/app');
const { normalizeScopes, hasScope } = require('../src/scopes');
const { encodeCursor, decodeCursor } = require('../src/util');

let server;
let base;
let adminKey;

before(async () => {
  await store.init();
  const app = createApp({ store });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = 'http://127.0.0.1:' + server.address().port;
  // The very first key is the bootstrap key; every later key is created
  // with it.
  const boot = await req('POST', '/v1/keys', { body: { name: 'root' } });
  adminKey = boot.body.key.key;
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

async function newKey(name, scopes) {
  const res = await req('POST', '/v1/keys', { key: adminKey, body: { name: name || 'key', scopes } });
  if (res.status !== 201) throw new Error('key creation failed: ' + res.status + ' ' + JSON.stringify(res.body));
  return res.body.key.key;
}

/** A key that belongs to a *different* organization. */
async function otherTenantKey(name) {
  const org = await store.createOrganization(name);
  const created = await store.createKey({ name: name, organizationId: org.id });
  return created.key;
}

test('scopes: a write scope is required for mutations', async () => {
  const admin = adminKey;
  const roKey = await newKey('read-only', ['events:read', 'endpoints:read', 'deliveries:read']);

  // Reads are allowed.
  const list = await req('GET', '/v1/events', { key: roKey });
  assert.equal(list.status, 200);

  // Writes are denied with 403 (not 401 - the key is valid, just unscoped).
  const write = await req('POST', '/v1/events', { key: roKey, body: { event_type: 'x' } });
  assert.equal(write.status, 403);
  assert.equal(write.body.error.code, 'forbidden');

  const create = await req('POST', '/v1/endpoints', { key: roKey, body: { name: 'n', url: 'http://127.0.0.1:9/x' } });
  assert.equal(create.status, 403);

  // An admin key still works.
  const adminWrite = await req('POST', '/v1/events', { key: admin, body: { event_type: 'x' } });
  assert.equal(adminWrite.status, 202);
});

test('scopes: unknown scopes are rejected and an empty scope list grants nothing', async () => {
  const bad = await req('POST', '/v1/keys', { key: adminKey, body: { name: 'bad', scopes: ['superuser'] } });
  assert.equal(bad.status, 422);

  const empty = await req('POST', '/v1/keys', { key: adminKey, body: { name: 'empty', scopes: [] } });
  assert.equal(empty.status, 201);
  assert.deepEqual(empty.body.key.scopes, []);
  const denied = await req('GET', '/v1/events', { key: empty.body.key.key });
  assert.equal(denied.status, 403);
});

test('scopes: write scope implies read scope, admin implies everything', () => {
  assert.equal(hasScope({ scopes: ['events:write'] }, 'events:read'), true);
  assert.equal(hasScope({ scopes: ['admin'] }, 'deliveries:write'), true);
  assert.equal(hasScope({ scopes: ['events:read'] }, 'events:write'), false);
  // Legacy keys without scopes keep full access.
  assert.equal(hasScope({ id: 'k' }, 'events:write'), true);
  assert.deepEqual(normalizeScopes(undefined), ['admin']);
});

test('attempts are readable through the API', async () => {
  const key = adminKey;
  const ep = await req('POST', '/v1/endpoints', {
    key,
    body: { name: 'hook', url: base + '/demo/orders', event_types: ['a'] },
  });
  assert.equal(ep.status, 201);

  const evt = await req('POST', '/v1/events', { key, body: { event_type: 'a', data: { n: 1 } } });
  assert.equal(evt.status, 202);

  const deliveries = await req('GET', '/v1/deliveries', { key });
  assert.equal(deliveries.body.total, 1);
  const deliveryId = deliveries.body.data[0].id;

  // No attempts yet - the worker has not run.
  const empty = await req('GET', '/v1/deliveries/' + deliveryId + '/attempts', { key });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, []);

  // Run one attempt and the attempt becomes visible.
  const worker = require('../src/worker').createWorker(store, { workerId: 'w-attempts', concurrency: 1 });
  const claimed = await store.claimDueDelivery('w-attempts', 30000);
  assert.ok(claimed);
  await worker.runAttempt(claimed);

  const attempts = await req('GET', '/v1/deliveries/' + deliveryId + '/attempts', { key });
  assert.equal(attempts.status, 200);
  assert.equal(attempts.body.total, 1);
  assert.equal(attempts.body.data[0].attempt_number, 1);
  assert.equal(attempts.body.data[0].status_code, 200);
  assert.equal(attempts.body.data[0].error_class, null);

  // Attempts are also embedded in the delivery detail.
  const detail = await req('GET', '/v1/deliveries/' + deliveryId, { key });
  assert.equal(detail.body.attempts.length, 1);

  // Cross-tenant access is a 404, not a 403 (no existence leak).
  const other = await otherTenantKey('attempts-other');
  const cross = await req('GET', '/v1/deliveries/' + deliveryId + '/attempts', { key: other });
  assert.equal(cross.status, 404);
});

test('expired idempotency keys are released', async () => {
  const org = await store.createOrganization('idem-ttl');
  const now = new Date().toISOString();
  const expired = {
    organizationId: org.id,
    operation: 'events',
    key: 'expired-key',
    requestHash: 'hash-old',
    responseBody: { event_id: 'evt_old' },
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  const first = await store.ingestEvent({
    event: { id: 'evt_old', organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: [] },
    deliveries: [],
    idempotency: expired,
  });
  assert.equal(first.status, 'created');

  // The same key with a different payload must NOT conflict now that the
  // record has expired - the key is free to be reused.
  const second = await store.ingestEvent({
    event: { id: 'evt_new', organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: [] },
    deliveries: [],
    idempotency: Object.assign({}, expired, { requestHash: 'hash-new', responseBody: { event_id: 'evt_new' } }),
  });
  assert.equal(second.status, 'created');
  assert.equal(second.event.id, 'evt_new');
});

test('cursor pagination does not skip rows that share a timestamp', async () => {
  const org = await store.createOrganization('cursor');
  const createdAt = new Date().toISOString();
  // 10 events, all with the *same* created_at.
  for (let i = 0; i < 10; i++) {
    await store.ingestEvent({
      event: { id: 'evt_' + String(i).padStart(2, '0'), organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt, deliveries: [] },
      deliveries: [],
      idempotency: null,
    });
  }

  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const result = await store.listEvents({ organizationId: org.id, limit: 3, cursor });
    for (const row of result.data) {
      assert.equal(row.createdAt, createdAt);
      assert.ok(!seen.has(row.id), 'row returned twice: ' + row.id);
      seen.add(row.id);
    }
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  assert.equal(seen.size, 10, 'every row must be reachable exactly once');
});

test('cursor encodes and decodes a stable (created_at, id) pair', () => {
  const cursor = encodeCursor('2026-01-01T00:00:00.000Z', 'evt_1');
  assert.equal(typeof cursor, 'string');
  assert.ok(!cursor.includes('evt_1'), 'cursor should be opaque');
  const decoded = decodeCursor(cursor);
  assert.equal(decoded.c, '2026-01-01T00:00:00.000Z');
  assert.equal(decoded.i, 'evt_1');
  assert.equal(decodeCursor('not-a-cursor'), null);
});

test('endpoint timeout and attempt count are capped', async () => {
  const key = adminKey;
  const tooLong = await req('POST', '/v1/endpoints', {
    key,
    body: { name: 'slow', url: 'http://127.0.0.1:9/x', timeout_seconds: 600 },
  });
  assert.equal(tooLong.status, 422);
  assert.match(tooLong.body.error.message, /timeout_seconds/);

  const tooManyAttempts = await req('POST', '/v1/endpoints', {
    key,
    body: { name: 'many', url: 'http://127.0.0.1:9/x', max_attempts: 1000 },
  });
  assert.equal(tooManyAttempts.status, 422);
  assert.match(tooManyAttempts.body.error.message, /max_attempts/);
});

test('lease renewal keeps a long-running delivery claimed', async () => {
  const org = await store.createOrganization('lease');
  const now = new Date().toISOString();
  const ep = await store.insertEndpoint({
    id: 'ep_lease',
    organizationId: org.id,
    name: 'lease',
    url: 'http://127.0.0.1:9/x',
    eventTypes: ['x'],
    active: true,
    signingSecret: 'plain:whsec_x',
    timeoutMs: 1000,
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  const event = { id: 'evt_lease', organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: ['dlv_lease'] };
  const delivery = {
    id: 'dlv_lease',
    organizationId: org.id,
    eventId: event.id,
    eventType: 'x',
    endpointId: ep.id,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: now,
    lastStatusCode: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    attempts: [],
  };
  await store.ingestEvent({ event, deliveries: [delivery], idempotency: null });

  const claimed = await store.claimDueDelivery('w-lease', 50);
  assert.ok(claimed);
  assert.equal(claimed.lockedBy, 'w-lease');

  // Another worker must not be able to steal it while the lease is valid.
  const stolen = await store.claimDueDelivery('w-other', 50);
  assert.equal(stolen, null);

  // Renewal extends the lease so a slow attempt is not double-delivered.
  const renewed = await store.renewLease('dlv_lease', 'w-lease', 5000);
  assert.equal(renewed, true);
  await new Promise((r) => setTimeout(r, 80));
  const afterExpiry = await store.claimDueDelivery('w-other', 50);
  assert.equal(afterExpiry, null, 'a renewed lease must not be reclaimable');

  // A worker that does not hold the lease cannot renew it.
  assert.equal(await store.renewLease('dlv_lease', 'w-other', 5000), false);
});

test('expired idempotency records are swept', async () => {
  const org = await store.createOrganization('sweep');
  const now = new Date().toISOString();
  await store.ingestEvent({
    event: { id: 'evt_sweep', organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: [] },
    deliveries: [],
    idempotency: { organizationId: org.id, operation: 'events', key: 'sweep-key', requestHash: 'h', responseBody: {}, expiresAt: new Date(Date.now() - 1000).toISOString() },
  });
  const result = await store.sweepExpired({});
  assert.ok(result.idempotencyRemoved >= 1);
});
