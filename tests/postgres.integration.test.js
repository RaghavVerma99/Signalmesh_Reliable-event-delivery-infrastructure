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
      deliveries: [
        {
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
        },
      ],
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

    // Attempt history is readable through the store.
    const attempts = await store.listAttempts(deliveryId, org.id);
    assert.ok(Array.isArray(attempts));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].attempt_number, 1);
    assert.equal(attempts[0].status_code, 200);

    // Attempt history is tenant scoped.
    const otherOrg = await store.createOrganization('pg-other-' + suffix);
    assert.equal(await store.listAttempts(deliveryId, otherOrg.id), null);

    // Aggregated delivery counts (used by GET /v1/events).
    const counts = await store.countDeliveriesForEvents([eventId], org.id);
    assert.equal(counts.get(eventId), 1);

    // Lease renewal keeps a claimed delivery out of reach of other workers.
    const renewed = await store.renewLease(deliveryId, 'pg-worker', 5000);
    assert.equal(renewed, true);
    assert.equal(await store.renewLease(deliveryId, 'someone-else', 5000), false);

    // Keyset pagination over rows that share a created_at value.
    const shared = new Date().toISOString();
    const sharedIds = [];
    for (let i = 0; i < 6; i++) {
      const id = 'evt_pg_shared_' + suffix + '_' + i;
      sharedIds.push(id);
      await store.ingestEvent({
        event: { id, organizationId: org.id, eventType: 'shared', data: {}, occurredAt: null, metadata: {}, createdAt: shared, deliveries: [] },
        deliveries: [],
        idempotency: null,
      });
    }
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const result = await store.listEvents({ organizationId: org.id, eventType: 'shared', limit: 2, cursor });
      for (const row of result.data) {
        assert.ok(!seen.has(row.id), 'row returned twice: ' + row.id);
        seen.add(row.id);
      }
      cursor = result.next_cursor;
      if (!cursor) break;
    }
    assert.equal(seen.size, 6, 'every shared-timestamp row must be reachable exactly once');

    // Expired idempotency records are released and swept.
    const expiredKey = 'pg-expired-' + suffix;
    await store.ingestEvent({
      event: { id: 'evt_pg_exp_' + suffix, organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: [] },
      deliveries: [],
      idempotency: { organizationId: org.id, operation: 'events', key: expiredKey, requestHash: 'h2', responseStatus: 202, responseBody: {}, expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const reused = await store.ingestEvent({
      event: { id: 'evt_pg_exp2_' + suffix, organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: [] },
      deliveries: [],
      idempotency: { organizationId: org.id, operation: 'events', key: expiredKey, requestHash: 'h3', responseStatus: 202, responseBody: {}, expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    assert.equal(reused.status, 'created', 'an expired idempotency key must be reusable');

    const swept = await store.sweepExpired({});
    assert.ok(swept.idempotencyRemoved >= 0);
  } finally {
    await store.close();
  }
});
