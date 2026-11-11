'use strict';

const path = require('path');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

const env = (process.env.SIGNALMESH_ENV || 'development').toLowerCase();
const isProduction = env === 'production';

module.exports = {
  env,
  isProduction,
  host: process.env.HOST || '0.0.0.0',
  port: int('PORT', 8080),
  role: (process.env.SIGNALMESH_ROLE || 'all').toLowerCase(),
  storage: (process.env.SIGNALMESH_STORAGE || 'json').toLowerCase(),
  dataFile: process.env.SIGNALMESH_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
  db: {
    connectionString: process.env.DATABASE_URL || null,
    host: process.env.SIGNALMESH_DB_HOST || 'localhost',
    port: int('SIGNALMESH_DB_PORT', 5432),
    database: process.env.SIGNALMESH_DB_NAME || 'signalmesh',
    user: process.env.SIGNALMESH_DB_USER || 'signalmesh',
    password: process.env.SIGNALMESH_DB_PASSWORD || 'signalmesh',
    ssl: bool('SIGNALMESH_DB_SSL', false),
    max: int('SIGNALMESH_DB_MAX_CONNS', 10),
  },
  worker: {
    concurrency: Math.max(1, int('SIGNALMESH_WORKER_CONCURRENCY', 4)),
    pollIntervalMs: Math.max(50, int('SIGNALMESH_WORKER_POLL_INTERVAL_MS', 1000)),
    leaseMs: Math.max(1, int('SIGNALMESH_WORKER_LEASE_MS', 15000)),
  },
  rateLimit: {
    enabled: bool('SIGNALMESH_RATE_LIMIT', true),
    perMinute: Math.max(1, int('SIGNALMESH_RATE_LIMIT_PER_MINUTE', 600)),
    burst: Math.max(1, int('SIGNALMESH_RATE_LIMIT_BURST', 120)),
  },
  idempotencyTtlMs: Math.max(0, int('SIGNALMESH_IDEMPOTENCY_TTL_MS', 24 * 60 * 60 * 1000)),
  dashboardEnabled: bool('SIGNALMESH_ENABLE_DASHBOARD', !isProduction),
  log: {
    level: process.env.SIGNALMESH_LOG_LEVEL || 'info',
  },
};
