'use strict';

const { Pool } = require('pg');
const { nowIso, genId, hashApiKey, encodeCursor, decodeCursor } = require('../util');
const { runMigrations } = require('./migrate');
const { createLogger } = require('../logging');

const logger = createLogger({ base: { component: 'store' } });

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Append the keyset cursor predicate to a WHERE clause.
 *
 * The cursor carries `(created_at, id)`. A timestamp-only cursor silently
 * skipped rows that shared a timestamp, so the id tie-breaker is part of the
 * comparison. Placeholder positions are captured explicitly because the two
 * values must not be swapped.
 */
function applyCursor(where, params, cursor) {
  if (!cursor) return;
  if (cursor.i) {
    params.push(cursor.c, cursor.i);
    const createdAtPos = params.length - 1;
    const idPos = params.length;
    where.push('(created_at, id) < ($' + createdAtPos + '::timestamptz, $' + idPos + ')');
  } else {
    params.push(cursor.c);
    where.push('created_at < $' + params.length + '::timestamptz');
  }
}

function mapEvent(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventType: row.event_type,
    data: row.data || {},
    occurredAt: iso(row.occurred_at),
    metadata: row.metadata || {},
    createdAt: iso(row.created_at),
    deliveries: [],
  };
}

function mapEndpoint(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    url: row.url,
    eventTypes: row.event_types || ['*'],
    active: row.active,
    signingSecret: row.signing_secret,
    signingSecretPrevious: row.signing_secret_previous || null,
    timeoutMs: row.timeout_ms,
    maxAttempts: row.max_attempts,
    baseDelayMs: row.base_delay_ms,
    maxDelayMs: row.max_delay_ms,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
  };
}

function mapDelivery(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventId: row.event_id,
    eventType: row.event_type,
    endpointId: row.endpoint_id,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: iso(row.next_attempt_at),
    lockedBy: row.locked_by,
    lockedUntil: iso(row.locked_until),
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    attempts: [],
  };
}

function createStore(config) {
  const poolConfig = config.connectionString
    ? { connectionString: config.connectionString, ssl: config.ssl ? { rejectUnauthorized: false } : false, max: config.max || 10 }
    : {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
        max: config.max || 10,
      };
  const pool = new Pool(poolConfig);

  function log(level, msg, fields) {
    logger[level](msg, fields);
  }

  return {
    kind: 'postgres',

    async init() {
      // On serverless platforms, run `npm run migrate` during deploy instead.
      if (process.env.SIGNALMESH_SKIP_MIGRATIONS === 'true') return;
      await runMigrations(pool, log);
    },

    async close() {
      await pool.end();
    },

    async ping() {
      await pool.query('SELECT 1');
      return true;
    },

    // ---- organizations -------------------------------------------------
    async createOrganization(name) {
      const org = { id: genId('org'), name: name || 'default', createdAt: nowIso() };
      await pool.query('INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)', [org.id, org.name, org.createdAt]);
      return org;
    },

    async ensureOrganization(name, id) {
      if (id) {
        const byId = await pool.query('SELECT * FROM organizations WHERE id = $1', [id]);
        if (byId.rowCount) return { id: byId.rows[0].id, name: byId.rows[0].name, createdAt: iso(byId.rows[0].created_at) };
      }
      if (name) {
        const byName = await pool.query('SELECT * FROM organizations WHERE name = $1', [name]);
        if (byName.rowCount) return { id: byName.rows[0].id, name: byName.rows[0].name, createdAt: iso(byName.rows[0].created_at) };
      }
      return this.createOrganization(name);
    },

    async getOrganization(id) {
      const res = await pool.query('SELECT * FROM organizations WHERE id = $1', [id]);
      return res.rowCount ? { id: res.rows[0].id, name: res.rows[0].name, createdAt: iso(res.rows[0].created_at) } : null;
    },

    // ---- API keys ------------------------------------------------------
    async createKey(input) {
      const key = 'rel_' + require('crypto').randomBytes(4).toString('hex') + require('crypto').randomBytes(12).toString('hex');
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
      await pool.query('INSERT INTO api_keys (id, organization_id, name, key_hash, prefix, scopes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        rec.id,
        rec.organizationId,
        rec.name,
        rec.keyHash,
        rec.prefix,
        JSON.stringify(rec.scopes),
        rec.createdAt,
      ]);
      return { id: rec.id, name: rec.name, key, prefix: rec.prefix, scopes: rec.scopes, organizationId: rec.organizationId, createdAt: rec.createdAt };
    },

    async findKeyByToken(token) {
      const hash = hashApiKey(token);
      const res = await pool.query('SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1', [hash]);
      if (!res.rowCount) return null;
      const row = res.rows[0];
      return {
        id: row.id,
        organizationId: row.organization_id,
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes,
        createdAt: iso(row.created_at),
        revokedAt: iso(row.revoked_at),
      };
    },

    async revokeKey(id, organizationId) {
      const res = await pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING *', [id, organizationId]);
      if (!res.rowCount) {
        const existing = await pool.query('SELECT * FROM api_keys WHERE id = $1 AND organization_id = $2', [id, organizationId]);
        return existing.rowCount ? { id: existing.rows[0].id, name: existing.rows[0].name, revokedAt: iso(existing.rows[0].revoked_at) } : null;
      }
      const row = res.rows[0];
      return { id: row.id, name: row.name, revokedAt: iso(row.revoked_at) };
    },

    async listKeys(organizationId) {
      const res = await pool.query('SELECT * FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC', [organizationId]);
      return res.rows.map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes,
        createdAt: iso(row.created_at),
        revokedAt: iso(row.revoked_at),
      }));
    },

    async countKeys() {
      const res = await pool.query('SELECT count(*)::int AS n FROM api_keys');
      return res.rows[0].n;
    },

    // ---- events + atomic ingest ---------------------------------------
    async ingestEvent(input) {
      const { event, deliveries, idempotency } = input;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (idempotency) {
          const existing = await client.query(
            'SELECT request_hash, response_body FROM idempotency_records WHERE organization_id = $1 AND operation = $2 AND idempotency_key = $3 AND (expires_at IS NULL OR expires_at > now())',
            [idempotency.organizationId, idempotency.operation, idempotency.key]
          );
          if (existing.rowCount) {
            await client.query('ROLLBACK');
            if (existing.rows[0].request_hash !== idempotency.requestHash) return { status: 'conflict' };
            return { status: 'duplicate', responseBody: existing.rows[0].response_body };
          }
        }

        await client.query('INSERT INTO events (id, organization_id, event_type, data, occurred_at, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
          event.id,
          event.organizationId,
          event.eventType,
          JSON.stringify(event.data || {}),
          event.occurredAt || null,
          JSON.stringify(event.metadata || {}),
          event.createdAt,
        ]);

        for (const d of deliveries) {
          await client.query(
            'INSERT INTO deliveries (id, organization_id, event_id, event_type, endpoint_id, status, attempt_count, next_attempt_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [d.id, d.organizationId, d.eventId, d.eventType, d.endpointId, d.status, d.attemptCount || 0, d.nextAttemptAt || null, d.createdAt, d.updatedAt]
          );
        }

        if (idempotency) {
          await client.query(
            'INSERT INTO idempotency_records (id, organization_id, operation, idempotency_key, request_hash, response_status, response_body, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              genId('idem'),
              idempotency.organizationId,
              idempotency.operation,
              idempotency.key,
              idempotency.requestHash,
              idempotency.responseStatus || 202,
              JSON.stringify(idempotency.responseBody || null),
              idempotency.expiresAt || null,
              nowIso(),
            ]
          );
        }

        await client.query('COMMIT');
        return { status: 'created', event, deliveries };
      } catch (err) {
        await client.query('ROLLBACK');
        if (err && err.code === '23505' && idempotency) {
          const existing = await pool.query(
            'SELECT request_hash, response_body FROM idempotency_records WHERE organization_id = $1 AND operation = $2 AND idempotency_key = $3 AND (expires_at IS NULL OR expires_at > now())',
            [idempotency.organizationId, idempotency.operation, idempotency.key]
          );
          if (existing.rowCount) {
            if (existing.rows[0].request_hash !== idempotency.requestHash) return { status: 'conflict' };
            return { status: 'duplicate', responseBody: existing.rows[0].response_body };
          }
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async listEvents(filter) {
      const f = filter || {};
      const params = [f.organizationId];
      const where = ['organization_id = $1'];
      if (f.eventType) {
        params.push(f.eventType);
        where.push('event_type = $' + params.length);
      }
      const cursor = decodeCursor(f.cursor);
      applyCursor(where, params, cursor);
      const limit = Math.min(Math.max(1, parseInt(f.limit, 10) || 50), 200);
      params.push(limit + 1);
      const res = await pool.query('SELECT * FROM events WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT $' + params.length, params);
      const rows = res.rows.slice(0, limit).map(mapEvent);
      const last = rows[rows.length - 1];
      const next = res.rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
      const count = await pool.query(
        'SELECT count(*)::int AS n FROM events WHERE organization_id = $1' + (f.eventType ? ' AND event_type = $2' : ''),
        f.eventType ? [f.organizationId, f.eventType] : [f.organizationId]
      );
      return { data: rows, next_cursor: next, total: count.rows[0].n };
    },

    async getEvent(id, organizationId) {
      const res = await pool.query('SELECT * FROM events WHERE id = $1' + (organizationId ? ' AND organization_id = $2' : ''), organizationId ? [id, organizationId] : [id]);
      return res.rowCount ? mapEvent(res.rows[0]) : null;
    },

    async getEventForWorker(id) {
      return this.getEvent(id, null);
    },

    // ---- endpoints -----------------------------------------------------
    async insertEndpoint(endpoint) {
      await pool.query(
        'INSERT INTO endpoints (id, organization_id, name, url, event_types, active, signing_secret, timeout_ms, max_attempts, base_delay_ms, max_delay_ms, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          endpoint.id,
          endpoint.organizationId,
          endpoint.name,
          endpoint.url,
          JSON.stringify(endpoint.eventTypes || ['*']),
          endpoint.active,
          endpoint.signingSecret,
          endpoint.timeoutMs,
          endpoint.maxAttempts,
          endpoint.baseDelayMs,
          endpoint.maxDelayMs,
          endpoint.createdAt,
          endpoint.updatedAt,
          endpoint.deletedAt || null,
        ]
      );
      return endpoint;
    },

    async listEndpoints(organizationId) {
      const res = await pool.query('SELECT * FROM endpoints WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC', [organizationId]);
      return res.rows.map(mapEndpoint);
    },

    /**
     * Paginated variant used by the API. `listEndpoints` stays unpaginated
     * because fan-out at ingest time must see every subscribed endpoint.
     */
    async listEndpointsPage(filter) {
      const f = filter || {};
      const params = [f.organizationId];
      const where = ['organization_id = $1', 'deleted_at IS NULL'];
      const cursor = decodeCursor(f.cursor);
      applyCursor(where, params, cursor);
      const limit = Math.min(Math.max(1, parseInt(f.limit, 10) || 50), 200);
      params.push(limit + 1);
      const res = await pool.query('SELECT * FROM endpoints WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT $' + params.length, params);
      const rows = res.rows.slice(0, limit).map(mapEndpoint);
      const last = rows[rows.length - 1];
      const next = res.rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
      const count = await pool.query('SELECT count(*)::int AS n FROM endpoints WHERE organization_id = $1 AND deleted_at IS NULL', [f.organizationId]);
      return { data: rows, next_cursor: next, total: count.rows[0].n };
    },

    async getEndpoint(id, organizationId) {
      const res = await pool.query('SELECT * FROM endpoints WHERE id = $1 AND deleted_at IS NULL' + (organizationId ? ' AND organization_id = $2' : ''), organizationId ? [id, organizationId] : [id]);
      return res.rowCount ? mapEndpoint(res.rows[0]) : null;
    },

    async getEndpointForWorker(id) {
      return this.getEndpoint(id, null);
    },

    async updateEndpoint(id, organizationId, patch) {
      const columns = {
        name: 'name',
        url: 'url',
        eventTypes: 'event_types',
        active: 'active',
        timeoutMs: 'timeout_ms',
        maxAttempts: 'max_attempts',
        baseDelayMs: 'base_delay_ms',
        maxDelayMs: 'max_delay_ms',
      };
      const sets = [];
      const params = [id, organizationId];
      for (const key of Object.keys(columns)) {
        if (patch[key] === undefined) continue;
        const value = key === 'eventTypes' ? JSON.stringify(patch[key]) : patch[key];
        params.push(value);
        sets.push(columns[key] + ' = $' + params.length);
      }
      if (!sets.length) return this.getEndpoint(id, organizationId);
      sets.push('updated_at = now()');
      const res = await pool.query('UPDATE endpoints SET ' + sets.join(', ') + ' WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL RETURNING *', params);
      return res.rowCount ? mapEndpoint(res.rows[0]) : null;
    },

    async rotateEndpointSecret(id, organizationId, newCiphertext) {
      const res = await pool.query(
        'UPDATE endpoints SET signing_secret_previous = signing_secret, signing_secret = $3, updated_at = now() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL RETURNING *',
        [id, organizationId, newCiphertext]
      );
      return res.rowCount ? mapEndpoint(res.rows[0]) : null;
    },

    async softDeleteEndpoint(id, organizationId) {
      const res = await pool.query('UPDATE endpoints SET active = false, deleted_at = now(), updated_at = now() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL RETURNING *', [
        id,
        organizationId,
      ]);
      return res.rowCount ? mapEndpoint(res.rows[0]) : null;
    },

    // ---- deliveries ----------------------------------------------------
    async insertDelivery(delivery) {
      await pool.query(
        'INSERT INTO deliveries (id, organization_id, event_id, event_type, endpoint_id, status, attempt_count, next_attempt_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          delivery.id,
          delivery.organizationId,
          delivery.eventId,
          delivery.eventType,
          delivery.endpointId,
          delivery.status,
          delivery.attemptCount || 0,
          delivery.nextAttemptAt || null,
          delivery.createdAt,
          delivery.updatedAt,
        ]
      );
      return delivery;
    },

    async listDeliveries(filter) {
      const f = filter || {};
      const baseParams = [f.organizationId];
      const baseWhere = ['organization_id = $1'];
      const add = (column, value) => {
        baseParams.push(value);
        baseWhere.push(column + ' = $' + baseParams.length);
      };
      if (f.status) add('status', f.status);
      if (f.eventId) add('event_id', f.eventId);
      if (f.endpointId) add('endpoint_id', f.endpointId);
      if (f.deliveryId) add('id', f.deliveryId);

      // Cursor applies to the page query only; the total is the full filtered set.
      const pageParams = baseParams.slice();
      const pageWhere = baseWhere.slice();
      const cursor = decodeCursor(f.cursor);
      applyCursor(pageWhere, pageParams, cursor);
      const limit = Math.min(Math.max(1, parseInt(f.limit, 10) || 50), 200);
      pageParams.push(limit + 1);

      const res = await pool.query('SELECT * FROM deliveries WHERE ' + pageWhere.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT $' + pageParams.length, pageParams);
      const rows = res.rows.slice(0, limit).map(mapDelivery);
      const last = rows[rows.length - 1];
      const next = res.rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
      const count = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE ' + baseWhere.join(' AND '), baseParams);
      return { data: rows, next_cursor: next, total: count.rows[0].n };
    },

    async getDelivery(id, organizationId) {
      const res = await pool.query('SELECT * FROM deliveries WHERE id = $1' + (organizationId ? ' AND organization_id = $2' : ''), organizationId ? [id, organizationId] : [id]);
      if (!res.rowCount) return null;
      const delivery = mapDelivery(res.rows[0]);
      const event = await this.getEvent(delivery.eventId, null);
      const endpoint = await this.getEndpoint(delivery.endpointId, null);
      return { delivery, event, endpoint };
    },

    /**
     * Attempt history for a delivery. The worker writes attempts to the
     * store, but they were never exposed through the API, so a customer
     * could not tell *why* a webhook failed.
     */
    async listAttempts(deliveryId, organizationId) {
      const res = await pool.query(
        `SELECT da.attempt_number, da.started_at, da.finished_at, da.status_code,
                da.duration_ms, da.error_class, da.response_excerpt
           FROM delivery_attempts da
           JOIN deliveries d ON d.id = da.delivery_id
          WHERE da.delivery_id = $1` +
          (organizationId ? ' AND d.organization_id = $2' : '') +
          `
          ORDER BY da.attempt_number ASC`,
        organizationId ? [deliveryId, organizationId] : [deliveryId]
      );
      if (!res.rowCount) {
        const exists = await pool.query('SELECT 1 FROM deliveries WHERE id = $1' + (organizationId ? ' AND organization_id = $2' : ''), organizationId ? [deliveryId, organizationId] : [deliveryId]);
        return exists.rowCount ? [] : null;
      }
      return res.rows.map((row) => ({
        attempt_number: row.attempt_number,
        started_at: iso(row.started_at),
        finished_at: iso(row.finished_at),
        status_code: row.status_code == null ? null : row.status_code,
        duration_ms: row.duration_ms == null ? null : row.duration_ms,
        error_class: row.error_class || null,
        response_excerpt: row.response_excerpt || null,
      }));
    },

    /**
     * Delivery counts for many events in one pass. Used by `GET /v1/events`
     * to avoid an N+1 query storm (one COUNT per event on the page).
     */
    async countDeliveriesForEvents(eventIds, organizationId) {
      const ids = Array.isArray(eventIds) ? eventIds.filter((id) => typeof id === 'string') : [];
      const counts = new Map();
      for (const id of ids) counts.set(id, 0);
      if (!ids.length) return counts;
      const res = await pool.query('SELECT event_id, count(*)::int AS n FROM deliveries WHERE ($1::text IS NULL OR organization_id = $1) AND event_id = ANY($2::text[]) GROUP BY event_id', [
        organizationId || null,
        ids,
      ]);
      for (const row of res.rows) counts.set(row.event_id, row.n);
      return counts;
    },

    async updateDelivery(id, organizationId, patch) {
      const sets = [];
      const params = [id, organizationId];
      const map = { status: 'status', nextAttemptAt: 'next_attempt_at', lastStatusCode: 'last_status_code', lastError: 'last_error' };
      for (const key of Object.keys(map)) {
        if (patch[key] === undefined) continue;
        params.push(patch[key]);
        sets.push(map[key] + ' = $' + params.length);
      }
      if (!sets.length) return (await this.getDelivery(id, organizationId)).delivery;
      sets.push('updated_at = now()');
      const res = await pool.query('UPDATE deliveries SET ' + sets.join(', ') + ' WHERE id = $1 AND organization_id = $2 RETURNING *', params);
      return res.rowCount ? mapDelivery(res.rows[0]) : null;
    },

    async claimDueDelivery(workerId, leaseMs) {
      const res = await pool.query(
        `WITH candidate AS (
           SELECT id FROM deliveries
           WHERE status IN ('pending','retry_scheduled')
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE deliveries d
         SET status = 'processing', locked_by = $1, locked_until = now() + ($2::int * interval '1 millisecond'), updated_at = now()
         FROM candidate c
         WHERE d.id = c.id
         RETURNING d.*`,
        [workerId, leaseMs]
      );
      return res.rowCount ? mapDelivery(res.rows[0]) : null;
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
      const res = await pool.query(
        `UPDATE deliveries
            SET locked_until = now() + ($3::int * interval '1 millisecond')
          WHERE id = $1 AND (locked_by = $2 OR locked_by IS NULL) AND status = 'processing'
        RETURNING id`,
        [deliveryId, workerId, leaseMs]
      );
      return res.rowCount > 0;
    },

    /**
     * Record worker liveness. Readiness reporting uses this so a deployment
     * whose workers have all died does not keep advertising itself as ready.
     */
    async recordWorkerHeartbeat(workerId, role) {
      await pool.query(
        `INSERT INTO worker_heartbeats (worker_id, role, last_seen_at, started_at)
         VALUES ($1, $2, now(), now())
         ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now()`,
        [workerId, role || 'worker']
      );
      await pool.query("DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '5 minutes'");
    },

    async listWorkerHeartbeats() {
      const res = await pool.query('SELECT worker_id, role, last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC');
      return res.rows.map((row) => ({
        worker_id: row.worker_id,
        role: row.role,
        last_seen_at: iso(row.last_seen_at),
      }));
    },

    async recordAttempt(input) {
      const { deliveryId, workerId, attempt, outcome } = input;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cur = await client.query('SELECT locked_by FROM deliveries WHERE id = $1 FOR UPDATE', [deliveryId]);
        if (!cur.rowCount) {
          await client.query('ROLLBACK');
          return null;
        }
        if (cur.rows[0].locked_by && workerId && cur.rows[0].locked_by !== workerId) {
          await client.query('ROLLBACK');
          return { delivery: null, stale: true, dead: false };
        }

        await client.query(
          'INSERT INTO delivery_attempts (id, delivery_id, attempt_number, started_at, finished_at, status_code, duration_ms, error_class, response_excerpt, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (delivery_id, attempt_number) DO NOTHING',
          [genId('att'), deliveryId, attempt.attemptNumber, attempt.startedAt, attempt.finishedAt, attempt.statusCode, attempt.durationMs, attempt.errorClass, attempt.responseExcerpt, nowIso()]
        );

        let status = 'dead_lettered';
        let nextAttemptAt = null;
        if (outcome.type === 'succeeded') status = 'succeeded';
        else if (outcome.type === 'retry') {
          status = 'retry_scheduled';
          nextAttemptAt = new Date(Date.now() + (outcome.delayMs || 0)).toISOString();
        }

        const res = await client.query(
          'UPDATE deliveries SET status = $2, attempt_count = $3, next_attempt_at = $4, locked_by = NULL, locked_until = NULL, last_status_code = $5, last_error = $6, updated_at = now() WHERE id = $1 RETURNING *',
          [deliveryId, status, attempt.attemptNumber, nextAttemptAt, outcome.statusCode || null, outcome.error || null]
        );
        await client.query('COMMIT');
        return { delivery: mapDelivery(res.rows[0]), dead: outcome.type === 'dead', stale: false };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async queueMetrics() {
      const depth = await pool.query(
        `SELECT count(*)::int AS n FROM deliveries
         WHERE status IN ('pending','retry_scheduled')
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND (locked_until IS NULL OR locked_until < now())`
      );
      const age = await pool.query(`SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) AS age FROM deliveries WHERE status = 'pending'`);
      const seconds = age.rows[0].age == null ? 0 : Number(age.rows[0].age);
      return { queueDepth: depth.rows[0].n, oldestPendingAgeSeconds: seconds };
    },

    async getEndpointSigningSecret(endpointId) {
      const res = await pool.query('SELECT signing_secret FROM endpoints WHERE id = $1', [endpointId]);
      return res.rowCount ? res.rows[0].signing_secret : null;
    },

    // ---- audit ---------------------------------------------------------
    async appendAudit(record) {
      const row = Object.assign({ id: genId('aud'), createdAt: nowIso() }, record);
      await pool.query('INSERT INTO audit_log (id, organization_id, actor_key_id, action, resource_type, resource_id, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        row.id,
        row.organizationId || null,
        row.actorKeyId || null,
        row.action,
        row.resourceType || null,
        row.resourceId || null,
        row.metadata ? JSON.stringify(row.metadata) : null,
        row.createdAt,
      ]);
      return row;
    },

    async listAudit(filter) {
      const f = filter || {};
      const params = [f.organizationId];
      const where = ['organization_id = $1'];
      const cursor = decodeCursor(f.cursor);
      applyCursor(where, params, cursor);
      const limit = Math.min(Math.max(1, parseInt(f.limit, 10) || 50), 200);
      params.push(limit + 1);
      const res = await pool.query('SELECT * FROM audit_log WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT $' + params.length, params);
      const data = res.rows.slice(0, limit).map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        actorKeyId: row.actor_key_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        metadata: row.metadata,
        createdAt: iso(row.created_at),
      }));
      const last = data[data.length - 1];
      const next = res.rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
      const count = await pool.query('SELECT count(*)::int AS n FROM audit_log WHERE organization_id = $1', [f.organizationId]);
      return { data, next_cursor: next, total: count.rows[0].n };
    },

    /**
     * Remove expired idempotency records and rows past their retention
     * window. Without this the tables grow without bound and the
     * idempotency table keeps answering for keys that should be reusable.
     */
    async sweepExpired(options) {
      const opts = options || {};
      const idem = await pool.query('DELETE FROM idempotency_records WHERE expires_at IS NOT NULL AND expires_at <= now()');
      let events = { rowCount: 0 };
      let deliveries = { rowCount: 0 };
      let audit = { rowCount: 0 };
      if (opts.eventDays) {
        events = await pool.query("DELETE FROM events WHERE created_at < now() - ($1::int * interval '1 day')", [opts.eventDays]);
      }
      if (opts.deliveryDays) {
        deliveries = await pool.query("DELETE FROM deliveries WHERE created_at < now() - ($1::int * interval '1 day')", [opts.deliveryDays]);
      }
      if (opts.auditDays) {
        audit = await pool.query("DELETE FROM audit_log WHERE created_at < now() - ($1::int * interval '1 day')", [opts.auditDays]);
      }
      return {
        idempotencyRemoved: idem.rowCount,
        eventsRemoved: events.rowCount,
        deliveriesRemoved: deliveries.rowCount,
        auditRemoved: audit.rowCount,
      };
    },
  };
}

module.exports = { createStore };
