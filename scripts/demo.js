'use strict';

/**
 * Drives the demo scenario against a running server:
 *   demo.ok    -> delivered on first attempt
 *   demo.flaky -> fails once, then succeeds on retry
 *   demo.down  -> exhausts retries and dead-letters
 *   replay     -> re-queues the dead-lettered delivery
 *
 * Usage: node scripts/demo.js
 * Prereq: npm run demo:reset && npm run demo:server
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY_FILE = path.join(ROOT, 'data', '.demo-key');
const base = (process.env.SIGNALMESH_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');

const key = process.env.SIGNALMESH_API_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '');
if (!key) {
  console.error('No API key found. Run: npm run demo:reset');
  process.exit(1);
}

const auth = { authorization: 'Bearer ' + key };

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, auth),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function postEvent(eventType, data, idempotencyKey) {
  const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined;
  const res = await api('POST', '/v1/events', { event_type: eventType, data: data }, headers);
  if (res.status !== 202) {
    throw new Error('ingest ' + eventType + ' failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return res.body;
}

async function waitFor(eventId, wanted, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api('GET', '/v1/deliveries?event_id=' + encodeURIComponent(eventId));
    const list = (res.body && res.body.data) || [];
    const match = list.find((d) => wanted.indexOf(d.status) !== -1);
    if (match) return match;
    const pending = list[0];
    process.stdout.write('  ...' + (pending ? pending.status : 'none') + '\r');
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for ' + wanted.join('/') + ' on event ' + eventId);
}

function line(label, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label.padEnd(34) + (detail || ''));
}

async function main() {
  console.log('SignalMesh demo against ' + base + '\n');

  // 1. Happy path
  const okEvent = await postEvent('demo.ok', { order_id: 'ord_demo_ok' });
  const okDlv = await waitFor(okEvent.event_id, ['succeeded'], 15000);
  line('delivered on first attempt', okDlv.attempt_count === 1, 'attempts=' + okDlv.attempt_count);

  // 2. Flaky endpoint retries then succeeds
  const flakyEvent = await postEvent('demo.flaky', { order_id: 'ord_demo_flaky' });
  const flakyDlv = await waitFor(flakyEvent.event_id, ['succeeded'], 30000);
  line('retried then delivered', flakyDlv.attempt_count >= 2, 'attempts=' + flakyDlv.attempt_count);

  // 3. Down endpoint exhausts retries
  const downEvent = await postEvent('demo.down', { order_id: 'ord_demo_down' });
  const downDlv = await waitFor(downEvent.event_id, ['dead_lettered'], 60000);
  line('dead-lettered after retries', downDlv.status === 'dead_lettered', 'attempts=' + downDlv.attempt_count + ' last_error=' + downDlv.last_error);

  // 4. Replay the dead-lettered delivery
  const replay = await api('POST', '/v1/deliveries/' + downDlv.id + '/replay', { reason: 'demo replay' });
  line('replayed dead-lettered delivery', replay.status === 202, 'new delivery=' + (replay.body && replay.body.delivery_id));

  console.log('\nOpen the dashboard: ' + base + '/dashboard');
  console.log('API key (paste into dashboard): ' + key);
}

main().catch((err) => {
  console.error('\nDEMO FAILED:', err.message);
  process.exit(1);
});
