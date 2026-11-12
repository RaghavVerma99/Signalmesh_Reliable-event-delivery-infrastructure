'use strict';

const config = require('./config');
const util = require('./util');

const impl = require('./storage/json').createStore({ dataFile: config.dataFile });

module.exports = impl;
module.exports.genId = util.genId;
module.exports.nowIso = util.nowIso;
module.exports.stableStringify = util.stableStringify;
module.exports.hashToken = util.hashToken;
module.exports.hashApiKey = util.hashApiKey;
module.exports.newRequestId = util.newRequestId;
module.exports.createJsonStore = (opts) => require('./storage/json').createStore(opts);
