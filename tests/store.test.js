'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJsonStore } = require('../src/store');

function tempStore() {
  const dataFile = path.join(os.tmpdir(), 'signalmesh-store-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  return { store: createJsonStore({ dataFile }), dataFile };
}

function endpoint(orgId, id) {
  const now = new Date().toISOString();
  return {
    id,
    organizationId: orgId,
    name: id,
    url: 'http://127.0.0.1:9/hook',
    eventTypes: ['*'],
    active: true,
    signingSecret: 'plain:whsec_x',
    timeoutMs: 1000,
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function delivery(orgId, eventId, endpointId, id) {
  const now = new Date().toISOString();
  return {
    id,
    organizationId: orgId,
    eventId,
    eventType: 'x',
    endpointId,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: now,
    lastStatusCode: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    attempts: [],
  };
}

test('tenant isolation scopes events, endpoints and deliveries', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    const a = await store.createOrganization('a');
    const b = await store.createOrganization('b');
    await store.insertEndpoint(endpoint(a.id, 'ep_a'));
    await store.insertEndpoint(endpoint(b.id, 'ep_b'));

    const now = new Date().toISOString();
    await store.ingestEvent({
      event: { id: 'evt_a', organizationId: a.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: ['dlv_a'] },
      deliveries: [delivery(a.id, 'evt_a', 'ep_a', 'dlv_a')],
      idempotency: null,
    });

    const aEndpoints = await store.listEndpoints(a.id);
    assert.equal(aEndpoints.length, 1);
    assert.equal(aEndpoints[0].id, 'ep_a');
    const bEndpoints = await store.listEndpoints(b.id);
    assert.equal(bEndpoints.length, 1);
    assert.equal(bEndpoints[0].id, 'ep_b');
    assert.equal((await store.listEvents({ organizationId: a.id })).total, 1);
    assert.equal((await store.listEvents({ organizationId: b.id })).total, 0);
    assert.equal((await store.listDeliveries({ organizationId: b.id })).total, 0);
    assert.equal(await store.getDelivery('dlv_a', b.id), null);
    assert.equal(await store.getEndpoint('ep_a', b.id), null);
    assert.equal(await store.getEndpoint('ep_b', a.id), null);
  } finally {
    try { fs.unlinkSync(dataFile); } catch (e) { /* ignore */ }
  }
});

test('idempotent ingest returns duplicate for same hash and conflict for a different hash', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    const org = await store.createOrganization('a');
    const now = new Date().toISOString();
    const base = {
      event: { id: 'evt_1', organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: [] },
      deliveries: [],
      idempotency: { organizationId: org.id, operation: 'events', key: 'k1', requestHash: 'hash-1', responseBody: { event_id: 'evt_1' } },
    };
    const first = await store.ingestEvent(base);
    assert.equal(first.status, 'created');

    const dup = await store.ingestEvent(Object.assign({}, base, {
      event: Object.assign({}, base.event, { id: 'evt_2' }),
      idempotency: Object.assign({}, base.idempotency, { requestHash: 'hash-1', responseBody: { event_id: 'evt_2' } }),
    }));
    assert.equal(dup.status, 'duplicate');
    assert.equal(dup.responseBody.event_id, 'evt_1');

    const conflict = await store.ingestEvent(Object.assign({}, base, {
      event: Object.assign({}, base.event, { id: 'evt_3' }),
      idempotency: Object.assign({}, base.idempotency, { requestHash: 'hash-2', responseBody: { event_id: 'evt_3' } }),
    }));
    assert.equal(conflict.status, 'conflict');
  } finally {
    try { fs.unlinkSync(dataFile); } catch (e) { /* ignore */ }
  }
});

test('event listing paginates with a cursor', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    const org = await store.createOrganization('a');
    for (let i = 0; i < 3; i++) {
      await store.ingestEvent({
        event: { id: 'evt_' + i, organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: new Date(Date.now() + i).toISOString(), deliveries: [] },
        deliveries: [],
        idempotency: null,
      });
    }
    const first = await store.listEvents({ organizationId: org.id, limit: 2 });
    assert.equal(first.data.length, 2);
    assert.ok(first.next_cursor);
    const second = await store.listEvents({ organizationId: org.id, limit: 2, cursor: first.next_cursor });
    assert.equal(second.data.length, 1);
  } finally {
    try { fs.unlinkSync(dataFile); } catch (e) { /* ignore */ }
  }
});

test('audit log is tenant scoped', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    const a = await store.createOrganization('a');
    const b = await store.createOrganization('b');
    await store.appendAudit({ organizationId: a.id, action: 'endpoint.created', resourceType: 'endpoint', resourceId: 'ep_a' });
    assert.equal((await store.listAudit({ organizationId: a.id })).total, 1);
    assert.equal((await store.listAudit({ organizationId: b.id })).total, 0);
  } finally {
    try { fs.unlinkSync(dataFile); } catch (e) { /* ignore */ }
  }
});

test('rotateEndpointSecret preserves the previous secret and is tenant scoped', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    const a = await store.createOrganization('a');
    const b = await store.createOrganization('b');
    await store.insertEndpoint(endpoint(a.id, 'ep_rotate'));

    const rotated = await store.rotateEndpointSecret('ep_rotate', a.id, 'enc:new-secret');
    assert.equal(rotated.signingSecret, 'enc:new-secret');
    assert.equal(rotated.signingSecretPrevious, 'plain:whsec_x');

    const crossTenant = await store.rotateEndpointSecret('ep_rotate', b.id, 'enc:hijack');
    assert.equal(crossTenant, null);
  } finally {
    try { fs.unlinkSync(dataFile); } catch (e) { /* ignore */ }
  }
});
