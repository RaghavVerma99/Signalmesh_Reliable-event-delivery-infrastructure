'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nowIso, genId, hashApiKey } = require('../util');

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
      };
      migrateLegacy();
    } catch (e) {
      state = blankState();
    }
  }

  // Older files have no organization scoping. Create a default org and attach
  // every legacy record so existing demo data keeps working.
  function migrateLegacy() {
    const needsMigration =
      state.organizations.length === 0 &&
      (state.keys.length || state.events.length || state.endpoints.length || state.deliveries.length);
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
      return state.keys
        .filter((k) => k.organizationId === organizationId)
        .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, createdAt: k.createdAt, revokedAt: k.revokedAt }));
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
        if (existing) {
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
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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
      return state.endpoints
        .filter((e) => e.organizationId === organizationId && !e.deletedAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return paginate(rows, f);
    },

    async getDelivery(id, organizationId) {
      const delivery = state.deliveries.find((d) => d.id === id && (!organizationId || d.organizationId === organizationId));
      if (!delivery) return null;
      const event = state.events.find((e) => e.id === delivery.eventId) || null;
      const endpoint = state.endpoints.find((e) => e.id === delivery.endpointId) || null;
      return { delivery, event, endpoint };
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

    // ---- audit ---------------------------------------------------------
    async appendAudit(record) {
      const row = Object.assign({ id: genId('aud'), createdAt: nowIso() }, record);
      state.audit.push(row);
      flush();
      return row;
    },

    async listAudit(filter) {
      const f = filter || {};
      let rows = state.audit.filter((a) => a.organizationId === f.organizationId);
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return paginate(rows, f);
    },
  };

  function paginate(rows, filter) {
    const limit = Math.min(Math.max(1, parseInt(filter.limit, 10) || 50), 200);
    let start = 0;
    if (filter.cursor) {
      start = rows.findIndex((r) => r.createdAt < filter.cursor);
      if (start === -1) start = rows.length;
    }
    const page = rows.slice(start, start + limit);
    const next = page.length === limit && start + limit < rows.length ? page[page.length - 1].createdAt : null;
    return { data: page, next_cursor: next, total: rows.length };
  }
}

module.exports = { createStore };
