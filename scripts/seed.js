'use strict';

/**
 * Seeds a local demo: one organization + API key + three endpoints that
 * exercise the success, retry, and dead-letter paths.
 *
 * Run BEFORE starting the server:
 *   npm run demo:reset   # wipe data + seed
 *   npm run demo:server  # start with fast-demo retry settings
 *   npm run demo:run     # drive the scenario (separate terminal)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'db.json');
const KEY_FILE = path.join(ROOT, 'data', '.demo-key');

if (process.argv.includes('--reset')) {
  try { fs.unlinkSync(DATA_FILE); } catch (e) { /* not present */ }
  try { fs.unlinkSync(KEY_FILE); } catch (e) { /* not present */ }
}

// Require after the optional reset so the store loads a clean state.
const store = require('../src/store');
const { encryptSecret } = require('../src/security');
const { genId, nowIso } = require('../src/util');

const base = (process.env.SIGNALMESH_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');

async function addEndpoint(organizationId, name, eventType, pathname) {
  return store.insertEndpoint({
    id: genId('ep'),
    organizationId,
    name,
    url: base + pathname,
    eventTypes: [eventType],
    active: true,
    signingSecret: encryptSecret('whsec_' + genId('demo')),
    timeoutMs: 10000,
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  });
}

async function main() {
  await store.init();
  const org = await store.createOrganization('demo');
  const created = await store.createKey({ name: 'demo', organizationId: org.id });

  const endpoints = [
    await addEndpoint(org.id, 'demo-ok', 'demo.ok', '/demo/orders'),
    await addEndpoint(org.id, 'demo-flaky', 'demo.flaky', '/demo/orders-flaky'),
    await addEndpoint(org.id, 'demo-down', 'demo.down', '/demo/orders-down'),
  ];

  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(KEY_FILE, created.key);

  console.log('Seeded SignalMesh demo data.');
  console.log('Organization:', org.id, '(' + org.name + ')');
  console.log('API key:', created.key);
  console.log('Key also saved to:', KEY_FILE);
  console.log('Endpoints:');
  for (const ep of endpoints) {
    console.log('  - ' + ep.name + ' -> ' + ep.url + ' [' + ep.eventTypes.join(', ') + ']');
  }
  console.log('');
  console.log('Next: npm run demo:server   (then, in another terminal) npm run demo:run');
  await store.close();
}

main().catch((err) => {
  console.error('Seed failed:', err && err.message ? err.message : err);
  process.exit(1);
});
