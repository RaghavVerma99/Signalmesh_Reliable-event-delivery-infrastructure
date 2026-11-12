'use strict';

const express = require('express');
const crypto = require('crypto');
const defaultStore = require('./store');
const defaultConfig = require('./config');
const defaultMetrics = require('./metrics');
const defaultWorker = require('./worker');
const { genId, stableStringify, hashToken, nowIso, newRequestId } = require('./util');
const { validateDeliveryUrl, verifyDeliverySignature, encryptSecret, decryptSecret } = require('./security');
const { createRateLimiter } = require('./ratelimit');
const { renderDashboard } = require('./dashboard');
const { normalizeScopes, hasScope, isValidScope, ALL_SCOPES } = require('./scopes');
const { createLogger } = require('./logging');

const logger = createLogger({ base: { component: 'api' } });

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function errorBody(code, message, requestId) {
  return { error: { code, message, request_id: requestId } };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

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

function createApp(deps) {
  const store = (deps && deps.store) || defaultStore;
  const config = (deps && deps.config) || defaultConfig;
  const metrics = (deps && deps.metrics) || defaultMetrics;
  const worker = (deps && deps.worker) || defaultWorker;

  const app = express();
  const maxEventBytes = Math.max(1024, parseInt(process.env.SIGNALMESH_MAX_EVENT_BYTES || '262144', 10) || 262144);
  app.use(express.json({ limit: maxEventBytes }));

  const limiter = createRateLimiter(config.rateLimit);

  function log(level, msg, fields) {
    logger[level](msg, fields);
  }

  /**
   * Scope gate. Keys were stored with scopes from day one but nothing
   * enforced them, so a "read-only" key could still mutate a tenant.
   */
  function requireScope(scope) {
    return function scopeGuard(req, res, next) {
      // The bootstrap key is created before any key exists, so there is no
      // key to carry scopes yet.
      if (req.bootstrap) return next();
      if (hasScope(req.key, scope)) return next();
      log('warn', 'scope_denied', { request_id: req.id, organization_id: req.organizationId, key_id: req.key && req.key.id, required_scope: scope });
      return res.status(403).json(errorBody('forbidden', 'API key does not have the required scope: ' + scope, req.id));
    };
  }

  function audit(req, action, resourceType, resourceId, metadata) {
    return store.appendAudit({
      organizationId: req.organizationId,
      actorKeyId: req.key ? req.key.id : null,
      action,
      resourceType,
      resourceId,
      metadata: metadata || null,
    });
  }

  app.use((req, res, next) => {
    req.id = newRequestId();
    next();
  });

  app.use((req, res, next) => {
    const startAt = Date.now();
    res.on('finish', () => {
      metrics.inc('http_requests_total');
      log('info', 'http_request', {
        request_id: req.id,
        organization_id: req.organizationId || null,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startAt,
      });
    });
    next();
  });

  async function authenticate(req) {
    const header = req.headers.authorization || '';
    const parts = header.split(' ');
    const token = parts[0] === 'Bearer' ? parts[1] : null;
    if (!token) return { status: 401, code: 'unauthorized', message: 'Missing API key' };
    const key = await store.findKeyByToken(token);
    if (!key) return { status: 401, code: 'unauthorized', message: 'Invalid API key' };
    req.key = key;
    req.organizationId = key.organizationId;
    return null;
  }

  app.use(
    '/v1',
    asyncHandler(async (req, res, next) => {
      const isBootstrap = req.method === 'POST' && req.path === '/keys' && (await store.countKeys()) === 0;
      if (isBootstrap) {
        req.bootstrap = true;
        return next();
      }
      const authError = await authenticate(req);
      if (authError) {
        return res.status(authError.status).json(errorBody(authError.code, authError.message, req.id));
      }
      if (config.rateLimit.enabled) {
        const verdict = limiter(req.organizationId);
        if (!verdict.allowed) {
          res.set('Retry-After', String(verdict.retryAfterSeconds));
          return res.status(429).json(errorBody('rate_limited', 'Tenant rate limit exceeded', req.id));
        }
      }
      return next();
    })
  );

  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', service: 'signalmesh' });
  });

  /**
   * Readiness means "this process can accept and durably persist requests".
   *
   * It deliberately does NOT fail when workers are missing: events are
   * persisted first and delivered later, so pulling the API out of the load
   * balancer because the worker deployment is down would turn a partial
   * outage into a total one. Worker liveness is reported separately.
   */
  app.get(
    '/readyz',
    asyncHandler(async (req, res) => {
      try {
        await store.ping();
        const body = { status: 'ok', service: 'signalmesh', storage: store.kind };
        if (store.listWorkerHeartbeats) {
          const workers = await store.listWorkerHeartbeats();
          body.workers = workers.length;
          body.worker_last_seen_at = workers.length ? workers[0].last_seen_at : null;
        }
        res.json(body);
      } catch {
        res.status(503).json({ status: 'unavailable', service: 'signalmesh', storage: store.kind });
      }
    })
  );

  /**
   * Worker liveness. Alert on this, not on `/readyz`: a non-200 here means
   * deliveries are not being processed even though events are still accepted.
   */
  app.get(
    '/healthz/workers',
    asyncHandler(async (req, res) => {
      const workers = store.listWorkerHeartbeats ? await store.listWorkerHeartbeats() : [];
      const body = {
        status: workers.length ? 'ok' : 'unavailable',
        service: 'signalmesh',
        workers: workers.length,
        worker_last_seen_at: workers.length ? workers[0].last_seen_at : null,
      };
      res.status(workers.length ? 200 : 503).json(body);
    })
  );

  app.get('/metrics', (req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(metrics.renderPrometheus());
  });

  // ---- API keys --------------------------------------------------------
  app.post(
    '/v1/keys',
    requireScope('keys:write'),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'default';
      let organizationId = req.organizationId;
      if (req.bootstrap) {
        const orgName = typeof body.organization === 'string' && body.organization.trim() ? body.organization.trim() : 'default';
        const org = await store.createOrganization(orgName);
        organizationId = org.id;
      }
      const requestedScopes = Array.isArray(body.scopes) ? body.scopes : null;
      if (requestedScopes) {
        const unknown = requestedScopes.filter((s) => typeof s !== 'string' || !isValidScope(s));
        if (unknown.length) {
          return res.status(422).json(errorBody('validation_failed', 'unknown scope(s): ' + unknown.join(', ') + '. Available: ' + ALL_SCOPES.join(', '), req.id));
        }
      }
      const scopes = normalizeScopes(requestedScopes);
      const created = await store.createKey({ name, organizationId, scopes });
      await store.appendAudit({
        organizationId,
        actorKeyId: req.key ? req.key.id : created.id,
        action: 'api_key.created',
        resourceType: 'api_key',
        resourceId: created.id,
        metadata: { name: created.name, scopes },
      });
      log('info', 'api_key_created', { key_id: created.id, organization_id: organizationId, name: created.name });
      return res.status(201).json({
        key: created,
        organization_id: organizationId,
        note: 'Store this key now. SignalMesh only stores its hash.',
      });
    })
  );

  app.get(
    '/v1/keys',
    requireScope('keys:read'),
    asyncHandler(async (req, res) => {
      const keys = await store.listKeys(req.organizationId);
      return res.json({ data: keys, total: keys.length });
    })
  );

  app.post(
    '/v1/keys/:id/revoke',
    requireScope('keys:write'),
    asyncHandler(async (req, res) => {
      const key = await store.revokeKey(req.params.id, req.organizationId);
      if (!key) return res.status(404).json(errorBody('not_found', 'API key not found', req.id));
      await audit(req, 'api_key.revoked', 'api_key', key.id, { name: key.name });
      log('info', 'api_key_revoked', { key_id: key.id, organization_id: req.organizationId });
      return res.json({ revoked: true, id: key.id, revoked_at: key.revokedAt });
    })
  );

  // ---- events ----------------------------------------------------------
  app.post(
    '/v1/events',
    requireScope('events:write'),
    asyncHandler(async (req, res) => {
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

      const fingerprint = hashToken(idempotencyKey + '|' + stableStringify({ event_type: eventType, data, occurred_at: occurredAt, metadata }));

      const event = {
        id: genId('evt'),
        organizationId: req.organizationId,
        eventType,
        data,
        occurredAt,
        metadata,
        createdAt: nowIso(),
        deliveries: [],
      };

      const endpoints = (await store.listEndpoints(req.organizationId)).filter((e) => e.active);
      const deliveries = [];
      for (const ep of endpoints) {
        const subscribed = !ep.eventTypes || ep.eventTypes.indexOf('*') !== -1 || ep.eventTypes.indexOf(eventType) !== -1;
        if (!subscribed) continue;
        deliveries.push({
          id: genId('dlv'),
          organizationId: req.organizationId,
          eventId: event.id,
          eventType,
          endpointId: ep.id,
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: nowIso(),
          lastStatusCode: null,
          lastError: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          attempts: [],
        });
      }
      event.deliveries = deliveries.map((d) => d.id);

      const idempotency = idempotencyKey
        ? {
            organizationId: req.organizationId,
            operation: 'events',
            key: idempotencyKey,
            requestHash: fingerprint,
            responseStatus: 202,
            responseBody: { event_id: event.id, status: 'accepted', deliveries_created: deliveries.length },
            expiresAt: config.idempotencyTtlMs > 0 ? new Date(Date.now() + config.idempotencyTtlMs).toISOString() : null,
          }
        : null;

      let result;
      try {
        result = await store.ingestEvent({ event, deliveries, idempotency });
      } catch (err) {
        log('error', 'event_persist_failed', { event_id: event.id, error: String(err && err.message ? err.message : err) });
        metrics.inc('events_ingest_errors_total');
        return res.status(503).json(errorBody('storage_unavailable', 'Could not durably persist event', req.id));
      }

      if (result.status === 'conflict') {
        return res.status(409).json(errorBody('idempotency_conflict', 'idempotency key already used with a different payload', req.id));
      }
      if (result.status === 'duplicate') {
        return res.status(200).json(Object.assign({ idempotent: true }, result.responseBody));
      }

      metrics.inc('events_accepted_total');
      metrics.inc('deliveries_created_total', deliveries.length);
      await audit(req, 'event.accepted', 'event', event.id, { event_type: eventType, deliveries_created: deliveries.length });
      log('info', 'event_accepted', { event_id: event.id, organization_id: req.organizationId, event_type: eventType, deliveries_created: deliveries.length });
      return res.status(202).json({ event_id: event.id, status: 'accepted', created_at: event.createdAt, deliveries_created: deliveries.length });
    })
  );

  app.get(
    '/v1/events',
    requireScope('events:read'),
    asyncHandler(async (req, res) => {
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 200) : 50;
      const eventType = typeof req.query.event_type === 'string' ? req.query.event_type : null;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      const result = await store.listEvents({ organizationId: req.organizationId, eventType, limit, cursor });
      // One aggregate query for the whole page instead of one COUNT per event.
      const counts = await store.countDeliveriesForEvents(
        result.data.map((e) => e.id),
        req.organizationId
      );
      const data = result.data.map((e) => ({
        id: e.id,
        event_id: e.id,
        event_type: e.eventType,
        data: e.data,
        occurred_at: e.occurredAt,
        metadata: e.metadata,
        created_at: e.createdAt,
        deliveries: e.deliveries || [],
        delivery_count: counts.get(e.id) || 0,
      }));
      return res.json({ data, next_cursor: result.next_cursor, total: result.total });
    })
  );

  // ---- endpoints -------------------------------------------------------
  app.post(
    '/v1/endpoints',
    requireScope('endpoints:write'),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'endpoint';
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return res.status(422).json(errorBody('validation_failed', 'url must be a valid http(s) URL', req.id));
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(422).json(errorBody('validation_failed', 'url must use http or https', req.id));
      }
      const check = await validateDeliveryUrl(url);
      if (!check.ok) {
        return res.status(422).json(errorBody('validation_failed', 'url rejected: ' + check.error, req.id));
      }
      const eventTypes = Array.isArray(body.event_types) ? body.event_types.filter((t) => typeof t === 'string') : ['*'];
      if (eventTypes.length > config.delivery.maxEventTypes) {
        return res.status(422).json(errorBody('validation_failed', 'too many event_types (max ' + config.delivery.maxEventTypes + ')', req.id));
      }
      const defaultTimeoutSeconds = Math.max(1, Math.floor((parseInt(process.env.SIGNALMESH_DELIVERY_TIMEOUT_MS || '10000', 10) || 10000) / 1000));
      const defaultMaxAttempts = Math.max(1, parseInt(process.env.SIGNALMESH_MAX_ATTEMPTS || '8', 10) || 8);
      const defaultBaseDelayMs = Math.max(0, parseInt(process.env.SIGNALMESH_RETRY_BASE_DELAY_MS || '2000', 10) || 2000);
      const defaultMaxDelayMs = Math.max(0, parseInt(process.env.SIGNALMESH_RETRY_MAX_DELAY_MS || '3600000', 10) || 3600000);
      const timeoutSeconds = typeof body.timeout_seconds === 'number' && body.timeout_seconds > 0 ? body.timeout_seconds : defaultTimeoutSeconds;
      const maxAttempts = typeof body.max_attempts === 'number' && body.max_attempts > 0 ? body.max_attempts : defaultMaxAttempts;
      if (timeoutSeconds * 1000 > config.delivery.maxTimeoutMs) {
        return res.status(422).json(errorBody('validation_failed', 'timeout_seconds exceeds the maximum of ' + Math.floor(config.delivery.maxTimeoutMs / 1000), req.id));
      }
      if (maxAttempts > config.delivery.maxAttempts) {
        return res.status(422).json(errorBody('validation_failed', 'max_attempts exceeds the maximum of ' + config.delivery.maxAttempts, req.id));
      }
      const signingSecret = 'whsec_' + crypto.randomBytes(4).toString('hex') + crypto.randomBytes(8).toString('hex');
      const endpoint = await store.insertEndpoint({
        id: genId('ep'),
        organizationId: req.organizationId,
        name,
        url,
        eventTypes,
        active: body.active === undefined ? true : !!body.active,
        signingSecret: encryptSecret(signingSecret),
        timeoutMs: timeoutSeconds * 1000,
        maxAttempts,
        baseDelayMs: defaultBaseDelayMs,
        maxDelayMs: defaultMaxDelayMs,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
      });
      await audit(req, 'endpoint.created', 'endpoint', endpoint.id, { name: endpoint.name, url: endpoint.url });
      return res.status(201).json({ endpoint: publicEndpoint(endpoint), signing_secret: signingSecret });
    })
  );

  app.get(
    '/v1/endpoints',
    requireScope('endpoints:read'),
    asyncHandler(async (req, res) => {
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 200) : 50;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      const result = await store.listEndpointsPage({ organizationId: req.organizationId, limit, cursor });
      return res.json({ data: result.data.map(publicEndpoint), next_cursor: result.next_cursor, total: result.total });
    })
  );

  app.get(
    '/v1/endpoints/:id',
    requireScope('endpoints:read'),
    asyncHandler(async (req, res) => {
      const ep = await store.getEndpoint(req.params.id, req.organizationId);
      if (!ep) return res.status(404).json(errorBody('not_found', 'Endpoint not found', req.id));
      return res.json({ endpoint: publicEndpoint(ep) });
    })
  );

  app.patch(
    '/v1/endpoints/:id',
    requireScope('endpoints:write'),
    asyncHandler(async (req, res) => {
      const existing = await store.getEndpoint(req.params.id, req.organizationId);
      if (!existing) return res.status(404).json(errorBody('not_found', 'Endpoint not found', req.id));
      const body = req.body || {};
      const patch = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (Array.isArray(body.event_types)) {
        if (body.event_types.filter((t) => typeof t === 'string').length > config.delivery.maxEventTypes) {
          return res.status(422).json(errorBody('validation_failed', 'too many event_types (max ' + config.delivery.maxEventTypes + ')', req.id));
        }
        patch.eventTypes = body.event_types.filter((t) => typeof t === 'string');
      }
      if (typeof body.active === 'boolean') patch.active = body.active;
      if (typeof body.timeout_seconds === 'number' && body.timeout_seconds > 0) {
        if (body.timeout_seconds * 1000 > config.delivery.maxTimeoutMs) {
          return res.status(422).json(errorBody('validation_failed', 'timeout_seconds exceeds the maximum of ' + Math.floor(config.delivery.maxTimeoutMs / 1000), req.id));
        }
        patch.timeoutMs = Math.floor(body.timeout_seconds * 1000);
      }
      if (typeof body.max_attempts === 'number' && body.max_attempts > 0) {
        if (body.max_attempts > config.delivery.maxAttempts) {
          return res.status(422).json(errorBody('validation_failed', 'max_attempts exceeds the maximum of ' + config.delivery.maxAttempts, req.id));
        }
        patch.maxAttempts = Math.floor(body.max_attempts);
      }
      if (typeof body.url === 'string' && body.url.trim()) {
        const url = body.url.trim();
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return res.status(422).json(errorBody('validation_failed', 'url must be a valid http(s) URL', req.id));
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return res.status(422).json(errorBody('validation_failed', 'url must use http or https', req.id));
        }
        const check = await validateDeliveryUrl(url);
        if (!check.ok) return res.status(422).json(errorBody('validation_failed', 'url rejected: ' + check.error, req.id));
        patch.url = url;
      }
      const updated = await store.updateEndpoint(req.params.id, req.organizationId, patch);
      if (!updated) return res.status(404).json(errorBody('not_found', 'Endpoint not found', req.id));
      await audit(req, 'endpoint.updated', 'endpoint', updated.id, { fields: Object.keys(patch) });
      return res.json({ endpoint: publicEndpoint(updated) });
    })
  );

  app.post(
    '/v1/endpoints/:id/rotate-secret',
    requireScope('endpoints:write'),
    asyncHandler(async (req, res) => {
      const existing = await store.getEndpoint(req.params.id, req.organizationId);
      if (!existing) return res.status(404).json(errorBody('not_found', 'Endpoint not found', req.id));
      const newSecret = 'whsec_' + crypto.randomBytes(12).toString('hex');
      const updated = await store.rotateEndpointSecret(req.params.id, req.organizationId, encryptSecret(newSecret));
      if (!updated) return res.status(404).json(errorBody('not_found', 'Endpoint not found', req.id));
      await audit(req, 'endpoint.secret_rotated', 'endpoint', updated.id, {});
      return res.json({
        endpoint: publicEndpoint(updated),
        signing_secret: newSecret,
        note: 'The previous secret remains valid for the overlap window; deliveries also carry x-signalmesh-signature-previous.',
      });
    })
  );

  app.delete(
    '/v1/endpoints/:id',
    requireScope('endpoints:write'),
    asyncHandler(async (req, res) => {
      const ep = await store.softDeleteEndpoint(req.params.id, req.organizationId);
      if (!ep) return res.status(404).json(errorBody('not_found', 'Endpoint not found', req.id));
      await audit(req, 'endpoint.deleted', 'endpoint', ep.id, { name: ep.name });
      return res.json({ deleted: true, id: ep.id });
    })
  );

  // ---- deliveries ------------------------------------------------------
  app.get(
    '/v1/deliveries',
    requireScope('deliveries:read'),
    asyncHandler(async (req, res) => {
      const filter = { organizationId: req.organizationId, limit: req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 200) : 50 };
      if (req.query.status) filter.status = String(req.query.status);
      if (req.query.event_id) filter.eventId = String(req.query.event_id);
      if (req.query.endpoint_id) filter.endpointId = String(req.query.endpoint_id);
      if (req.query.delivery_id) filter.deliveryId = String(req.query.delivery_id);
      if (req.query.cursor) filter.cursor = String(req.query.cursor);
      const result = await store.listDeliveries(filter);
      return res.json({ data: result.data.map(publicDelivery), next_cursor: result.next_cursor, total: result.total });
    })
  );

  app.get(
    '/v1/deliveries/:id',
    requireScope('deliveries:read'),
    asyncHandler(async (req, res) => {
      const result = await store.getDelivery(req.params.id, req.organizationId);
      if (!result) return res.status(404).json(errorBody('not_found', 'Delivery not found', req.id));
      const d = result.delivery;
      const attempts = await store.listAttempts(req.params.id, req.organizationId);
      return res.json({
        delivery: publicDelivery(d),
        attempts: attempts || [],
        event: result.event
          ? {
              id: result.event.id,
              event_type: result.event.eventType,
              data: result.event.data,
              occurred_at: result.event.occurredAt,
              metadata: result.event.metadata,
              created_at: result.event.createdAt,
            }
          : null,
        endpoint: result.endpoint
          ? {
              id: result.endpoint.id,
              name: result.endpoint.name,
              url: result.endpoint.url,
              active: result.endpoint.active,
              timeout_seconds: result.endpoint.timeoutMs ? result.endpoint.timeoutMs / 1000 : 10,
              max_attempts: result.endpoint.maxAttempts || 3,
            }
          : null,
      });
    })
  );

  /**
   * Attempt history. The worker has always persisted attempts, but they
   * were never readable - a customer could not find out why a webhook had
   * failed. This is the single most important debugging surface in a
   * delivery product.
   */
  app.get(
    '/v1/deliveries/:id/attempts',
    requireScope('deliveries:read'),
    asyncHandler(async (req, res) => {
      const attempts = await store.listAttempts(req.params.id, req.organizationId);
      if (attempts === null) return res.status(404).json(errorBody('not_found', 'Delivery not found', req.id));
      return res.json({ data: attempts, total: attempts.length });
    })
  );

  app.post(
    '/v1/deliveries/:id/replay',
    requireScope('deliveries:write'),
    asyncHandler(async (req, res) => {
      const result = await store.getDelivery(req.params.id, req.organizationId);
      if (!result) return res.status(404).json(errorBody('not_found', 'Delivery not found', req.id));
      const original = result.delivery;
      const newDelivery = await store.insertDelivery({
        id: genId('dlv'),
        organizationId: req.organizationId,
        eventId: original.eventId,
        eventType: original.eventType,
        endpointId: original.endpointId,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: nowIso(),
        lastStatusCode: null,
        lastError: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        attempts: [],
      });
      const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : null;
      await audit(req, 'delivery.replayed', 'delivery', newDelivery.id, { replay_of: original.id, reason });
      log('info', 'delivery_replayed', { organization_id: req.organizationId, delivery_id: original.id, replay_delivery_id: newDelivery.id, reason });
      return res.status(202).json({ delivery_id: newDelivery.id, status: 'pending', replay_of: original.id, reason });
    })
  );

  app.post(
    '/v1/deliveries/:id/cancel',
    requireScope('deliveries:write'),
    asyncHandler(async (req, res) => {
      const result = await store.getDelivery(req.params.id, req.organizationId);
      if (!result) return res.status(404).json(errorBody('not_found', 'Delivery not found', req.id));
      const original = result.delivery;
      if (original.status === 'processing') {
        return res.status(409).json(errorBody('conflict', 'Delivery is currently processing', req.id));
      }
      if (original.status === 'succeeded' || original.status === 'dead_lettered' || original.status === 'cancelled') {
        return res.json({ delivery_id: original.id, status: original.status });
      }
      await store.updateDelivery(original.id, req.organizationId, { status: 'cancelled', nextAttemptAt: null });
      await audit(req, 'delivery.cancelled', 'delivery', original.id, { reason: (req.body && req.body.reason) || null });
      return res.json({ delivery_id: original.id, status: 'cancelled' });
    })
  );

  // ---- audit -----------------------------------------------------------
  app.get(
    '/v1/audit',
    requireScope('audit:read'),
    asyncHandler(async (req, res) => {
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 200) : 50;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      const result = await store.listAudit({ organizationId: req.organizationId, limit, cursor });
      return res.json({ data: result.data, next_cursor: result.next_cursor, total: result.total });
    })
  );

  // ---- demo receivers (local demo only) -------------------------------
  const demoHits = {};
  app.post(
    '/demo/orders',
    asyncHandler(async (req, res) => {
      const deliveryId = req.headers['x-signalmesh-delivery-id'];
      const result = deliveryId ? await store.getDelivery(deliveryId, null) : null;
      const rawSecrets = result && result.endpoint ? [result.endpoint.signingSecret, result.endpoint.signingSecretPrevious].filter(Boolean) : [];
      const secrets = rawSecrets.map((value) => decryptSecret(value));
      const sig = String(req.headers['x-signalmesh-signature'] || '');
      const ts = String(req.headers['x-signalmesh-timestamp'] || '');
      const body = JSON.stringify(req.body);
      const ok = secrets.some((secret) => verifyDeliverySignature(secret, ts, sig, body));
      if (!ok) return res.status(401).json({ error: 'invalid_signature' });
      return res.json({ ok: true, received_at: new Date().toISOString() });
    })
  );

  app.post('/demo/orders-flaky', (req, res) => {
    demoHits.flaky = (demoHits.flaky || 0) + 1;
    if (demoHits.flaky <= 1) return res.status(500).json({ error: 'flaky failure' });
    return res.json({ ok: true, hit: demoHits.flaky });
  });

  app.post('/demo/orders-down', (req, res) => {
    res.status(500).json({ error: 'destination down' });
  });

  if (config.dashboardEnabled) {
    app.get('/dashboard', (req, res) => {
      res.type('html').send(renderDashboard());
    });
  }

  // Optional scheduler-driven worker tick, for platforms that cannot run a
  // long-lived worker (e.g. Vercel + external cron). Disabled unless a token
  // is configured.
  app.all(
    '/internal/worker-tick',
    asyncHandler(async (req, res) => {
      if (!config.internalToken) {
        return res.status(404).json(errorBody('not_found', 'Route not found', req.id));
      }
      const header = req.headers.authorization || '';
      const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      const provided = bearer || req.headers['x-signalmesh-internal-token'] || '';
      if (!safeEqual(provided, config.internalToken)) {
        return res.status(401).json(errorBody('unauthorized', 'Invalid internal token', req.id));
      }
      await worker.tick();
      return res.json({ ok: true, worker_id: worker.workerId });
    })
  );

  app.use((req, res) => {
    res.status(404).json(errorBody('not_found', 'Route not found', req.id));
  });

  app.use((err, req, res, _next) => {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) {
      log('error', 'internal_error', { request_id: req.id, error: String(err && err.message ? err.message : err) });
    }
    res.status(status).json(errorBody(status >= 500 ? 'internal_error' : 'request_error', status >= 500 ? 'Internal server error' : 'Bad request', req.id));
  });

  app.locals.worker = worker;
  return app;
}

module.exports = { createApp, asyncHandler };
