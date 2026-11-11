'use strict';

// API-only entrypoint. Run alongside one or more worker processes:
//   SIGNALMESH_ROLE=api node src/api.js
process.env.SIGNALMESH_ROLE = 'api';
require('./server').start().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'api_startup_failed', error: String(err && err.message ? err.message : err) }));
  process.exit(1);
});
