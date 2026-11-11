'use strict';

/**
 * Local smoke test for the Vercel serverless entrypoint (api/index.js).
 * Exercises lazy store init + bootstrap + ingest without starting a worker.
 *
 * Usage: npm run vercel:check
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dataFile = process.env.SIGNALMESH_DATA_FILE || path.join(os.tmpdir(), 'signalmesh-vercel-' + Date.now() + '.json');
process.env.SIGNALMESH_DATA_FILE = dataFile;
process.env.SIGNALMESH_STORAGE = process.env.SIGNALMESH_STORAGE || 'json';
process.env.SIGNALMESH_RATE_LIMIT = 'false';
process.env.SIGNALMESH_ENABLE_DASHBOARD = 'false';

const handler = require('../api/index');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

async function json(base, method, p, body, headers) {
  const res = await fetch(base + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = text; }
  return { status: res.status, body: parsed };
}

async function main() {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    const health = await fetch(base + '/healthz');
    assert(health.status === 200, 'healthz should be 200');

    const boot = await json(base, 'POST', '/v1/keys', { name: 'vercel', organization: 'vercel-check' });
    assert(boot.status === 201, 'bootstrap key should be 201, got ' + boot.status);
    const key = boot.body.key.key;

    const auth = { authorization: 'Bearer ' + key };
    const ingest = await json(base, 'POST', '/v1/events', { event_type: 'check.ok', data: { n: 1 } }, auth);
    assert(ingest.status === 202, 'ingest should be 202, got ' + ingest.status);
    assert(typeof ingest.body.event_id === 'string', 'event id returned');

    const list = await json(base, 'GET', '/v1/events', undefined, auth);
    assert(list.status === 200 && list.body.total === 1, 'event list should contain one event');

    console.log('VERCEL HANDLER OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { fs.unlinkSync(dataFile); } catch (e) { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('VERCEL HANDLER FAILED:', err.message);
  process.exit(1);
});
