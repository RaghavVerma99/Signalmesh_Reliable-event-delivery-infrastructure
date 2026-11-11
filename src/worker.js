'use strict';

const os = require('os');
const http = require('http');
const https = require('https');
const defaultStore = require('./store');
const config = require('./config');
const { nowIso } = require('./util');
const { signDelivery, decryptSecret, recheckDeliveryDestination, createSafeLookup, MAX_RESPONSE_BYTES } = require('./security');
const metrics = require('./metrics');

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const DEFAULT_TIMEOUT_MS = Math.max(1, parseInt(process.env.SIGNALMESH_DELIVERY_TIMEOUT_MS || '10000', 10) || 10000);
const DEFAULT_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.SIGNALMESH_MAX_ATTEMPTS || '8', 10) || 8);
const DEFAULT_BASE_DELAY_MS = Math.max(0, parseInt(process.env.SIGNALMESH_RETRY_BASE_DELAY_MS || '2000', 10) || 2000);
const DEFAULT_MAX_DELAY_MS = Math.max(0, parseInt(process.env.SIGNALMESH_RETRY_MAX_DELAY_MS || '3600000', 10) || 3600000);

function computeBackoffMs(attemptNumber, baseDelayMs, maxDelayMs) {
  const exp = Math.max(0, attemptNumber - 1);
  const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exp));
  return Math.random() * cap;
}

function recordDeliveryOutcome(outcome, durationMs) {
  metrics.inc('delivery_attempts_total');
  metrics.observeDuration(durationMs / 1000);
  if (outcome.type === 'succeeded') metrics.inc('delivery_success_total');
  if (outcome.type === 'dead') metrics.inc('delivery_dead_letter_total');
}

const safeLookup = createSafeLookup();

/**
 * POST the webhook body using Node's http/https client with a validating DNS
 * lookup. The lookup checks the actual address used for the connection,
 * defeating DNS rebinding; redirects are never followed.
 */
function httpPost(urlString, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      return reject(e);
    }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body, 'utf8');
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: Object.assign({}, headers, { 'content-length': payload.length }),
      lookup: safeLookup,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size < MAX_RESPONSE_BYTES) {
          const remaining = MAX_RESPONSE_BYTES - size;
          chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
        }
        size += chunk.length;
      });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') || null,
        truncated: size > MAX_RESPONSE_BYTES,
      }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      const err = new Error('request timeout');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function createWorker(store, options) {
  const opts = options || {};
  const workerId = opts.workerId || process.env.SIGNALMESH_WORKER_ID || (os.hostname() + '-' + process.pid);
  const concurrency = Math.max(1, opts.concurrency || config.worker.concurrency);
  const pollIntervalMs = Math.max(50, opts.pollIntervalMs || config.worker.pollIntervalMs);
  const leaseMs = Math.max(1, opts.leaseMs || config.worker.leaseMs);

  let timer = null;
  let running = false;
  let stopping = false;
  let inFlight = Promise.resolve();

  async function runAttempt(delivery) {
    const endpoint = await store.getEndpointForWorker(delivery.endpointId);
    const maxAttempts = endpoint ? (endpoint.maxAttempts || DEFAULT_MAX_ATTEMPTS) : DEFAULT_MAX_ATTEMPTS;
    const baseDelayMs = endpoint ? (endpoint.baseDelayMs || DEFAULT_BASE_DELAY_MS) : DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = endpoint ? (endpoint.maxDelayMs || DEFAULT_MAX_DELAY_MS) : DEFAULT_MAX_DELAY_MS;

    const attemptNumber = delivery.attemptCount + 1;
    const startedAtMs = Date.now();
    const attempt = {
      attemptNumber,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      statusCode: null,
      durationMs: null,
      errorClass: null,
      responseExcerpt: null,
    };

    let outcome = { type: 'dead', error: 'endpoint_unavailable', statusCode: null, responseExcerpt: null };

    try {
      if (!endpoint) {
        outcome = { type: 'dead', error: 'endpoint_unavailable', statusCode: null, responseExcerpt: null };
      } else {
        const event = await store.getEventForWorker(delivery.eventId);
        const envelope = {
          event_id: delivery.eventId,
          delivery_id: delivery.id,
          event_type: delivery.eventType,
          data: event ? event.data : {},
        };
        if (event && event.occurredAt) envelope.occurred_at = event.occurredAt;
        if (event && event.metadata) envelope.metadata = event.metadata;

        const body = JSON.stringify(envelope);
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = signDelivery(decryptSecret(endpoint.signingSecret), timestamp, body);

        const destCheck = await recheckDeliveryDestination(endpoint.url);
        if (!destCheck.ok) {
          const blocked = new Error('destination_blocked: ' + destCheck.error);
          blocked.code = 'destination_blocked';
          throw blocked;
        }

        const signaturePrevious = endpoint.signingSecretPrevious
          ? signDelivery(decryptSecret(endpoint.signingSecretPrevious), timestamp, body)
          : null;
        const outboundHeaders = {
          'content-type': 'application/json',
          'x-signalmesh-event-id': delivery.eventId,
          'x-signalmesh-delivery-id': delivery.id,
          'x-signalmesh-timestamp': String(timestamp),
          'x-signalmesh-signature': signature,
        };
        if (signaturePrevious) outboundHeaders['x-signalmesh-signature-previous'] = signaturePrevious;

        const res = await httpPost(endpoint.url, outboundHeaders, body, endpoint.timeoutMs || DEFAULT_TIMEOUT_MS);
        const excerpt = res.body || null;
        attempt.finishedAt = new Date().toISOString();
        attempt.durationMs = Date.now() - startedAtMs;
        attempt.statusCode = res.statusCode;
        attempt.responseExcerpt = excerpt;

        if (res.statusCode >= 200 && res.statusCode < 300) {
          outcome = { type: 'succeeded', statusCode: res.statusCode, error: null, responseExcerpt: excerpt };
        } else {
          const retryable = RETRYABLE_STATUS.has(res.statusCode);
          let delayMs = null;
          if (res.statusCode === 429 || res.statusCode === 503) {
            const retryAfter = parseInt(res.headers['retry-after'] || '0', 10);
            if (retryAfter > 0) delayMs = Math.min(retryAfter * 1000, maxDelayMs);
          }
          if (!retryable) {
            outcome = { type: 'dead', error: 'http_' + res.statusCode, statusCode: res.statusCode, responseExcerpt: excerpt };
          } else if (attemptNumber >= maxAttempts) {
            outcome = { type: 'dead', error: 'retry_exhausted', statusCode: res.statusCode, responseExcerpt: excerpt };
          } else {
            outcome = { type: 'retry', error: 'http_' + res.statusCode, statusCode: res.statusCode, responseExcerpt: excerpt, delayMs: delayMs != null ? delayMs : computeBackoffMs(attemptNumber, baseDelayMs, maxDelayMs) };
          }
        }
      }
    } catch (err) {
      attempt.finishedAt = new Date().toISOString();
      attempt.durationMs = Date.now() - startedAtMs;
      if (err && (err.code === 'destination_blocked' || err.code === 'blocked_address')) {
        outcome = { type: 'dead', error: 'destination_blocked', statusCode: null, responseExcerpt: null };
      } else {
        const timedOut = !!(err && (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError'));
        const errorClass = timedOut ? 'timeout' : 'network';
        if (attemptNumber >= maxAttempts) {
          outcome = { type: 'dead', error: 'retry_exhausted', statusCode: null, responseExcerpt: null };
        } else {
          outcome = { type: 'retry', error: errorClass, statusCode: null, responseExcerpt: null, delayMs: computeBackoffMs(attemptNumber, baseDelayMs, maxDelayMs) };
        }
      }
    }

    if (outcome.type !== 'succeeded') attempt.errorClass = outcome.error || null;

    recordDeliveryOutcome(outcome, Date.now() - startedAtMs);
    const result = await store.recordAttempt({ deliveryId: delivery.id, workerId, attempt, outcome });
    return result;
  }

  async function tick() {
    if (running || stopping) return;
    running = true;
    try {
      metrics.setGauge('worker_last_tick_timestamp_seconds', Date.now() / 1000);
      const qm = await store.queueMetrics();
      metrics.setGauge('queue_depth', qm.queueDepth);
      metrics.setGauge('oldest_pending_age_seconds', qm.oldestPendingAgeSeconds);

      const jobs = [];
      for (let i = 0; i < concurrency; i++) {
        const delivery = await store.claimDueDelivery(workerId, leaseMs);
        if (!delivery) break;
        jobs.push(runAttempt(delivery));
      }
      if (!jobs.length) {
        metrics.setGauge('worker_active_count', 0);
        return;
      }
      metrics.setGauge('worker_active_count', jobs.length);
      const results = await Promise.allSettled(jobs);
      for (const r of results) {
        if (r.status === 'rejected') {
          console.log(JSON.stringify({ ts: nowIso(), level: 'error', msg: 'delivery_attempt_failed', worker_id: workerId, error: String(r.reason && r.reason.message ? r.reason.message : r.reason) }));
        }
      }
      metrics.setGauge('worker_active_count', 0);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    stopping = false;
    timer = setInterval(() => {
      inFlight = tick().catch((err) => {
        console.log(JSON.stringify({ ts: nowIso(), level: 'error', msg: 'worker_tick_failed', worker_id: workerId, error: String(err && err.message ? err.message : err) }));
      });
    }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function drain() {
    await inFlight;
  }

  return { start, stop, drain, tick, runAttempt, computeBackoffMs, RETRYABLE_STATUS, workerId };
}

const defaultWorker = createWorker(defaultStore);

module.exports = defaultWorker;
module.exports.createWorker = createWorker;
module.exports.computeBackoffMs = computeBackoffMs;
module.exports.RETRYABLE_STATUS = RETRYABLE_STATUS;
