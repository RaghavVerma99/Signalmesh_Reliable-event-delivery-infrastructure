'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJsonStore } = require('../src/store');
const { createWorker, computeBackoffMs, RETRYABLE_STATUS } = require('../src/worker');

function tempStore() {
  const dataFile = path.join(os.tmpdir(), 'signalmesh-worker-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  return { store: createJsonStore({ dataFile }), dataFile };
}

async function seedDelivery(store, url) {
  const now = new Date().toISOString();
  const org = await store.createOrganization('test');
  const ep = await store.insertEndpoint({
    id: 'ep_test',
    organizationId: org.id,
    name: 'test',
    url: url || 'http://127.0.0.1:9/never',
    eventTypes: ['x'],
    active: true,
    signingSecret: 'plain:whsec_test',
    timeoutMs: 1000,
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  const event = { id: 'evt_test', organizationId: org.id, eventType: 'x', data: {}, occurredAt: null, metadata: {}, createdAt: now, deliveries: ['dlv_test'] };
  const delivery = {
    id: 'dlv_test',
    organizationId: org.id,
    eventId: event.id,
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
  };
  await store.ingestEvent({ event, deliveries: [delivery], idempotency: null });
  return { org, ep, event, delivery };
}

function attempt(number, statusCode) {
  const now = new Date().toISOString();
  return { attemptNumber: number, startedAt: now, finishedAt: now, statusCode, durationMs: 5, errorClass: null, responseExcerpt: null };
}

test('backoff delay is bounded by base delay and exponential cap', () => {
  for (let i = 0; i < 25; i++) {
    const delay = computeBackoffMs(1, 1000, 30000);
    assert.ok(delay >= 0 && delay <= 1000);
  }
  for (let i = 0; i < 25; i++) {
    const delay = computeBackoffMs(5, 1000, 30000);
    assert.ok(delay <= 1000 * Math.pow(2, 4));
  }
});

test('retryable status classification matches expected set', () => {
  assert.equal(RETRYABLE_STATUS.has(408), true);
  assert.equal(RETRYABLE_STATUS.has(429), true);
  assert.equal(RETRYABLE_STATUS.has(500), true);
  assert.equal(RETRYABLE_STATUS.has(404), false);
});

test('claim marks processing and recordAttempt schedules a retry', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    await seedDelivery(store);
    const worker = createWorker(store, { workerId: 'w1', concurrency: 1, leaseMs: 1000 });

    const claimed = await store.claimDueDelivery('w1', 1000);
    assert.ok(claimed);
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.lockedBy, 'w1');

    const retry = await store.recordAttempt({
      deliveryId: claimed.id,
      workerId: 'w1',
      attempt: attempt(1, 500),
      outcome: { type: 'retry', error: 'http_500', statusCode: 500, delayMs: 0 },
    });
    assert.equal(retry.delivery.status, 'retry_scheduled');
    assert.equal(retry.dead, false);

    await new Promise((r) => setTimeout(r, 10));
    const claimedAgain = await store.claimDueDelivery('w1', 1000);
    assert.ok(claimedAgain);
    const ok = await store.recordAttempt({
      deliveryId: claimedAgain.id,
      workerId: 'w1',
      attempt: attempt(2, 200),
      outcome: { type: 'succeeded', error: null, statusCode: 200 },
    });
    assert.equal(ok.delivery.status, 'succeeded');
    assert.equal(ok.delivery.attemptCount, 2);
    void worker;
  } finally {
    try {
      fs.unlinkSync(dataFile);
    } catch {
      /* ignore */
    }
  }
});

test('a stale worker cannot overwrite a newer claim', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    await seedDelivery(store);
    await store.claimDueDelivery('worker-a', 1000);
    const stale = await store.recordAttempt({
      deliveryId: 'dlv_test',
      workerId: 'worker-b',
      attempt: attempt(1, 200),
      outcome: { type: 'succeeded', error: null, statusCode: 200 },
    });
    assert.equal(stale.stale, true);
    const current = await store.getDelivery('dlv_test', null);
    assert.equal(current.delivery.status, 'processing');
  } finally {
    try {
      fs.unlinkSync(dataFile);
    } catch {
      /* ignore */
    }
  }
});

test('worker dead-letters a destination that fails the SSRF check', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    const seeded = await seedDelivery(store, 'http://10.0.0.5/hook');
    const worker = createWorker(store, { workerId: 'w-ssrf' });
    const result = await worker.runAttempt(seeded.delivery);
    assert.equal(result.delivery.status, 'dead_lettered');
    assert.equal(result.delivery.lastError, 'destination_blocked');
  } finally {
    try {
      fs.unlinkSync(dataFile);
    } catch {
      /* ignore */
    }
  }
});
