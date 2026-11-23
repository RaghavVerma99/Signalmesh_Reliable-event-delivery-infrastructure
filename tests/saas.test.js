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

let seedCounter = 0;

/** Create an endpoint + event through the API and return its delivery id. */
async function seedApiDelivery(key) {
  const n = ++seedCounter;
  const eventType = 'cancel.replay.' + n;
  const ep = await req('POST', '/v1/endpoints', {
    key,
    body: { name: 'hooks-' + n, url: base + '/demo/orders', event_types: [eventType] },
  });
  assert.equal(ep.status, 201);
  const evt = await req('POST', '/v1/events', { key, body: { event_type: eventType, data: { n } } });
  assert.equal(evt.status, 202);
  const list = await req('GET', '/v1/deliveries?event_id=' + evt.body.event_id, { key });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  return { id: list.body.data[0].id, eventId: evt.body.event_id };
}

async function setDeliveryStatus(id, status) {
  const found = await store.getDelivery(id, null);
  assert.ok(found, 'delivery must exist: ' + id);
  await store.updateDelivery(id, found.delivery.organizationId, { status });
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

test('scopes: keys:write cannot mint an admin key', async () => {
  const manager = await newKey('key-manager', ['keys:write']);

  // Omitting scopes used to default to `admin` for every caller.
  const implicit = await req('POST', '/v1/keys', { key: manager, body: { name: 'implicit' } });
  assert.equal(implicit.status, 201);
  assert.deepEqual(implicit.body.key.scopes, ['keys:write', 'keys:read']);

  // Explicitly requesting a scope the caller does not hold is also denied.
  const explicit = await req('POST', '/v1/keys', { key: manager, body: { name: 'escalated', scopes: ['admin'] } });
  assert.equal(explicit.status, 403);
  assert.equal(explicit.body.error.code, 'forbidden');

  const denied = await req('GET', '/v1/audit', { key: implicit.body.key.key });
  assert.equal(denied.status, 403, 'the delegated key must not inherit audit access');

  // An admin key can still grant any valid scope.
  const byAdmin = await req('POST', '/v1/keys', { key: adminKey, body: { name: 'admin-created', scopes: ['audit:read'] } });
  assert.equal(byAdmin.status, 201);
  assert.deepEqual(byAdmin.body.key.scopes, ['audit:read']);
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

test('replay is restricted to terminal outcomes and creates one new generation', async () => {
  const { id, eventId } = await seedApiDelivery(adminKey);

  const pending = await req('POST', '/v1/deliveries/' + id + '/replay', { key: adminKey });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.error.code, 'conflict');

  await setDeliveryStatus(id, 'retry_scheduled');
  const retrying = await req('POST', '/v1/deliveries/' + id + '/replay', { key: adminKey });
  assert.equal(retrying.status, 409, 'replaying a scheduled retry would double-deliver');

  await setDeliveryStatus(id, 'dead_lettered');
  const replayed = await req('POST', '/v1/deliveries/' + id + '/replay', { key: adminKey, body: { reason: 'operator retry' } });
  assert.equal(replayed.status, 202);
  assert.equal(replayed.body.replay_of, id);
  assert.equal(replayed.body.reason, 'operator retry');
  assert.notEqual(replayed.body.delivery_id, id);

  const list = await req('GET', '/v1/deliveries?event_id=' + eventId, { key: adminKey });
  assert.equal(list.body.total, 2, 'exactly one replay generation is created');

  await setDeliveryStatus(id, 'cancelled');
  const cancelled = await req('POST', '/v1/deliveries/' + id + '/replay', { key: adminKey });
  assert.equal(cancelled.status, 409, 'cancelled deliveries must stay cancelled');

  const other = await otherTenantKey('replay-other');
  const cross = await req('POST', '/v1/deliveries/' + id + '/replay', { key: other });
  assert.equal(cross.status, 404);
});

test('cancel is atomic, idempotent for terminal states, and cooperative in flight', async () => {
  const pendingSeed = await seedApiDelivery(adminKey);
  const cancelled = await req('POST', '/v1/deliveries/' + pendingSeed.id + '/cancel', { key: adminKey });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await store.getDelivery(pendingSeed.id, null)).delivery.status, 'cancelled');

  const again = await req('POST', '/v1/deliveries/' + pendingSeed.id + '/cancel', { key: adminKey });
  assert.equal(again.status, 200, 'cancelling a terminal delivery is a no-op');

  const retrySeed = await seedApiDelivery(adminKey);
  await setDeliveryStatus(retrySeed.id, 'retry_scheduled');
  const retryCancel = await req('POST', '/v1/deliveries/' + retrySeed.id + '/cancel', { key: adminKey });
  assert.equal(retryCancel.status, 200);
  assert.equal(retryCancel.body.status, 'cancelled');

  // A late worker outcome must not resurrect a cancelled delivery.
  const attempt = {
    attemptNumber: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    statusCode: null,
    durationMs: 1,
    errorClass: 'network',
    responseExcerpt: null,
  };
  const late = await store.recordAttempt({
    deliveryId: retrySeed.id,
    workerId: 'w-late',
    attempt,
    outcome: { type: 'retry', error: 'network', delayMs: 1000 },
  });
  assert.equal(late.cancelled, true);
  assert.equal(late.delivery.status, 'cancelled');
  assert.equal(late.delivery.attempts.length, 0, 'a cancelled delivery records no new attempt');

  const inFlight = await seedApiDelivery(adminKey);
  await setDeliveryStatus(inFlight.id, 'processing');
  const requested = await req('POST', '/v1/deliveries/' + inFlight.id + '/cancel', { key: adminKey });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.cancellation_requested, true);
  assert.equal(requested.body.status, 'processing');
  assert.equal((await store.getDelivery(inFlight.id, null)).delivery.cancelRequested, true);

  const retryResult = await store.recordAttempt({
    deliveryId: inFlight.id,
    workerId: 'w-in-flight',
    attempt,
    outcome: { type: 'retry', error: 'network', delayMs: 1000 },
  });
  assert.equal(retryResult.delivery.status, 'cancelled', 'a flag stop further retries without interrupting the request');

  const succeededSeed = await seedApiDelivery(adminKey);
  await setDeliveryStatus(succeededSeed.id, 'processing');
  await req('POST', '/v1/deliveries/' + succeededSeed.id + '/cancel', { key: adminKey });
  const successResult = await store.recordAttempt({
    deliveryId: succeededSeed.id,
    workerId: 'w-in-flight-2',
    attempt,
    outcome: { type: 'succeeded', statusCode: 200, error: null },
  });
  assert.equal(successResult.delivery.status, 'succeeded', 'a completed HTTP request is recorded truthfully');
});
