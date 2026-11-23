'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createJsonStore } = require('../src/store');
const { createWorker, computeBackoffMs, RETRYABLE_STATUS } = require('../src/worker');
const metrics = require('../src/metrics');

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

test('expired leases are reclaimed and the delivery becomes claimable again', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    await seedDelivery(store);
    await store.claimDueDelivery('dead-worker', 5);
    await new Promise((r) => setTimeout(r, 20));

    // Claiming still skips a `processing` row even after its lease expires.
    assert.equal(await store.claimDueDelivery('live-worker', 1000), null);
    assert.equal(await store.reclaimExpiredLeases(), 1);

    const recovered = (await store.getDelivery('dlv_test', null)).delivery;
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.lockedBy, null);
    assert.equal(recovered.lockedUntil, null);
    assert.equal(recovered.attemptCount, 0, 'attempt history is preserved, not reset');

    const claimed = await store.claimDueDelivery('live-worker', 1000);
    assert.ok(claimed);
    assert.equal(claimed.lockedBy, 'live-worker');
    assert.equal(await store.reclaimExpiredLeases(), 0, 'live leases must not be reclaimed');
  } finally {
    try {
      fs.unlinkSync(dataFile);
    } catch {
      /* ignore */
    }
  }
});

test('worker tick reclaims expired leases before claiming new work', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    let calls = 0;
    const spy = Object.assign({}, store, {
      reclaimExpiredLeases: async () => {
        calls++;
        return 0;
      },
    });
    const worker = createWorker(spy, { workerId: 'w-tick' });
    await worker.tick();
    assert.equal(calls, 1);
  } finally {
    try {
      fs.unlinkSync(dataFile);
    } catch {
      /* ignore */
    }
  }
});

test('a stale attempt is not counted as a successful delivery', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    await seedDelivery(store);
    await store.claimDueDelivery('worker-a', 30000);

    const successCounter = () => Number((metrics.renderPrometheus().match(/^delivery_success_total (\d+)$/m) || [])[1] || 0);
    const before = successCounter();
    const worker = createWorker(store, { workerId: 'worker-b' });
    const result = await worker.runAttempt((await store.getDelivery('dlv_test', null)).delivery);
    assert.equal(result.stale, true);
    assert.equal(successCounter(), before, 'stale attempts must not increment delivery_success_total');
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

test('drain waits for an in-flight tick started by the interval', async () => {
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    const queueMetrics = store.queueMetrics.bind(store);
    const slowStore = Object.assign({}, store, {
      queueMetrics: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return queueMetrics();
      },
    });
    const worker = createWorker(slowStore, { workerId: 'w-drain', pollIntervalMs: 40 });
    worker.start();
    // The first tick is inside queueMetrics; a second interval has already
    // fired and (previously) replaced inFlight with a resolved promise.
    await new Promise((r) => setTimeout(r, 100));
    worker.stop();
    const started = Date.now();
    await worker.drain();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30, `drain returned after ${elapsed}ms while the tick was still running`);
  } finally {
    try {
      fs.unlinkSync(dataFile);
    } catch {
      /* ignore */
    }
  }
});

test('a hard deadline stops a slow-drip response from holding a worker slot', { timeout: 5000 }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const write = () => {
      try {
        res.write('x');
      } catch {
        /* socket already closed */
      }
    };
    write();
    const interval = setInterval(write, 20);
    req.on('close', () => clearInterval(interval));
    res.on('error', () => clearInterval(interval));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { store, dataFile } = tempStore();
  try {
    await store.init();
    const seeded = await seedDelivery(store, 'http://127.0.0.1:' + port + '/hook');
    await store.updateEndpoint(seeded.ep.id, seeded.org.id, { timeoutMs: 120 });
    const worker = createWorker(store, { workerId: 'w-deadline' });
    const delivery = (await store.getDelivery('dlv_test', null)).delivery;
    const started = Date.now();
    const result = await worker.runAttempt(delivery);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, 'the slow endpoint should have been contacted');
    assert.ok(elapsed < 2000, `the hard deadline should bound the attempt, took ${elapsed}ms`);
    assert.equal(result.delivery.lastError, 'timeout');
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.unlinkSync(dataFile);
    } catch {
      /* ignore */
    }
  }
});
