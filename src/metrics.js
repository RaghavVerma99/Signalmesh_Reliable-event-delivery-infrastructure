'use strict';

const COUNTER_KEYS = [
  'http_requests_total',
  'events_accepted_total',
  'events_ingest_errors_total',
  'deliveries_created_total',
  'delivery_attempts_total',
  'delivery_success_total',
  'delivery_dead_letter_total',
];

const GAUGE_KEYS = ['queue_depth', 'oldest_pending_age_seconds', 'worker_active_count', 'worker_last_tick_timestamp_seconds'];

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const counters = {};
for (const key of COUNTER_KEYS) {
  counters[key] = 0;
}

const gauges = {};
for (const key of GAUGE_KEYS) {
  gauges[key] = 0;
}

const durationBucketCounts = {};
for (const bucket of DURATION_BUCKETS) {
  durationBucketCounts[bucket] = 0;
}
const durationSum = { value: 0 };
const durationCount = { value: 0 };

function inc(key, n) {
  counters[key] = (counters[key] || 0) + (n === undefined ? 1 : n);
}

function setGauge(key, value) {
  gauges[key] = value;
}

function observeDuration(seconds) {
  let bucket = DURATION_BUCKETS[DURATION_BUCKETS.length - 1];
  for (const b of DURATION_BUCKETS) {
    if (seconds <= b) {
      bucket = b;
      break;
    }
  }
  durationBucketCounts[bucket] = (durationBucketCounts[bucket] || 0) + 1;
  durationSum.value += seconds;
  durationCount.value += 1;
}

function renderPrometheus() {
  const lines = [];
  for (const key of Object.keys(counters)) {
    lines.push('# HELP ' + key + ' Metric tracked by SignalMesh');
    lines.push('# TYPE ' + key + ' counter');
    lines.push(key + ' ' + (counters[key] || 0));
  }
  for (const key of Object.keys(gauges)) {
    lines.push('# HELP ' + key + ' Metric tracked by SignalMesh');
    lines.push('# TYPE ' + key + ' gauge');
    lines.push(key + ' ' + (gauges[key] || 0));
  }
  lines.push('# HELP delivery_duration_seconds Delivery attempt duration in seconds');
  lines.push('# TYPE delivery_duration_seconds histogram');
  const ordered = DURATION_BUCKETS.slice().sort((a, b) => a - b);
  for (const bucket of ordered) {
    lines.push('delivery_duration_seconds_bucket{le="' + bucket + '"} ' + (durationBucketCounts[bucket] || 0));
  }
  lines.push('delivery_duration_seconds_bucket{le="+Inf"} ' + (durationCount.value || 0));
  lines.push('delivery_duration_seconds_sum ' + (durationSum.value || 0));
  lines.push('delivery_duration_seconds_count ' + (durationCount.value || 0));
  return lines.join('\n');
}

module.exports = {
  inc,
  setGauge,
  observeDuration,
  renderPrometheus,
};
