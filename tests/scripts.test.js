'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('test scripts never pass a bare directory to node --test', () => {
  // Node 21+ treats --test arguments as globs/paths. A bare `tests/` is then
  // executed as a module and fails on the Node 22/24 CI matrix.
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!script.includes('node --test')) continue;
    assert.doesNotMatch(script, /node --test\s+tests?\/?(?:\s|$)/, name + ' must use an explicit glob');
    assert.match(script, /node --test(?:\s+--experimental-test-coverage)?\s+"tests\/\*\.test\.js"/, name + ' must select the test files');
  }
});
