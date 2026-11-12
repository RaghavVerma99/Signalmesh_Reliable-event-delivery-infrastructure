'use strict';

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function genId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashApiKey(token) {
  return crypto
    .createHmac('sha256', process.env.SIGNALMESH_API_KEY_PEPPER || '')
    .update(token)
    .digest('hex');
}

function newRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

/**
 * Opaque, stable cursor for keyset pagination.
 *
 * A timestamp alone is not a safe cursor: rows created in the same
 * millisecond share `created_at` and would be skipped (or repeated) by the
 * `created_at < $cursor` predicate. The cursor therefore carries the
 * tie-breaker column as well, and the sort is always
 * `(created_at DESC, id DESC)`.
 */
function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (parsed && typeof parsed.c === 'string' && typeof parsed.i === 'string') return parsed;
  } catch {
    // Fall through to the legacy timestamp-only cursor.
  }
  // Legacy cursors were the raw `created_at` value.
  if (typeof cursor === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(cursor)) return { c: cursor, i: null };
  return null;
}

module.exports = { nowIso, genId, stableStringify, hashToken, hashApiKey, newRequestId, encodeCursor, decodeCursor };
