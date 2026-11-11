'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const API_KEY_PEPPER = process.env.SIGNALMESH_API_KEY_PEPPER || '';

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
  return crypto.createHmac('sha256', API_KEY_PEPPER).update(token).digest('hex');
}

function blankState() {
  return { keys: [], events: [], endpoints: [], deliveries: [], idempotency: {} };
}

let state = blankState();
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state = {
        keys: parsed.keys || [],
        events: parsed.events || [],
        endpoints: parsed.endpoints || [],
        deliveries: parsed.deliveries || [],
        idempotency: parsed.idempotency || {},
      };
    }
  } catch (e) {
    state = blankState();
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  } catch (e) {
    // persistence is best-effort for the MVP demo
  }
}

function persistSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state));
}

function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 500);
}

load();

const store = {
  state,

  createKey(name) {
    const key = 'rel_' + crypto.randomBytes(4).toString('hex') + crypto.randomBytes(12).toString('hex');
    const rec = {
      id: genId('key'),
      name: name || 'default',
      keyHash: hashApiKey(key),
      prefix: key.slice(0, 12),
      createdAt: nowIso(),
      revokedAt: null,
    };
    state.keys.push(rec);
    schedulePersist();
    return { id: rec.id, name: rec.name, key, prefix: rec.prefix, createdAt: rec.createdAt };
  },

  findKeyByToken(token) {
    const hash = hashApiKey(token);
    const rec = state.keys.find((k) => k.keyHash === hash && !k.revokedAt);
    return rec || null;
  },

  revokeKey(id) {
    const rec = state.keys.find((k) => k.id === id);
    if (rec && !rec.revokedAt) {
      rec.revokedAt = nowIso();
      schedulePersist();
    }
    return rec || null;
  },

  insertEvent(event) {
    state.events.push(event);
    schedulePersist();
    return event;
  },

  listEvents(filter) {
    let events = state.events.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (filter && filter.eventType) {
      events = events.filter((e) => e.eventType === filter.eventType);
    }
    const limit = filter && filter.limit ? Math.min(parseInt(filter.limit, 10) || 50, 200) : 50;
    const total = events.length;
    return { data: events.slice(0, limit), next_cursor: null, total };
  },

  insertDelivery(delivery) {
    state.deliveries.push(delivery);
    schedulePersist();
    return delivery;
  },

  listDeliveries(filter) {
    let deliveries = state.deliveries.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (filter.status) deliveries = deliveries.filter((d) => d.status === filter.status);
    if (filter.eventId) deliveries = deliveries.filter((d) => d.eventId === filter.eventId);
    if (filter.endpointId) deliveries = deliveries.filter((d) => d.endpointId === filter.endpointId);
    if (filter.deliveryId) deliveries = deliveries.filter((d) => d.id === filter.deliveryId);
    const limit = filter && filter.limit ? Math.min(parseInt(filter.limit, 10) || 50, 200) : 50;
    const total = deliveries.length;
    return { data: deliveries.slice(0, limit), next_cursor: null, total };
  },

  getDelivery(id) {
    const delivery = state.deliveries.find((d) => d.id === id);
    if (!delivery) return null;
    const event = state.events.find((e) => e.id === delivery.eventId) || null;
    const endpoint = state.endpoints.find((e) => e.id === delivery.endpointId) || null;
    return { delivery, event, endpoint };
  },

  insertEndpoint(endpoint) {
    state.endpoints.push(endpoint);
    schedulePersist();
    return endpoint;
  },

  listEndpoints() {
    return state.endpoints
      .filter((e) => !e.deletedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  },

  getEndpoint(id) {
    const ep = state.endpoints.find((e) => e.id === id);
    if (!ep || ep.deletedAt) return null;
    return ep;
  },

  softDeleteEndpoint(id) {
    const ep = state.endpoints.find((e) => e.id === id);
    if (!ep || ep.deletedAt) return null;
    ep.deletedAt = nowIso();
    ep.active = false;
    schedulePersist();
    return ep;
  },

  findIdempotent(key) {
    return state.idempotency[key] || null;
  },

  saveIdempotent(key, requestHash, responseBody) {
    state.idempotency[key] = { requestHash, responseBody, createdAt: nowIso() };
    schedulePersist();
  },
};

const usePostgres = process.env.SIGNALMESH_STORAGE === 'postgres';
const storeImpl = usePostgres ? require('./storage/postgres').createPostgresStoreFromEnv() : store;

module.exports = storeImpl;
module.exports.genId = genId;
module.exports.stableStringify = stableStringify;
module.exports.hashToken = hashToken;
module.exports.hashApiKey = hashApiKey;
module.exports.nowIso = nowIso;
module.exports.persist = typeof storeImpl.persist === 'function' ? storeImpl.persist.bind(storeImpl) : (async () => {});
module.exports.persistSync = process.env.SIGNALMESH_STORAGE === 'postgres' ? (async () => {}) : persistSync;
module.exports.state = storeImpl.state;