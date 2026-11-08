'use strict';

const store = require('./store');
const { nowIso } = require('./store');
const { signDelivery, MAX_RESPONSE_BYTES } = require('./security');
const metrics = require('./metrics');

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const LEASE_MS = 15000;

function computeBackoffMs(attemptNumber, baseDelayMs, maxDelayMs) {
  const exp = Math.max(0, attemptNumber - 1);
  const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exp));
  return Math.random() * cap;
}

function recordDeliveryOutcome(outcome, durationMs) {
  metrics.inc('delivery_attempts_total');
  metrics.observeDuration(durationMs / 1000);
  if (outcome.type === 'succeeded') {
    metrics.inc('delivery_success_total');
  }
  if (outcome.type === 'dead') {
    metrics.inc('delivery_dead_letter_total');
  }
}

async function runAttempt(delivery) {
  const endpoint = store.state.endpoints.find((e) => e.id === delivery.endpointId && !e.deletedAt) || null;
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

  delivery.status = 'processing';
  delivery.updatedAt = new Date().toISOString();
  delivery.lockedUntil = new Date(Date.now() + LEASE_MS).toISOString();

  let outcome = { type: 'dead', error: 'endpoint_unavailable', statusCode: null, responseExcerpt: null };

  try {
    if (!endpoint) {
      outcome = { type: 'dead', error: 'endpoint_unavailable', statusCode: null, responseExcerpt: null };
    } else {
      const event = store.state.events.find((e) => e.id === delivery.eventId) || null;
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
      const signature = signDelivery(endpoint.signingSecret, timestamp, body);

      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signalmesh-event-id': delivery.eventId,
          'x-signalmesh-delivery-id': delivery.id,
          'x-signalmesh-timestamp': String(timestamp),
          'x-signalmesh-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(endpoint.timeoutMs || DEFAULT_TIMEOUT_MS),
        redirect: 'manual',
      });
      const text = await res.text();
      const buf = Buffer.from(text, 'utf8');
      const excerpt = buf.length > MAX_RESPONSE_BYTES ? buf.subarray(0, MAX_RESPONSE_BYTES).toString('utf8') : (text || null);
      attempt.finishedAt = new Date().toISOString();
      attempt.durationMs = Date.now() - startedAtMs;
      attempt.statusCode = res.status;
      attempt.responseExcerpt = excerpt;

      if (res.status >= 200 && res.status < 300) {
        outcome = { type: 'succeeded', statusCode: res.status, error: null, responseExcerpt: excerpt };
      } else {
        const retryable = RETRYABLE_STATUS.has(res.status);
        let delayMs = null;
        if ((res.status === 429 || res.status === 503) && !isNaN(parseInt(res.headers.get('retry-after') || '0', 10))) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
          if (retryAfter > 0) delayMs = Math.min(retryAfter * 1000, maxDelayMs);
        }
        if (!retryable) {
          outcome = { type: 'dead', error: 'http_' + res.status, statusCode: res.status, responseExcerpt: excerpt };
        } else if (attemptNumber >= maxAttempts) {
          outcome = { type: 'dead', error: 'retry_exhausted', statusCode: res.status, responseExcerpt: excerpt };
        } else {
          outcome = { type: 'retry', error: 'http_' + res.status, statusCode: res.status, responseExcerpt: excerpt, delayMs: delayMs != null ? delayMs : computeBackoffMs(attemptNumber, baseDelayMs, maxDelayMs) };
        }
      }
    }
  } catch (err) {
    attempt.finishedAt = new Date().toISOString();
    attempt.durationMs = Date.now() - startedAtMs;
    const errorClass = err && err.name === 'TimeoutError' ? 'timeout' : 'network';
    if (attemptNumber >= maxAttempts) {
      outcome = { type: 'dead', error: 'retry_exhausted', statusCode: null, responseExcerpt: null };
    } else {
      outcome = { type: 'retry', error: errorClass, statusCode: null, responseExcerpt: null, delayMs: computeBackoffMs(attemptNumber, baseDelayMs, maxDelayMs) };
    }
  }

  if (outcome.type !== 'succeeded') {
    attempt.errorClass = outcome.error || null;
  }

  delivery.attempts.push(attempt);
  delivery.attemptCount = attemptNumber;
  delivery.updatedAt = new Date().toISOString();

  if (outcome.type === 'succeeded') {
    delivery.status = 'succeeded';
    delivery.lastStatusCode = outcome.statusCode;
    delivery.lastError = null;
    delivery.nextAttemptAt = null;
    delivery.lockedUntil = null;
    return { ok: true, delivery };
  }

  delivery.lastStatusCode = outcome.statusCode || null;
  delivery.lastError = outcome.error || null;
  delivery.lockedUntil = null;

  if (outcome.type === 'retry') {
    delivery.status = 'retry_scheduled';
    delivery.nextAttemptAt = new Date(Date.now() + (outcome.delayMs || 0)).toISOString();
    recordDeliveryOutcome(outcome, Date.now() - startedAtMs);
    return { ok: false, delivery, dead: false };
  }

  delivery.status = 'dead_lettered';
  delivery.nextAttemptAt = null;
  recordDeliveryOutcome(outcome, Date.now() - startedAtMs);
  return { ok: false, delivery, dead: true };
}

function claimDueDelivery() {
  const now = Date.now();
  const candidates = store.state.deliveries.filter((d) => {
    const status = d.status;
    if (status !== 'pending' && status !== 'retry_scheduled') return false;
    if (d.lockedUntil && new Date(d.lockedUntil).getTime() > now) return false;
    if (d.nextAttemptAt && new Date(d.nextAttemptAt).getTime() > now) return false;
    return true;
  });
  candidates.sort((a, b) => {
    const at = a.nextAttemptAt || a.createdAt;
    const bt = b.nextAttemptAt || b.createdAt;
    return at < bt ? -1 : 1;
  });
  return candidates.length ? candidates[0] : null;
}

function updateQueueMetrics() {
  const nowMs = Date.now();
  const pending = store.state.deliveries.filter((d) => {
    const status = d.status;
    if (status !== 'pending' && status !== 'retry_scheduled') return false;
    if (d.lockedUntil && new Date(d.lockedUntil).getTime() > nowMs) return false;
    if (d.nextAttemptAt && new Date(d.nextAttemptAt).getTime() > nowMs) return false;
    return true;
  });
  metrics.setGauge('queue_depth', pending.length);
  let oldest = null;
  for (const d of store.state.deliveries) {
    if (d.status !== 'pending') continue;
    const startedAtMs = new Date(d.createdAt).getTime();
    const ageMs = nowMs - startedAtMs;
    if (ageMs > 0 && (oldest === null || ageMs > oldest)) {
      oldest = ageMs;
    }
  }
  metrics.setGauge('oldest_pending_age_seconds', oldest ? oldest / 1000 : 0);
}

async function tick() {
  updateQueueMetrics();
  const delivery = claimDueDelivery();
  if (!delivery) return;
  metrics.setGauge('worker_active_count', 1);
  try {
    await runAttempt(delivery);
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'delivery_attempt_failed', delivery_id: delivery.id, error: String(err && err.message ? err.message : err) }));
  }
  metrics.setGauge('worker_active_count', 0);
}

let timer = null;

function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick();
  }, 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick, runAttempt, claimDueDelivery, computeBackoffMs, RETRYABLE_STATUS };