'use strict';

const express = require('express');
const crypto = require('crypto');
const store = require('./store');
const worker = require('./worker');
const { genId, stableStringify, hashToken, nowIso } = require('./store');
const { validateDeliveryUrl, verifyDeliverySignature } = require('./security');
const metrics = require('./metrics');

const app = express();
app.use(express.json({ limit: '256kb' }));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '8080', 10);

function newRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function log(level, msg, fields) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), level: level, msg: msg }, fields || {})));
}

function errorBody(code, message, reqId) {
  return { error: { code: code, message: message, request_id: reqId } };
}

app.use((req, res, next) => {
  req.id = newRequestId();
  next();
});

app.use((req, res, next) => {
  const startAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startAt;
    metrics.inc('http_requests_total');
    log('info', 'http_request', { request_id: req.id, method: req.method, path: req.path, status: res.statusCode, duration_ms: durationMs });
  });
  next();
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const parts = header.split(' ');
  const token = parts[0] === 'Bearer' ? parts[1] : null;
  if (!token) {
    return res.status(401).json(errorBody('unauthorized', 'Missing API key', req.id));
  }
  const key = store.findKeyByToken(token);
  if (!key) {
    return res.status(401).json(errorBody('unauthorized', 'Invalid API key', req.id));
  }
  req.key = key;
  next();
}

app.use('/v1', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/keys' && store.state.keys.length === 0) {
    return next();
  }
  requireAuth(req, res, next);
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', service: 'signalmesh' });
});

app.get('/readyz', (req, res) => {
  res.json({ status: 'ok', service: 'signalmesh' });
});

app.post('/v1/keys', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'default';
  const created = store.createKey(name);
  log('info', 'api_key_created', { key_id: created.id, name: created.name });
  return res.status(201).json({ key: created, note: 'Store this key now. SignalMesh only stores its hash.' });
});

app.post('/v1/events', (req, res) => {
  const body = req.body || {};
  const eventType = typeof body.event_type === 'string' ? body.event_type.trim() : '';
  if (!eventType) {
    metrics.inc('events_ingest_errors_total');
    return res.status(422).json(errorBody('validation_failed', 'event_type is required', req.id));
  }
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
  const occurredAt = typeof body.occurred_at === 'string' && body.occurred_at ? body.occurred_at : null;
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {};
  const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].trim() : '';

  const fingerprint = hashToken(idempotencyKey + '|' + stableStringify({ event_type: eventType, data: data, occurred_at: occurredAt, metadata: metadata }));

  if (idempotencyKey) {
    const existing = store.findIdempotent(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== fingerprint) {
        return res.status(409).json(errorBody('idempotency_conflict', 'idempotency key already used with a different payload', req.id));
      }
      return res.status(200).json({ event_id: existing.responseBody.event_id, status: 'accepted', idempotent: true, deliveries_created: 0 });
    }
  }

  const event = {
    id: genId('evt'),
    eventType: eventType,
    data: data,
    occurredAt: occurredAt,
    metadata: metadata,
    createdAt: nowIso(),
    deliveries: [],
  };
  store.insertEvent(event);
  metrics.inc('events_accepted_total');

  const deliveries = [];
  const endpoints = store.listEndpoints().filter((e) => !e.deletedAt && e.active);
  for (const ep of endpoints) {
    const subscribed = !ep.eventTypes || ep.eventTypes.indexOf('*') !== -1 || ep.eventTypes.indexOf(eventType) !== -1;
    if (!subscribed) continue;
    const delivery = store.insertDelivery({
      id: genId('dlv'),
      eventId: event.id,
      eventType: event.eventType,
      endpointId: ep.id,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: new Date().toISOString(),
      lastStatusCode: null,
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      attempts: [],
    });
    deliveries.push(delivery);
  }
  event.deliveries = deliveries.map((d) => d.id);

  if (idempotencyKey) {
    store.saveIdempotent(idempotencyKey, fingerprint, { event_id: event.id, status: 'accepted', deliveries_created: deliveries.length });
  }

  log('info', 'event_accepted', { event_id: event.id, event_type: event.eventType, deliveries_created: deliveries.length });
  store.persist();
  return res.status(202).json({ event_id: event.id, status: 'accepted', created_at: event.createdAt, deliveries_created: deliveries.length });
});

app.get('/v1/events', (req, res) => {
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 200) : 50;
  const eventType = typeof req.query.event_type === 'string' ? req.query.event_type : null;
  const result = store.listEvents({ eventType: eventType, limit: limit });
  const data = result.data.map((e) => ({ id: e.id, event_id: e.id, event_type: e.eventType, data: e.data, occurred_at: e.occurredAt, metadata: e.metadata, created_at: e.createdAt, deliveries: e.deliveries }));
  return res.json({ data: data, next_cursor: null, total: result.total });
});

function publicEndpoint(ep) {
  if (!ep) return null;
  return {
    id: ep.id,
    name: ep.name,
    url: ep.url,
    event_types: ep.eventTypes || ['*'],
    active: ep.active,
    timeout_seconds: ep.timeoutMs ? ep.timeoutMs / 1000 : 10,
    max_attempts: ep.maxAttempts || 3,
    created_at: ep.createdAt,
    updated_at: ep.updatedAt,
    deleted_at: ep.deletedAt || null,
  };
}

app.post('/v1/endpoints', async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'endpoint';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return res.status(422).json(errorBody('validation_failed', 'url must be a valid http(s) URL', req.id));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(422).json(errorBody('validation_failed', 'url must use http or https', req.id));
  }
  let deliveryUrlCheck;
  try {
    deliveryUrlCheck = await validateDeliveryUrl(url);
  } catch (e) {
    return res.status(422).json(errorBody('validation_failed', 'url validation failed', req.id));
  }
  if (!deliveryUrlCheck.ok) {
    return res.status(422).json(errorBody('validation_failed', 'url rejected: ' + deliveryUrlCheck.error, req.id));
  }
  const eventTypes = Array.isArray(body.event_types) ? body.event_types.filter((t) => typeof t === 'string') : ['*'];
  const timeoutSeconds = typeof body.timeout_seconds === 'number' && body.timeout_seconds > 0 ? body.timeout_seconds : 10;
  const maxAttempts = typeof body.max_attempts === 'number' && body.max_attempts > 0 ? body.max_attempts : 3;
  const signingSecret = 'whsec_' + crypto.randomBytes(4).toString('hex') + crypto.randomBytes(8).toString('hex');
  const endpoint = store.insertEndpoint({
    id: genId('ep'),
    name: name,
    url: url,
    eventTypes: eventTypes,
    active: body.active === undefined ? true : !!body.active,
    signingSecret: signingSecret,
    timeoutMs: timeoutSeconds * 1000,
    maxAttempts: maxAttempts,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  });
  return res.status(201).json({ endpoint: publicEndpoint(endpoint), signing_secret: signingSecret });
});

app.post('/v1/keys/:id/revoke', requireAuth, (req, res) => {
  const key = store.revokeKey(req.params.id);
  if (!key) {
    return res.status(404).json(errorBody('not_found', 'API key not found', req.id));
  }
  log('info', 'api_key_revoked', { key_id: key.id, name: key.name });
  return res.json({ revoked: true, id: key.id, revoked_at: key.revokedAt });
});

app.get('/v1/endpoints', (req, res) => {
  const endpoints = store.listEndpoints();
  return res.json({ data: endpoints.map((e) => publicEndpoint(e)), next_cursor: null, total: endpoints.length });
});

app.get('/v1/endpoints/:id', (req, res) => {
  const ep = store.getEndpoint(req.params.id);
  if (!ep) {
    return res.status(404).json(errorBody('not_found', 'Endpoint not found', req.id));
  }
  return res.json({ endpoint: publicEndpoint(ep) });
});

app.delete('/v1/endpoints/:id', (req, res) => {
  const ep = store.softDeleteEndpoint(req.params.id);
  if (!ep) {
    return res.status(404).json(errorBody('not_found', 'Endpoint not found', req.id));
  }
  return res.json({ deleted: true, id: ep.id });
});

function publicDelivery(d) {
  return {
    id: d.id,
    event_id: d.eventId,
    event_type: d.eventType,
    endpoint_id: d.endpointId,
    status: d.status,
    attempt_count: d.attemptCount || 0,
    next_attempt_at: d.nextAttemptAt || null,
    last_status_code: d.lastStatusCode || null,
    last_error: d.lastError || null,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

app.get('/v1/deliveries', (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.event_id) filter.eventId = String(req.query.event_id);
  if (req.query.endpoint_id) filter.endpointId = String(req.query.endpoint_id);
  if (req.query.delivery_id) filter.deliveryId = String(req.query.delivery_id);
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 200) : 50;
  const result = store.listDeliveries(Object.assign({ limit: limit }, filter));
  return res.json({ data: result.data.map(publicDelivery), next_cursor: null, total: result.total });
});

app.get('/v1/deliveries/:id', (req, res) => {
  const result = store.getDelivery(req.params.id);
  if (!result) {
    return res.status(404).json(errorBody('not_found', 'Delivery not found', req.id));
  }
  const d = result.delivery;
  return res.json({
    delivery: publicDelivery(d),
    event: result.event ? { id: result.event.id, event_type: result.event.eventType, data: result.event.data, occurred_at: result.event.occurredAt, metadata: result.event.metadata, created_at: result.event.createdAt } : null,
    endpoint: result.endpoint ? { id: result.endpoint.id, name: result.endpoint.name, url: result.endpoint.url, active: result.endpoint.active, timeout_seconds: result.endpoint.timeoutMs ? result.endpoint.timeoutMs / 1000 : 10, max_attempts: result.endpoint.maxAttempts || 3 } : null,
  });
});

app.post('/v1/deliveries/:id/replay', (req, res) => {
  const result = store.getDelivery(req.params.id);
  if (!result) {
    return res.status(404).json(errorBody('not_found', 'Delivery not found', req.id));
  }
  const original = result.delivery;
  const newDelivery = store.insertDelivery({
    id: genId('dlv'),
    eventId: original.eventId,
    eventType: original.eventType,
    endpointId: original.endpointId,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: new Date().toISOString(),
    lastStatusCode: null,
    lastError: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    attempts: [],
  });
  const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : null;
  log('info', 'delivery_replayed', { delivery_id: original.id, replay_delivery_id: newDelivery.id, reason: reason });
  store.persist();
  return res.status(202).json({ delivery_id: newDelivery.id, status: 'pending', replay_of: original.id, reason: reason });
});

app.post('/v1/deliveries/:id/cancel', (req, res) => {
  const result = store.getDelivery(req.params.id);
  if (!result) {
    return res.status(404).json(errorBody('not_found', 'Delivery not found', req.id));
  }
  const original = result.delivery;
  if (original.status === 'processing') {
    return res.status(409).json(errorBody('conflict', 'Delivery is currently processing', req.id));
  }
  if (original.status === 'succeeded' || original.status === 'dead_lettered' || original.status === 'cancelled') {
    return res.json({ delivery_id: original.id, status: original.status });
  }
  original.status = 'cancelled';
  original.nextAttemptAt = null;
  original.updatedAt = nowIso();
  return res.json({ delivery_id: original.id, status: 'cancelled' });
});

const flakyHits = {};
function recordHit(path) {
  flakyHits[path] = (flakyHits[path] || 0) + 1;
  return flakyHits[path];
}

app.post('/demo/orders', (req, res) => {
  const deliveryId = req.headers['x-signalmesh-delivery-id'];
  const delivery = store.state.deliveries.find((d) => d.id === deliveryId) || null;
  const secret = delivery ? (store.state.endpoints.find((e) => e.id === delivery.endpointId) || {}).signingSecret : null;
  const sig = String(req.headers['x-signalmesh-signature'] || '');
  const ok = !!secret && verifyDeliverySignature(secret, String(req.headers['x-signalmesh-timestamp'] || ''), sig, JSON.stringify(req.body));
  if (!ok) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  res.json({ ok: true, received_at: new Date().toISOString() });
});

app.post('/demo/orders-flaky', (req, res) => {
  const hits = recordHit('/demo/orders-flaky');
  if (hits <= 1) {
    return res.status(500).json({ error: 'flaky failure' });
  }
  return res.json({ ok: true, hit: hits });
});

app.post('/demo/orders-down', (req, res) => {
  res.status(500).json({ error: 'destination down' });
});

app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.status(200).send(metrics.renderPrometheus());
});

app.use((req, res) => {
  res.status(404).json(errorBody('not_found', 'Route not found', req.id));
});

app.use((err, req, res, next) => {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) {
    log('error', 'internal_error', { error: String(err && err.message ? err.message : err) });
  }
  res.status(status).json(errorBody(status >= 500 ? 'internal_error' : 'request_error', status >= 500 ? 'Internal server error' : 'Bad request', req.id));
});

const server = app.listen(PORT, HOST, () => {
  log('info', 'server_started', { port: PORT });
  worker.start();
});

function shutdown() {
  worker.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
module.exports.server = server;