'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signDelivery, verifyDeliverySignature, validateDeliveryUrl, isBlockedIp, recheckDeliveryDestination, encryptSecret, decryptSecret, hashApiKey } = require('../src/security');

test('hmac sign and verify roundtrip', () => {
  const secret = 'whsec_test_secret';
  const timestamp = '1790000000';
  const body = JSON.stringify({ event_id: 'evt_1', data: { order_id: 'ord_1' } });
  const sig = signDelivery(secret, timestamp, body);
  assert.ok(sig.startsWith('v1='));
  assert.equal(verifyDeliverySignature(secret, timestamp, sig, body), true);
  assert.equal(verifyDeliverySignature(secret, timestamp, 'v1=' + '0'.repeat(64), body), false);
  assert.equal(verifyDeliverySignature(secret, timestamp, sig, JSON.stringify({ event_id: 'evt_2' })), false);
});

test('blocked ip ranges include loopback and private addresses', () => {
  assert.equal(isBlockedIp('127.0.0.1'), true);
  assert.equal(isBlockedIp('10.0.0.5'), true);
  assert.equal(isBlockedIp('172.16.0.9'), true);
  assert.equal(isBlockedIp('192.168.1.5'), true);
  assert.equal(isBlockedIp('169.254.169.254'), true);
  assert.equal(isBlockedIp('::1'), true);
  assert.equal(isBlockedIp('fe80::1'), true);
  assert.equal(isBlockedIp('8.8.8.8'), false);
  assert.equal(isBlockedIp('2001:db8::1'), false);
});

test('validateDeliveryUrl rejects unsafe destinations', async () => {
  const privateRes = await validateDeliveryUrl('http://10.0.0.5/hook');
  assert.equal(privateRes.ok, false);
  const portRes = await validateDeliveryUrl('http://127.0.0.1:22/x');
  assert.equal(portRes.ok, false);
  const protoRes = await validateDeliveryUrl('ftp://example.com/x');
  assert.equal(protoRes.ok, false);
});

test('validateDeliveryUrl allows loopback development destination', async () => {
  const res = await validateDeliveryUrl('http://127.0.0.1:8080/demo/orders');
  assert.equal(res.ok, true);
});

test('encryptSecret/decryptSecret roundtrip', () => {
  const secret = 'whsec_abc123';
  const stored = encryptSecret(secret);
  assert.notEqual(stored, secret);
  assert.equal(decryptSecret(stored), secret);
});

test('decryptSecret accepts legacy plaintext secrets', () => {
  assert.equal(decryptSecret('whsec_legacy_plain'), 'whsec_legacy_plain');
});

test('hashApiKey is deterministic and peppered', () => {
  const a = hashApiKey('rel_token_1');
  const b = hashApiKey('rel_token_1');
  assert.equal(a, b);
  assert.notEqual(hashApiKey('rel_token_1'), hashApiKey('rel_token_2'));
});

test('recheckDeliveryDestination blocks private addresses but allows loopback in dev', async () => {
  const privateRes = await recheckDeliveryDestination('http://10.0.0.5/hook');
  assert.equal(privateRes.ok, false);
  assert.equal(privateRes.error, 'blocked_address');
  const loopbackRes = await recheckDeliveryDestination('http://127.0.0.1:8080/demo/orders');
  assert.equal(loopbackRes.ok, true);
});