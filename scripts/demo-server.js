'use strict';

/**
 * Starts the API with fast-demo retry settings so the dead-letter scenario
 * completes within seconds instead of an hour. Normal `npm start` is
 * unaffected because these are only defaults when the env var is unset.
 */

process.env.SIGNALMESH_MAX_ATTEMPTS = process.env.SIGNALMESH_MAX_ATTEMPTS || '3';
process.env.SIGNALMESH_RETRY_BASE_DELAY_MS = process.env.SIGNALMESH_RETRY_BASE_DELAY_MS || '1000';
process.env.SIGNALMESH_RETRY_MAX_DELAY_MS = process.env.SIGNALMESH_RETRY_MAX_DELAY_MS || '5000';
process.env.SIGNALMESH_ENABLE_DASHBOARD = process.env.SIGNALMESH_ENABLE_DASHBOARD || 'true';

require('../src/server');
