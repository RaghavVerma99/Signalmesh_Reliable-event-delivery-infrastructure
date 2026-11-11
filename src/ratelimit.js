'use strict';

/**
 * In-process token-bucket rate limiter keyed by tenant.
 *
 * Single-instance only: for multi-replica deployments move this to Redis or
 * a PostgreSQL-backed counter (see docs/NODE_STRATEGY.md).
 */
function createRateLimiter(options) {
  const capacity = Math.max(1, options.burst);
  const refillPerMs = Math.max(0.000001, options.perMinute / 60000);
  const buckets = new Map();

  return function check(key) {
    const now = Date.now();
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
