'use strict';

const { Pool } = require('pg');

function createPostgresStore(config) {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
  });

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      prefix TEXT NOT NULL,
      created_at TEXT,
      revoked_at TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      data TEXT NOT NULL,
      occurred_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS endpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      event_types TEXT,
      active BOOLEAN NOT NULL,
      signing_secret TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      base_delay_ms INTEGER NOT NULL,
      max_delay_ms INTEGER NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      next_attempt_at TEXT,
      last_status_code INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      locked_until TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS delivery_attempts (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      status_code INTEGER,
      duration_ms INTEGER,
      error_class TEXT,
      response_excerpt TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS idempotency_records (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT
    )`);
  }

  async function createKey(name) {
    const id = 'key_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const key = 'rel_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 14);
    const keyHash = 'hash_' + key;
    const prefix = key.slice(0, 12);
    const createdAt = new Date().toISOString();
    await pool.query('INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ($1, $2, $3, $4, $5)', [id, name || 'default', keyHash, prefix, createdAt]);
    return { id: id, name: name || 'default', key: key, prefix: prefix, createdAt: createdAt };
  }

  async function findKeyByToken(token) {
    const keyHash = 'hash_' + token;
    const res = await pool.query('SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1', [keyHash]);
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, name: row.name, key: token, prefix: row.prefix, createdAt: row.created_at };
  }

  async function revokeKey(id) {
    const res = await pool.query('UPDATE api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *', [id, new Date().toISOString()]);
    const row = res.rows[0];
    if (!row) {
      const all = await pool.query('SELECT * FROM api_keys WHERE id = $1', [id]);
      return all.rows[0] || null;
    }
    return { id: row.id, name: row.name, revokedAt: row.revoked_at };
  }

  async function insertEvent(event) {
    await pool.query('INSERT INTO events (id, event_type, data, occurred_at, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [event.id, event.eventType, JSON.stringify(event.data || {}), event.occurredAt || null, event.metadata ? JSON.stringify(event.metadata) : null, event.createdAt]);
  }

  async function listEvents(filter) {
    const res = await pool.query('SELECT * FROM events ORDER BY created_at DESC LIMIT $1', [filter && filter.limit ? Math.min(parseInt(filter.limit, 10) || 50, 200) : 50]);
    const data = res.rows.map((e) => ({ id: e.id, eventType: e.event_type, data: e.data ? JSON.parse(e.data) : {}, occurredAt: e.occurred_at, metadata: e.metadata ? JSON.parse(e.metadata) : {}, createdAt: e.created_at }));
    return { data: data, next_cursor: null, total: data.length };
  }

  async function insertDelivery(delivery) {
    await pool.query('INSERT INTO deliveries (id, event_id, event_type, endpoint_id, status, attempt_count, next_attempt_at, last_status_code, last_error, created_at, updated_at, locked_until) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [delivery.id, delivery.eventId, delivery.eventType, delivery.endpointId, delivery.status, delivery.attemptCount || 0, delivery.nextAttemptAt || null, delivery.lastStatusCode || null, delivery.lastError || null, delivery.createdAt, delivery.updatedAt, delivery.lockedUntil || null]);
  }

  async function listDeliveries(filter) {
    const res = await pool.query('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT $1', [filter && filter.limit ? Math.min(parseInt(filter.limit, 10) || 50, 200) : 50]);
    const data = res.rows.map((d) => ({ id: d.id, eventId: d.event_id, eventType: d.event_type, endpointId: d.endpoint_id, status: d.status, attemptCount: d.attempt_count, nextAttemptAt: d.next_attempt_at, lastStatusCode: d.last_status_code, lastError: d.last_error, createdAt: d.created_at, updatedAt: d.updated_at }));
    return { data: data, next_cursor: null, total: data.length };
  }

  async function getDelivery(id) {
    const res = await pool.query('SELECT * FROM deliveries WHERE id = $1', [id]);
    const row = res.rows[0];
    if (!row) return null;
    const evRes = await pool.query('SELECT * FROM events WHERE id = $1', [row.event_id]);
    const epRes = await pool.query('SELECT * FROM endpoints WHERE id = $1', [row.endpoint_id]);
    return { delivery: row, event: evRes.rows[0] || null, endpoint: epRes.rows[0] || null };
  }

  async function insertEndpoint(endpoint) {
    await pool.query('INSERT INTO endpoints (id, name, url, event_types, active, signing_secret, timeout_ms, max_attempts, base_delay_ms, max_delay_ms, created_at, updated_at, deleted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)', [endpoint.id, endpoint.name, endpoint.url, endpoint.eventTypes ? JSON.stringify(endpoint.eventTypes) : null, endpoint.active, endpoint.signingSecret, endpoint.timeoutMs, endpoint.maxAttempts, endpoint.baseDelayMs, endpoint.maxDelayMs, endpoint.createdAt, endpoint.updatedAt, endpoint.deletedAt || null]);
  }

  async function listEndpoints() {
    const res = await pool.query('SELECT * FROM endpoints ORDER BY created_at DESC');
    return res.rows.map((e) => e);
  }

  async function getEndpoint(id) {
    const res = await pool.query('SELECT * FROM endpoints WHERE id = $1', [id]);
    const row = res.rows[0];
    if (!row) return null;
    return row;
  }

  async function softDeleteEndpoint(id) {
    const res = await pool.query('UPDATE endpoints SET active = false, deleted_at = $2 WHERE id = $1 RETURNING *', [id, new Date().toISOString()]);
    const row = res.rows[0];
    return row || null;
  }

  async function findIdempotent(key) {
    const res = await pool.query('SELECT * FROM idempotency_records WHERE key = $1', [key]);
    const row = res.rows[0];
    if (!row) return null;
    return { requestHash: row.request_hash, responseBody: row.response_body ? JSON.parse(row.response_body) : null };
  }

  async function saveIdempotent(key, requestHash, responseBody) {
    await pool.query('INSERT INTO idempotency_records (key, request_hash, response_body, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO UPDATE SET request_hash = $2, response_body = $3, created_at = $4', [key, requestHash, JSON.stringify(responseBody), new Date().toISOString()]);
  }

  return {
    init,
    createKey,
    findKeyByToken,
    revokeKey,
    insertEvent,
    listEvents,
    insertDelivery,
    listDeliveries,
    getDelivery,
    insertEndpoint,
    listEndpoints,
    getEndpoint,
    softDeleteEndpoint,
    findIdempotent,
    saveIdempotent,
    state: { keys: [], events: [], endpoints: [], deliveries: [], idempotency: {} },
    persist: async () => {},
  };
}

function createPostgresStoreFromEnv() {
  return createPostgresStore({
    host: process.env.SIGNALMESH_DB_HOST || 'localhost',
    port: parseInt(process.env.SIGNALMESH_DB_PORT || '5432', 10),
    database: process.env.SIGNALMESH_DB_NAME || 'signalmesh',
    user: process.env.SIGNALMESH_DB_USER || 'signalmesh',
    password: process.env.SIGNALMESH_DB_PASSWORD || 'signalmesh',
    ssl: process.env.SIGNALMESH_DB_SSL === 'true',
  });
}

module.exports = { createPostgresStore, createPostgresStoreFromEnv };