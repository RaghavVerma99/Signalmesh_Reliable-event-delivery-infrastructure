'use strict';

// Worker-only entrypoint. Run alongside the API process:
//   SIGNALMESH_ROLE=worker node src/worker-main.js
const store = require('./store');
const worker = require('./worker');

function log(level, msg, fields) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, msg }, fields || {})));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal, role: 'worker' });
  worker.stop();
  await worker.drain().catch(() => {});
  await Promise.resolve(store.close()).catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

store.init()
  .then(() => {
    worker.start();
    log('info', 'worker_started', { role: 'worker', worker_id: worker.workerId });
  })
  .catch((err) => {
    log('error', 'worker_startup_failed', { error: String(err && err.message ? err.message : err) });
    process.exit(1);
  });
