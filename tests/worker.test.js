'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../src/worker');
const store = require('../src/store');

test('backoff delay is bounded by base delay and exponential cap', () => {
  for (let i = 0; i < 25; i++) {
    const delay = worker.computeBackoffMs(1, 1000, 30000);
    assert.ok(delay >= 0 && delay <= 1000, 'first attempt backoff within base delay');
  }
  for (let i = 0; i < 25; i++) {
    const delay = worker.computeBackoffMs(5, 1000, 30000);
    assert.ok(delay <= 1000 * Math.pow(2, 4), 'fifth attempt backoff within exponential cap');
  }
});

test('retryable status classification matches expected set', () => {
  assert.equal(worker.RETRYABLE_STATUS.has(408), true);
  assert.equal(worker.RETRYABLE_STATUS.has(429), true);
  assert.equal(worker.RETRYABLE_STATUS.has(500), true);
  assert.equal(worker.RETRYABLE_STATUS.has(404), false);
});

test('claimDueDelivery claims oldest due delivery', () => {
  store.state.deliveries.length = 0;
  const now = new Date().toISOString();
  store.state.deliveries.push({ id: 'dlv_test_1', status: 'pending', attemptCount: 0, nextAttemptAt: now, createdAt: now, lockedUntil: null });
  store.state.deliveries.push({ id: 'dlv_test_2', status: 'retry_scheduled', attemptCount: 1, nextAttemptAt: new Date(Date.now() + 60000).toISOString(), createdAt: now, lockedUntil: null });
  const claimed = worker.claimDueDelivery();
  assert.ok(claimed, 'expected a claimable delivery');
  assert.equal(claimed.id, 'dlv_test_1');
});