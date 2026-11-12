'use strict';

/**
 * API key scopes.
 *
 * Scopes were persisted from day one but never enforced, which meant a
 * key created as "read-only" still had full write access. Enforcement is
 * additive: `admin` implies everything, and a write scope implies the
 * matching read scope.
 */
const ALL_SCOPES = ['admin', 'keys:read', 'keys:write', 'events:read', 'events:write', 'endpoints:read', 'endpoints:write', 'deliveries:read', 'deliveries:write', 'audit:read'];

const WRITE_TO_READ = {
  'keys:write': 'keys:read',
  'events:write': 'events:read',
  'endpoints:write': 'endpoints:read',
  'deliveries:write': 'deliveries:read',
};

function isValidScope(scope) {
  return ALL_SCOPES.indexOf(scope) !== -1;
}

/**
 * Normalize a requested scope list: validate, expand write->read, and
 * default to `admin` when nothing was requested at all.
 *
 * An explicitly empty list yields an empty list - the key may do nothing.
 * Silently promoting it to `admin` would be a privilege-escalation bug.
 */
function normalizeScopes(requested) {
  if (requested === undefined || requested === null) return ['admin'];
  if (!Array.isArray(requested)) return ['admin'];
  const clean = [];
  for (const scope of requested) {
    if (typeof scope !== 'string' || !isValidScope(scope)) continue;
    if (clean.indexOf(scope) === -1) clean.push(scope);
    const implied = WRITE_TO_READ[scope];
    if (implied && clean.indexOf(implied) === -1) clean.push(implied);
  }
  return clean;
}

/**
 * The full set of permissions a key grants. A write scope also grants the
 * matching read scope (not the other way round).
 */
function grantedScopes(scopes) {
  const granted = new Set(scopes);
  for (const scope of scopes) {
    const implied = WRITE_TO_READ[scope];
    if (implied) granted.add(implied);
  }
  return granted;
}

/**
 * Returns true when the key is allowed to perform an action requiring
 * `required`. A key with no stored scopes predates scoping and is treated
 * as `admin` so that existing deployments do not break.
 */
function hasScope(key, required) {
  if (!key) return false;
  const scopes = Array.isArray(key.scopes) ? key.scopes : ['admin'];
  if (scopes.indexOf('admin') !== -1) return true;
  return grantedScopes(scopes).has(required);
}

module.exports = { ALL_SCOPES, isValidScope, normalizeScopes, hasScope, grantedScopes, WRITE_TO_READ };
