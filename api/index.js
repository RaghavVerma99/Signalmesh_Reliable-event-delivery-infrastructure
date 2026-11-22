'use strict';

/**
 * Vercel serverless entrypoint for the SignalMesh API.
 *
 * Vercel cannot run the delivery worker (functions are request-scoped), so
 * deploy the worker separately. This handler only serves the stateless API
 * with a durable PostgreSQL store. `vercel.json` rewrites every public route
 * (/v1/*, /healthz, /metrics, /dashboard) to this function.
 */
const config = require('../src/config');

const isVercel = !!(process.env.VERCEL || process.env.VERCEL_ENV);

if (isVercel) {
  if (!config.isProduction) {
    throw new Error('Vercel deployments must set SIGNALMESH_ENV=production');
  }
  if (config.storage !== 'postgres') {
    throw new Error('Vercel deployments require SIGNALMESH_STORAGE=postgres (the JSON store has no shared durability)');
  }
  if (!config.db.connectionString) {
    throw new Error('Vercel deployments require DATABASE_URL');
  }
  // DDL is a release step (`npm run migrate`), never a serverless invocation.
  // Setting this before the store is loaded keeps cold starts fast and avoids
  // concurrent schema changes from many function instances.
  process.env.SIGNALMESH_SKIP_MIGRATIONS = 'true';
}

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
