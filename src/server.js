'use strict';

const config = require('./config');
const store = require('./store');
const worker = require('./worker');
const { createApp } = require('./app');

let server = null;

function log(level, msg, fields) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, msg }, fields || {})));
}

async function start() {
  await store.init();

  if (config.role !== 'worker') {
    const app = createApp({ store, config, worker });
    server = app.listen(config.port, config.host, () => {
      log('info', 'server_started', { port: config.port, role: config.role, storage: store.kind });
    });
  }

  if (config.role !== 'api') {
    worker.start();
    log('info', 'worker_started', { role: config.role, worker_id: worker.workerId, concurrency: config.worker.concurrency });
  }

  return { server, store, worker };
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal });
  worker.stop();
  await worker.drain().catch(() => {});
  const finish = () => {
    Promise.resolve(store.close()).catch(() => {}).then(() => process.exit(0));
  };
  if (server) server.close(finish);
  else finish();
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  start().catch((err) => {
    log('error', 'startup_failed', { error: String(err && err.message ? err.message : err) });
    process.exit(1);
  });
}

module.exports = { start, shutdown };
