'use strict';

const config = require('./config');
const util = require('./util');

// The JSON store rewrites the entire file on every mutation and has no
// transactional guarantees. It exists for local demos and must never be
// used for a real deployment, so refuse to start with it in production.
if (config.isProduction && config.storage !== 'postgres') {
  throw new Error('SIGNALMESH_STORAGE=' + config.storage + ' is not supported in production. ' + 'Use SIGNALMESH_STORAGE=postgres with a managed PostgreSQL instance.');
}

const impl = config.storage === 'postgres' ? require('./storage/postgres').createStore(config.db) : require('./storage/json').createStore({ dataFile: config.dataFile });

module.exports = impl;
module.exports.genId = util.genId;
module.exports.nowIso = util.nowIso;
module.exports.stableStringify = util.stableStringify;
module.exports.hashToken = util.hashToken;
module.exports.hashApiKey = util.hashApiKey;
module.exports.newRequestId = util.newRequestId;
module.exports.createJsonStore = (opts) => require('./storage/json').createStore(opts);
module.exports.createPostgresStore = (opts) => require('./storage/postgres').createStore(opts);
