'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nowIso, genId, hashApiKey, encodeCursor, decodeCursor } = require('../util');

/**
 * JSON-file store.
 *
 * Implements the async store contract used by the API and worker. Writes
 * are flushed synchronously before methods return so that acknowledged
 * work survives a process crash (NFR-001). Suitable for local development
 * and demos; use the PostgreSQL store for real deployments.
 */
function createStore(options) {
  const opts = options || {};
  const dataFile = opts.dataFile || path.join(__dirname, '..', '..', 'data', 'db.json');
  const dataDir = path.dirname(dataFile);

  let state = blankState();

  function blankState() {
    return {
      organizations: [],
      keys: [],
      events: [],
      endpoints: [],
      deliveries: [],
      idempotency: {},
      audit: [],
      worker_heartbeats: [],
    };
  }

  function flush() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(state));
  }

  function load() {
    try {
      if (!fs.existsSync(dataFile)) return;
      const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      state = {
        organizations: parsed.organizations || [],
        keys: parsed.keys || [],
        events: parsed.events || [],
        endpoints: parsed.endpoints || [],
        deliveries: parsed.deliveries || [],
        idempotency: parsed.idempotency || {},
        audit: parsed.audit || [],
        worker_heartbeats: parsed.worker_heartbeats || [],
      };
      migrateLegacy();
    } catch {
      state = blankState();
    }
  }

  // Older files have no organization scoping. Create a default org and attach
  // every legacy record so existing demo data keeps working.
  function migrateLegacy() {
    const needsMigration = state.organizations.length === 0 && (state.keys.length || state.events.length || state.endpoints.length || state.deliveries.length);
    if (!needsMigration) return;
    const org = { id: genId('org'), name: 'default', createdAt: nowIso() };
    state.organizations.push(org);
    for (const coll of ['keys', 'events', 'endpoints', 'deliveries']) {
      for (const row of state[coll]) {
        if (!row.organizationId) row.organizationId = org.id;
      }
    }
    for (const id of Object.keys(state.idempotency)) {
      const rec = state.idempotency[id];
      if (rec && !rec.organizationId) {
        const nextId = org.id + '|events|' + id;
        state.idempotency[nextId] = Object.assign({ organizationId: org.id, operation: 'events', key: id }, rec);
        delete state.idempotency[id];
      }
    }
    flush();
  }

  function idemId(organizationId, operation, key) {
    return organizationId + '|' + operation + '|' + key;
  }

  function isExpired(expiresAt) {
    if (!expiresAt) return false;
    const ts = new Date(expiresAt).getTime();
    return Number.isFinite(ts) && ts <= Date.now();
  }

  /**
   * Sort by `(created_at DESC, id DESC)`. The id tie-breaker is what makes
   * keyset pagination lossless when many rows share a timestamp.
   */
  function compareDesc(a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  }

  load();

  return {
    kind: 'json',

    async init() {
      load();
    },

    async close() {},

    async ping() {
      return true;
    },

    // ---- organizations -------------------------------------------------
    async createOrganization(name) {
      const org = { id: genId('org'), name: name || 'default', createdAt: nowIso() };
      state.organizations.push(org);
      flush();
      return org;
    },

    async ensureOrganization(name, id) {
      if (id) {
        const found = state.organizations.find((o) => o.id === id);
        if (found) return found;
      }
      if (name) {
        const found = state.organizations.find((o) => o.name === name);
        if (found) return found;
      }
      return this.createOrganization(name);
    },

    async getOrganization(id) {
      return state.organizations.find((o) => o.id === id) || null;
    },

    // ---- API keys ------------------------------------------------------
    async createKey(input) {
      const key = 'rel_' + crypto.randomBytes(4).toString('hex') + crypto.randomBytes(12).toString('hex');
      const rec = {
        id: genId('key'),
        organizationId: input.organizationId,
        name: input.name || 'default',
        keyHash: hashApiKey(key),
        prefix: key.slice(0, 12),
        scopes: input.scopes || ['admin'],
        createdAt: nowIso(),
        revokedAt: null,
      };
      state.keys.push(rec);
      flush();
      return { id: rec.id, name: rec.name, key, prefix: rec.prefix, scopes: rec.scopes, organizationId: rec.organizationId, createdAt: rec.createdAt };
    },

    async findKeyByToken(token) {
      const hash = hashApiKey(token);
      return state.keys.find((k) => k.keyHash === hash && !k.revokedAt) || null;
    },

    async revokeKey(id, organizationId) {
      const rec = state.keys.find((k) => k.id === id && k.organizationId === organizationId);
      if (!rec) return null;
      if (!rec.revokedAt) {
        rec.revokedAt = nowIso();
        flush();
      }
      return rec;
    },

    async listKeys(organizationId) {
      return state.keys.filter((k) => k.organizationId === organizationId).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, createdAt: k.createdAt, revokedAt: k.revokedAt }));
    },

    async countKeys() {
      return state.keys.length;
    },

    // ---- events + atomic ingest ---------------------------------------
    async ingestEvent(input) {
      const { event, deliveries, idempotency } = input;
      if (idempotency) {
        const key = idemId(idempotency.organizationId, idempotency.operation, idempotency.key);
        const existing = state.idempotency[key];
        // TTL is enforced here. Previously `expiresAt` was written but never
        // read, so a key could be "expired" forever and keep replaying the
        // original response.
        if (existing && isExpired(existing.expiresAt)) {
          delete state.idempotency[key];
        } else if (existing) {
          if (existing.requestHash !== idempotency.requestHash) {
            return { status: 'conflict' };
          }
          return { status: 'duplicate', responseBody: existing.responseBody };
        }
      }
      state.events.push(event);
      for (const d of deliveries) state.deliveries.push(d);
      if (idempotency) {
        const key = idemId(idempotency.organizationId, idempotency.operation, idempotency.key);
        state.idempotency[key] = {
          organizationId: idempotency.organizationId,
          operation: idempotency.operation,
          key: idempotency.key,
          requestHash: idempotency.requestHash,
          responseBody: idempotency.responseBody,
          expiresAt: idempotency.expiresAt || null,
          createdAt: nowIso(),
        };
      }
      flush();
      return { status: 'created', event, deliveries };
    },

    async listEvents(filter) {
      const f = filter || {};
      let rows = state.events.filter((e) => e.organizationId === f.organizationId);
      if (f.eventType) rows = rows.filter((e) => e.eventType === f.eventType);
      rows.sort(compareDesc);
      return paginate(rows, f);
    },

    async getEvent(id, organizationId) {
      return state.events.find((e) => e.id === id && (!organizationId || e.organizationId === organizationId)) || null;
    },

    async getEventForWorker(id) {
      return state.events.find((e) => e.id === id) || null;
    },

    // ---- endpoints -----------------------------------------------------
    async insertEndpoint(endpoint) {
      state.endpoints.push(endpoint);
      flush();
      return endpoint;
    },

    async listEndpoints(organizationId) {
      return state.endpoints.filter((e) => e.organizationId === organizationId && !e.deletedAt).sort(compareDesc);
    },

    /**
     * Paginated variant used by the API. `listEndpoints` stays unpaginated
     * because fan-out at ingest time must see every subscribed endpoint.
     */
    async listEndpointsPage(filter) {
      const f = filter || {};
      const rows = state.endpoints.filter((e) => e.organizationId === f.organizationId && !e.deletedAt).sort(compareDesc);
      return paginate(rows, f);
    },

    async getEndpoint(id, organizationId) {
      const ep = state.endpoints.find((e) => e.id === id && (!organizationId || e.organizationId === organizationId));
      if (!ep || ep.deletedAt) return null;
      return ep;
    },

    async getEndpointForWorker(id) {
      const ep = state.endpoints.find((e) => e.id === id);
      return ep && !ep.deletedAt ? ep : null;
    },

    async updateEndpoint(id, organizationId, patch) {
      const ep = state.endpoints.find((e) => e.id === id && e.organizationId === organizationId && !e.deletedAt);
      if (!ep) return null;
      const allowed = ['name', 'url', 'eventTypes', 'active', 'timeoutMs', 'maxAttempts', 'baseDelayMs', 'maxDelayMs'];
      for (const k of allowed) {
        if (patch[k] !== undefined) ep[k] = patch[k];
      }
      ep.updatedAt = nowIso();
      flush();
      return ep;
    },

    async rotateEndpointSecret(id, organizationId, newCiphertext) {
      const ep = state.endpoints.find((e) => e.id === id && e.organizationId === organizationId && !e.deletedAt);
      if (!ep) return null;
      ep.signingSecretPrevious = ep.signingSecret;
      ep.signingSecret = newCiphertext;
      ep.updatedAt = nowIso();
      flush();
      return ep;
    },

    async softDeleteEndpoint(id, organizationId) {
      const ep = state.endpoints.find((e) => e.id === id && e.organizationId === organizationId && !e.deletedAt);
      if (!ep) return null;
      ep.deletedAt = nowIso();
      ep.active = false;
      ep.updatedAt = nowIso();
      flush();
      return ep;
    },

    // ---- deliveries ----------------------------------------------------
    async insertDelivery(delivery) {
      state.deliveries.push(delivery);
      flush();
      return delivery;
    },

    async listDeliveries(filter) {
      const f = filter || {};
      let rows = state.deliveries.filter((d) => d.organizationId === f.organizationId);
      if (f.status) rows = rows.filter((d) => d.status === f.status);
      if (f.eventId) rows = rows.filter((d) => d.eventId === f.eventId);
      if (f.endpointId) rows = rows.filter((d) => d.endpointId === f.endpointId);
      if (f.deliveryId) rows = rows.filter((d) => d.id === f.deliveryId);
      rows.sort(compareDesc);
      return paginate(rows, f);
    },

    async getDelivery(id, organizationId) {
      const delivery = state.deliveries.find((d) => d.id === id && (!organizationId || d.organizationId === organizationId));
      if (!delivery) return null;
      const event = state.events.find((e) => e.id === delivery.eventId) || null;
      const endpoint = state.endpoints.find((e) => e.id === delivery.endpointId) || null;
      return { delivery, event, endpoint };
    },

    /**
     * Attempt history for a delivery. The worker writes attempts to the
     * store, but they were never exposed through the API, so a customer
     * could not tell *why* a webhook failed.
     */
    async listAttempts(deliveryId, organizationId) {
      const delivery = state.deliveries.find((d) => d.id === deliveryId && (!organizationId || d.organizationId === organizationId));
      if (!delivery) return null;
      const attempts = Array.isArray(delivery.attempts) ? delivery.attempts.slice() : [];
      attempts.sort((a, b) => (a.attemptNumber || 0) - (b.attemptNumber || 0));
      return attempts.map((a) => ({
        attempt_number: a.attemptNumber,
        started_at: a.startedAt || null,
        finished_at: a.finishedAt || null,
        status_code: a.statusCode == null ? null : a.statusCode,
        duration_ms: a.durationMs == null ? null : a.durationMs,
        error_class: a.errorClass || null,
        response_excerpt: a.responseExcerpt || null,
      }));
    },

    /**
     * Delivery counts for many events in one pass. Used by `GET /v1/events`
     * to avoid an N+1 query storm (one COUNT per event on the page).
     */
    async countDeliveriesForEvents(eventIds, organizationId) {
      const ids = Array.isArray(eventIds) ? eventIds : [];
      const counts = new Map();
      for (const id of ids) counts.set(id, 0);
      for (const d of state.deliveries) {
        if (organizationId && d.organizationId !== organizationId) continue;
        if (!counts.has(d.eventId)) continue;
        counts.set(d.eventId, counts.get(d.eventId) + 1);
      }
      return counts;
    },

    async updateDelivery(id, organizationId, patch) {
      const d = state.deliveries.find((row) => row.id === id && row.organizationId === organizationId);
      if (!d) return null;
      Object.assign(d, patch, { updatedAt: nowIso() });
      flush();
      return d;
    },

    async claimDueDelivery(workerId, leaseMs) {
      const now = Date.now();
      const candidates = state.deliveries.filter((d) => {
        if (d.status !== 'pending' && d.status !== 'retry_scheduled') return false;
        if (d.lockedUntil && new Date(d.lockedUntil).getTime() > now) return false;
        if (d.nextAttemptAt && new Date(d.nextAttemptAt).getTime() > now) return false;
        return true;
      });
      candidates.sort((a, b) => {
        const at = a.nextAttemptAt || a.createdAt;
        const bt = b.nextAttemptAt || b.createdAt;
        return at < bt ? -1 : 1;
      });
      const claimed = candidates[0];
      if (!claimed) return null;
      claimed.status = 'processing';
      claimed.lockedBy = workerId;
      claimed.lockedUntil = new Date(now + leaseMs).toISOString();
      claimed.updatedAt = nowIso();
      flush();
      return Object.assign({}, claimed);
    },

    /**
     * Extend the lease of an in-flight delivery.
     *
     * A delivery whose HTTP timeout exceeds the lease would otherwise be
     * reclaimed by a second worker while the first attempt was still running,
     * producing a duplicate webhook. The worker renews the lease for as long
     * as the attempt is in flight.
     */
    async renewLease(deliveryId, workerId, leaseMs) {
      const d = state.deliveries.find((row) => row.id === deliveryId);
      if (!d) return false;
      if (d.lockedBy && workerId && d.lockedBy !== workerId) return false;
      d.lockedUntil = new Date(Date.now() + leaseMs).toISOString();
      d.updatedAt = nowIso();
      flush();
      return true;
    },

    async recordAttempt(input) {
      const { deliveryId, workerId, attempt, outcome } = input;
      const d = state.deliveries.find((row) => row.id === deliveryId);
      if (!d) return null;
      // Stale-worker protection: only the current lease holder may write.
      if (d.lockedBy && workerId && d.lockedBy !== workerId) {
        return { delivery: d, stale: true, dead: false };
      }
      if (!Array.isArray(d.attempts)) d.attempts = [];
      d.attempts.push(attempt);
      d.attemptCount = attempt.attemptNumber;
      d.updatedAt = nowIso();
      d.lockedBy = null;
      d.lockedUntil = null;
      d.lastStatusCode = outcome.statusCode || null;
      d.lastError = outcome.error || null;

      if (outcome.type === 'succeeded') {
        d.status = 'succeeded';
        d.nextAttemptAt = null;
      } else if (outcome.type === 'retry') {
        d.status = 'retry_scheduled';
        d.nextAttemptAt = new Date(Date.now() + (outcome.delayMs || 0)).toISOString();
      } else {
        d.status = 'dead_lettered';
        d.nextAttemptAt = null;
      }
      flush();
      return { delivery: d, dead: outcome.type === 'dead', stale: false };
    },

    async queueMetrics() {
      const now = Date.now();
      let queueDepth = 0;
      let oldest = null;
      for (const d of state.deliveries) {
        if (d.status !== 'pending' && d.status !== 'retry_scheduled') continue;
        if (d.lockedUntil && new Date(d.lockedUntil).getTime() > now) continue;
        if (d.nextAttemptAt && new Date(d.nextAttemptAt).getTime() > now) continue;
        queueDepth += 1;
        if (d.status === 'pending') {
          const age = now - new Date(d.createdAt).getTime();
          if (age > 0 && (oldest === null || age > oldest)) oldest = age;
        }
      }
      return { queueDepth, oldestPendingAgeSeconds: oldest ? oldest / 1000 : 0 };
    },

    async getEndpointSigningSecret(endpointId) {
      const ep = state.endpoints.find((e) => e.id === endpointId);
      return ep ? ep.signingSecret : null;
    },

    /**
     * Record worker liveness. Readiness reporting uses this so a deployment
     * whose workers have all died does not keep advertising itself as ready.
     */
    async recordWorkerHeartbeat(workerId, role) {
      const now = new Date().toISOString();
      const existing = state.worker_heartbeats.find((w) => w.worker_id === workerId);
      if (existing) {
        existing.last_seen_at = now;
        existing.role = role || 'worker';
      } else {
        state.worker_heartbeats.push({ worker_id: workerId, role: role || 'worker', last_seen_at: now, started_at: now });
      }
      const cutoff = Date.now() - 5 * 60 * 1000;
      state.worker_heartbeats = state.worker_heartbeats.filter((w) => new Date(w.last_seen_at).getTime() >= cutoff);
    },

    async listWorkerHeartbeats() {
      return state.worker_heartbeats.slice().sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1));
    },

    // ---- audit ---------------------------------------------------------
    async appendAudit(record) {
      const row = Object.assign({ id: genId('aud'), createdAt: nowIso() }, record);
      state.audit.push(row);
      flush();
      return row;
    },

    async listAudit(filter) {
      const f = filter || {};
      const rows = state.audit.filter((a) => a.organizationId === f.organizationId);
      rows.sort(compareDesc);
      return paginate(rows, f);
    },

    /**
     * Remove expired idempotency records and rows past their retention
     * window. Without this the stores grow without bound and the
     * idempotency table keeps answering for keys that should be reusable.
     */
    async sweepExpired(options) {
      const opts = options || {};
      const now = Date.now();
      let idempotencyRemoved = 0;
      for (const key of Object.keys(state.idempotency)) {
        if (isExpired(state.idempotency[key].expiresAt)) {
          delete state.idempotency[key];
          idempotencyRemoved++;
        }
      }
      let eventsRemoved = 0;
      let deliveriesRemoved = 0;
      let auditRemoved = 0;
      if (opts.eventDays) {
        const cutoff = new Date(now - opts.eventDays * 86400000).toISOString();
        const before = state.events.length;
        state.events = state.events.filter((e) => e.createdAt >= cutoff);
        eventsRemoved = before - state.events.length;
      }
      if (opts.deliveryDays) {
        const cutoff = new Date(now - opts.deliveryDays * 86400000).toISOString();
        const keep = new Set(state.events.map((e) => e.id));
        const before = state.deliveries.length;
        state.deliveries = state.deliveries.filter((d) => d.createdAt >= cutoff || keep.has(d.eventId));
        deliveriesRemoved = before - state.deliveries.length;
      }
      if (opts.auditDays) {
        const cutoff = new Date(now - opts.auditDays * 86400000).toISOString();
        const before = state.audit.length;
        state.audit = state.audit.filter((a) => a.createdAt >= cutoff);
        auditRemoved = before - state.audit.length;
      }
      if (idempotencyRemoved || eventsRemoved || deliveriesRemoved || auditRemoved) flush();
      return { idempotencyRemoved, eventsRemoved, deliveriesRemoved, auditRemoved };
    },
  };

  function paginate(rows, filter) {
    const limit = Math.min(Math.max(1, parseInt(filter.limit, 10) || 50), 200);
    const cursor = decodeCursor(filter.cursor);
    let start = 0;
    if (cursor) {
      start = rows.findIndex((r) => {
        if (r.createdAt < cursor.c) return true;
        if (r.createdAt > cursor.c) return false;
        // Same timestamp: fall back to the id tie-breaker.
        return cursor.i ? r.id < cursor.i : false;
      });
      if (start === -1) start = rows.length;
    }
    const page = rows.slice(start, start + limit);
    const hasMore = start + limit < rows.length;
    const last = page[page.length - 1];
    const next = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
    return { data: page, next_cursor: next, total: rows.length };
  }
}

module.exports = { createStore };
