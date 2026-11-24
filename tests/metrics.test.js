'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('../src/metrics');

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function sample() {
  const values = new Map();
  for (const line of metrics.renderPrometheus().split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const split = line.lastIndexOf(' ');
    values.set(line.slice(0, split), Number(line.slice(split + 1)));
  }
  return values;
}

test('duration histogram buckets are cumulative and end at the observation count', () => {
  const before = sample();
  metrics.observeDuration(0.3);
  metrics.observeDuration(2);
  const after = sample();

  const delta = (name) => (after.get(name) || 0) - (before.get(name) || 0);
  for (const bucket of BUCKETS) {
    const expected = (0.3 <= bucket ? 1 : 0) + (2 <= bucket ? 1 : 0);
    assert.equal(delta(`delivery_duration_seconds_bucket{le="${bucket}"}`), expected, `bucket ${bucket}`);
  }
  assert.equal(delta('delivery_duration_seconds_bucket{le="+Inf"}'), 2);
  assert.equal(delta('delivery_duration_seconds_count'), 2);

  // Monotonicity is the property Prometheus relies on for quantiles.
  const counts = BUCKETS.map((b) => after.get(`delivery_duration_seconds_bucket{le="${b}"}`));
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] >= counts[i - 1], `bucket ${BUCKETS[i]} must include all smaller buckets`);
  }
});
