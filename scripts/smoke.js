'use strict';

/**
 * End-to-end smoke test for the local demo flow.
 * Usage: node scripts/smoke.js [baseUrl]
 * Assumes the server is already running (default http://127.0.0.1:8080).
 */

const base = (process.argv[2] || process.env.SIGNALMESH_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');

async function json(method, path, body, headers) {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

async function main() {
  const keyRes = await json('POST', '/v1/keys', { name: 'smoke' });
  assert(keyRes.status === 201, 'key creation should return 201, got ' + keyRes.status);
  const apiKey = keyRes.body.key.key;
  const auth = { authorization: 'Bearer ' + apiKey };

  const epRes = await json('POST', '/v1/endpoints', {
    name: 'smoke-orders',
    url: base + '/demo/orders',
    event_types: ['order.created'],
  }, auth);
  assert(epRes.status === 201, 'endpoint creation should return 201, got ' + epRes.status);
  assert(typeof epRes.body.signing_secret === 'string' && epRes.body.signing_secret.startsWith('whsec_'), 'signing secret returned once');
  const endpointId = epRes.body.endpoint.id;

  // The stored copy must not equal the returned plaintext secret.
  const listed = await json('GET', '/v1/endpoints/' + endpointId, undefined, auth);
  assert(listed.status === 200, 'endpoint lookup should return 200');
  assert(!JSON.stringify(listed.body).includes(epRes.body.signing_secret), 'stored endpoint must not expose plaintext secret');

  const event = { event_type: 'order.created', data: { order_id: 'ord_smoke', amount: 2500 } };
  const first = await json('POST', '/v1/events', event, Object.assign({ 'idempotency-key': 'smoke-key-1' }, auth));
  assert(first.status === 202, 'event ingest should return 202, got ' + first.status);
  assert(first.body.deliveries_created >= 1, 'expected at least one delivery');

  const dup = await json('POST', '/v1/events', event, Object.assign({ 'idempotency-key': 'smoke-key-1' }, auth));
  assert(dup.status === 200, 'duplicate idempotent ingest should return 200, got ' + dup.status);
  assert(dup.body.event_id === first.body.event_id, 'duplicate must return the original event id');

  const conflict = await json('POST', '/v1/events', { event_type: 'order.created', data: { order_id: 'different' } }, Object.assign({ 'idempotency-key': 'smoke-key-1' }, auth));
  assert(conflict.status === 409, 'same key different payload should return 409, got ' + conflict.status);

  let succeeded = false;
  for (let i = 0; i < 20; i++) {
    const list = await json('GET', '/v1/deliveries?status=succeeded&event_id=' + first.body.event_id, undefined, auth);
    if (list.body.data && list.body.data.length > 0) {
      succeeded = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(succeeded, 'delivery should reach succeeded (HMAC signature verified by demo receiver)');

  const metrics = await fetch(base + '/metrics');
  const metricsText = await metrics.text();
  assert(metricsText.includes('delivery_success_total'), 'metrics should expose delivery_success_total');

  console.log('SMOKE OK');
  console.log(JSON.stringify({ event_id: first.body.event_id, deliveries_created: first.body.deliveries_created, endpoint_id: endpointId }, null, 2));
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});
