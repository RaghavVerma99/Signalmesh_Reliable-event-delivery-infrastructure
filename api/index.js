'use strict';

/**
 * Vercel serverless entrypoint for the SignalMesh API.
 *
 * Vercel cannot run the delivery worker (functions are request-scoped), so
 * deploy the worker separately. This handler only serves the stateless API
 * with a durable PostgreSQL store.
 */
const store = require('../src/store');
const { createApp } = require('../src/app');

const app = createApp({ store });

let initPromise = null;
function ensureReady() {
  if (!initPromise) initPromise = store.init();
  return initPromise;
}

module.exports = async function handler(req, res) {
  try {
    await ensureReady();
  } catch {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'storage_unavailable', message: 'Storage is not ready', request_id: null },
      })
    );
    return;
  }
  return app(req, res);
};
