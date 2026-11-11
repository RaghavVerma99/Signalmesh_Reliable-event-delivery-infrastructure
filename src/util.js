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
  return crypto.createHmac('sha256', process.env.SIGNALMESH_API_KEY_PEPPER || '').update(token).digest('hex');
}

function newRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

module.exports = { nowIso, genId, stableStringify, hashToken, hashApiKey, newRequestId };
