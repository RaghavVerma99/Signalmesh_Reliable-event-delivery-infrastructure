'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPostgresStore } = require('../src/store');

// Runs only when a real PostgreSQL is provided (e.g. CI service container):
//   SIGNALMESH_TEST_PG_URL=postgres://user:pass@localhost:5432/db node --test
const pgUrl = process.env.SIGNALMESH_TEST_PG_URL;

test('postgres store: durable ingest, tenant scoping, claim and attempt', { skip: !pgUrl }, async () => {
  const store = createPostgresStore({ connectionString: pgUrl });
  await store.init();
  try {
    const suffix = Date.now().toString(36) + Math.random().toString(16).slice(2);
    const org = await store.createOrganization('pg-' + suffix);
    const created = await store.createKey({ name: 'pg', organizationId: org.id });
    assert.ok(created.key.startsWith('rel_'));

    const found = await store.findKeyByToken(created.key);
    assert.equal(found.organizationId, org.id);

    const now = new Date().toISOString();
    const ep = await store.insertEndpoint({
      id: 'ep_pg_' + suffix,
      organizationId: org.id,
      name: 'pg',
      url: 'http://127.0.0.1:9/hook',
      eventTypes: ['*'],
      active: true,
      signingSecret: 'plain:whsec_pg',
      timeoutMs: 1000,
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    assert.equal(ep.id, 'ep_pg_' + suffix);

    const eventId = 'evt_pg_' + suffix;
    const deliveryId = 'dlv_pg_' + suffix;
    const result = await store.ingestEvent({
      event: { id: eventId, organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: [deliveryId] },
      deliveries: [{
        id: deliveryId,
        organizationId: org.id,
        eventId,
        eventType: 'x',
        endpointId: ep.id,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
        lastStatusCode: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        attempts: [],
      }],
      idempotency: { organizationId: org.id, operation: 'events', key: 'pg-key-' + suffix, requestHash: 'h', responseStatus: 202, responseBody: { event_id: eventId } },
    });
    assert.equal(result.status, 'created');

    const dup = await store.ingestEvent({
      event: { id: 'evt_pg_dup_' + suffix, organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: [] },
      deliveries: [],
      idempotency: { organizationId: org.id, operation: 'events', key: 'pg-key-' + suffix, requestHash: 'h', responseStatus: 202, responseBody: { event_id: eventId } },
    });
    assert.equal(dup.status, 'duplicate');

    assert.equal((await store.listEvents({ organizationId: org.id })).total, 1);
    assert.equal((await store.listDeliveries({ organizationId: org.id })).total, 1);

    const claimed = await store.claimDueDelivery('pg-worker', 1000);
    assert.ok(claimed);
    assert.equal(claimed.status, 'processing');

    const recorded = await store.recordAttempt({
      deliveryId: claimed.id,
      workerId: 'pg-worker',
      attempt: { attemptNumber: 1, startedAt: now, finishedAt: now, statusCode: 200, durationMs: 3, errorClass: null, responseExcerpt: null },
      outcome: { type: 'succeeded', error: null, statusCode: 200 },
    });
    assert.equal(recorded.delivery.status, 'succeeded');
  } finally {
    await store.close();
  }
});
