'use strict';

// Worker-only entrypoint. Run alongside the API process:
//   SIGNALMESH_ROLE=worker node src/worker-main.js
const store = require('./store');
const worker = require('./worker');
const { createLogger } = require('./logging');

const logger = createLogger({ base: { component: 'worker' } });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { signal, role: 'worker' });
  worker.stop();
  await worker.drain().catch(() => {});
  await Promise.resolve(store.close()).catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

store
  .init()
  .then(() => {
    worker.start();
    logger.info('worker_started', { role: 'worker', worker_id: worker.workerId });
  })
  .catch((err) => {
    logger.error('worker_startup_failed', { error: String(err && err.message ? err.message : err) });
    process.exit(1);
  });
