'use strict';

/**
 * In-process token-bucket rate limiter keyed by tenant.
 *
 * Single-instance only: for multi-replica deployments move this to Redis or
 * a shared database-backed counter. Idle buckets are evicted so a stream of
 * unique keys cannot grow the map without bound.
 */
function createRateLimiter(options) {
  const capacity = Math.max(1, options.burst);
  const refillPerMs = Math.max(0.000001, options.perMinute / 60000);
  const idleTtlMs = Math.max(1, options.idleTtlMs || 600000);
  const sweepIntervalMs = Math.max(1, options.sweepIntervalMs || 60000);
  const buckets = new Map();
  let lastSweepAt = Date.now();

  function evictIdle(now) {
    if (now - lastSweepAt < sweepIntervalMs) return;
    lastSweepAt = now;
    for (const [key, bucket] of buckets) {
      if (now - bucket.last > idleTtlMs) buckets.delete(key);
    }
  }

  return function check(key) {
    const now = Date.now();
    evictIdle(now);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, last: now };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.last);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.last = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens) };
    }
    const retryAfterMs = (1 - bucket.tokens) / refillPerMs;
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  };
}

module.exports = { createRateLimiter };
