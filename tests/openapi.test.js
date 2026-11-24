'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// Local-only surfaces are intentionally absent from the public API contract.
const INTERNAL_ROUTES = new Set(['/demo/orders', '/demo/orders-flaky', '/demo/orders-down', '/dashboard', '/internal/worker-tick']);

function documentedRoutes() {
  const lines = fs.readFileSync(path.join(root, 'api', 'openapi.yaml'), 'utf8').split(/\r?\n/);
  const start = lines.indexOf('paths:');
  assert.notEqual(start, -1, 'openapi.yaml must declare paths');
  const routes = new Set();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (line && !/^\s/.test(line)) break; // next top-level section
    const pathMatch = /^ {2}(\/[^:]+):\s*$/.exec(line);
    if (pathMatch) {
      current = pathMatch[1];
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (methodMatch && current) routes.add(methodMatch[1].toUpperCase() + ' ' + current);
  }
  return routes;
}

function implementedRoutes() {
  const source = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  const routes = new Set();
  const pattern = /app\.(get|post|put|patch|delete|all)\(\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const method = match[1].toUpperCase();
    const route = match[2].replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    if (METHODS.includes(method.toLowerCase())) routes.add(method + ' ' + route);
  }
  return routes;
}

test('every public Express route is documented in openapi.yaml', () => {
  const documented = documentedRoutes();
  const missing = [...implementedRoutes()].filter((route) => !documented.has(route) && !INTERNAL_ROUTES.has(route.split(' ')[1]));
  assert.deepEqual(missing, [], 'add an OpenAPI path/method when adding a public route');
});

test('every documented OpenAPI route exists in the Express app', () => {
  const implemented = implementedRoutes();
  const stale = [...documentedRoutes()].filter((route) => !implemented.has(route));
  assert.deepEqual(stale, [], 'remove stale OpenAPI operations when removing a route');
});

test('local-only routes stay out of the public contract', () => {
  const documented = documentedRoutes();
  for (const route of INTERNAL_ROUTES) {
    assert.ok(![...documented].some((entry) => entry.endsWith(' ' + route)), route + ' must not be published');
  }
});
