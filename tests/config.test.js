'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const cwd = path.join(__dirname, '..');
const key = '11'.repeat(32);
const pepper = '22'.repeat(32);

function startStore(env) {
  return execFileSync(process.execPath, ['-e', "require('./src/store')"], {
    cwd,
    env: Object.assign({}, process.env, { SIGNALMESH_ENV: 'production' }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('production refuses a relative data file', () => {
  assert.throws(
    () =>
      startStore({
        SIGNALMESH_DATA_FILE: 'relative.json',
        SIGNALMESH_SECRET_ENCRYPTION_KEY: key,
        SIGNALMESH_API_KEY_PEPPER: pepper,
      }),
    /absolute path/
  );
});

test('production refuses a missing API-key pepper', () => {
  assert.throws(
    () =>
      startStore({
        SIGNALMESH_DATA_FILE: path.join(os.tmpdir(), 'signalmesh-config-check.json'),
        SIGNALMESH_SECRET_ENCRYPTION_KEY: key,
        SIGNALMESH_API_KEY_PEPPER: '',
      }),
    /API_KEY_PEPPER/
  );
});

test('production starts when the required settings are present', () => {
  assert.doesNotThrow(() =>
    startStore({
      SIGNALMESH_DATA_FILE: path.join(os.tmpdir(), 'signalmesh-config-check.json'),
      SIGNALMESH_SECRET_ENCRYPTION_KEY: key,
      SIGNALMESH_API_KEY_PEPPER: pepper,
    })
  );
});
