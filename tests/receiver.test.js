'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const defaultConfig = require('../src/config');
const { encryptSecret, signDelivery } = require('../src/security');

const config = Object.assign({}, defaultConfig, {
  rateLimit: { enabled: false },
  dashboardEnabled: false,
});

const payload = { event_id: 'evt_vec', delivery_id: 'dlv_vec', event_type: 'order.created', data: { id: 42 } };
const body = JSON.stringify(payload);

function receiverApp({ current = 'whsec_current', previous = null } = {}) {
  const store = {
    kind: 'test',
    ping: async () => true,
    getDelivery: async () => ({
      id: 'dlv_vec',
      endpoint: {
        signingSecret: encryptSecret(current),
        signingSecretPrevious: previous ? encryptSecret(previous) : null,
      },
    }),
  };
  return createApp({ store, config });
}

async function post(app, { secret, timestamp = '1790000000', signatureTimestamp = timestamp, bodyBytes = body, signatureBody = body }) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const headers = { 'content-type': 'application/json', 'x-signalmesh-delivery-id': 'dlv_vec' };
    if (secret !== undefined) {
      headers['x-signalmesh-timestamp'] = timestamp;
      headers['x-signalmesh-signature'] = signDelivery(secret, signatureTimestamp, signatureBody);
    }
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/demo/orders', {
      method: 'POST',
      headers,
      body: bodyBytes,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('signature vectors match an independent HMAC implementation', () => {
  const expected =
    'v1=' +
    crypto
      .createHmac('sha256', 'whsec_vector')
      .update('1790000000.' + body)
      .digest('hex');
  assert.equal(signDelivery('whsec_vector', '1790000000', body), expected);
  const next =
    'v1=' +
    crypto
      .createHmac('sha256', 'whsec_vector')
      .update('1790000001.' + body)
      .digest('hex');
  assert.equal(signDelivery('whsec_vector', '1790000001', body), next);
  assert.notEqual(signDelivery('whsec_wrong', '1790000000', body), expected);
});

test('receiver accepts the current secret and rejects tampering', async () => {
  const app = receiverApp();
  assert.equal((await post(app, { secret: 'whsec_current' })).status, 200);
  assert.equal((await post(app, {})).status, 401, 'a missing signature must be rejected');
  assert.equal((await post(app, { secret: 'whsec_wrong' })).status, 401);
  assert.equal((await post(app, { secret: 'whsec_current', bodyBytes: body + ' ', signatureBody: body })).status, 401, 'signature covers exact body bytes');
  assert.equal((await post(app, { secret: 'whsec_current', timestamp: '1790000001', signatureTimestamp: '1790000000' })).status, 401, 'signature covers the timestamp');
});

test('receiver accepts the previous secret during rotation', async () => {
  const app = receiverApp({ current: 'whsec_new', previous: 'whsec_old' });
  assert.equal((await post(app, { secret: 'whsec_old' })).status, 200);
  assert.equal((await post(app, { secret: 'whsec_new' })).status, 200);
  assert.equal((await post(app, { secret: 'whsec_retired' })).status, 401);
});
