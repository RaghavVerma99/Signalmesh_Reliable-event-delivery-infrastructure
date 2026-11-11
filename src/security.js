'use strict';

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');

const IS_PRODUCTION = (process.env.SIGNALMESH_ENV || 'development').toLowerCase() === 'production';
const MAX_RESPONSE_BYTES = Math.max(0, parseInt(process.env.SIGNALMESH_MAX_RESPONSE_BYTES || '16384', 10) || 16384);

const SECRET_ENCRYPTION_KEY_HEX = process.env.SIGNALMESH_SECRET_ENCRYPTION_KEY || '';
const SECRET_ENCRYPTION_KEY = SECRET_ENCRYPTION_KEY_HEX ? Buffer.from(SECRET_ENCRYPTION_KEY_HEX, 'hex') : null;
const API_KEY_PEPPER = process.env.SIGNALMESH_API_KEY_PEPPER || '';

if (IS_PRODUCTION && !SECRET_ENCRYPTION_KEY) {
  throw new Error('SIGNALMESH_SECRET_ENCRYPTION_KEY is required in production');
}

const blockList = new net.BlockList();
blockList.addCIDR('10.0.0.0/8');
blockList.addCIDR('172.16.0.0/12');
blockList.addCIDR('192.168.0.0/16');
blockList.addCIDR('100.64.0.0/10');
blockList.addCIDR('192.0.0.0/24');
blockList.addCIDR('127.0.0.0/8');
blockList.addCIDR('169.254.0.0/16');
blockList.addCIDR('0.0.0.0/8');
blockList.addCIDR('224.0.0.0/4');
blockList.addCIDR('240.0.0.0/4');
blockList.addCIDR('::1/128');
blockList.addCIDR('::/128');
blockList.addCIDR('fc00::/7');
blockList.addCIDR('fe80::/10');
blockList.addCIDR('ff00::/8');

const BLOCKED_OUTBOUND_PORTS = new Set([21, 22, 23, 25, 53, 110, 143, 3306, 5432, 6379, 27017, 15672]);

function isBlockedIp(ip) {
  try {
    const family = String(ip).includes(':') ? 'ipv6' : 'ipv4';
    return blockList.check(ip, family);
  } catch (e) {
    return true;
  }
}

function isLoopbackIp(ip) {
  const s = String(ip);
  if (s.includes(':')) {
    const clean = s.toLowerCase();
    return clean === '::1' || clean.startsWith('::ffff:127.');
  }
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  return first === 127;
}

/**
 * Address policy shared by registration-time and connection-time checks.
 * Loopback is permitted only outside production (local demos/tests).
 */
function isAllowedAddress(ip) {
  const loopback = isLoopbackIp(ip);
  const blocked = isBlockedIp(ip);
  return !blocked || (loopback && !IS_PRODUCTION);
}

/**
 * Custom DNS lookup for outbound HTTP clients. Validates the address that
 * is actually used for the connection, closing the DNS-rebinding window
 * between a pre-flight resolve and the real connect.
 */
function createSafeLookup() {
  return function safeLookup(hostname, options, callback) {
    const opts = typeof options === 'function' ? {} : (options || {});
    const cb = typeof options === 'function' ? options : callback;
    const lookupOpts = { all: true };
    if (opts.family === 4 || opts.family === 6) lookupOpts.family = opts.family;

    dns.lookup(hostname, lookupOpts, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const allowed = list.filter((entry) => isAllowedAddress(entry.address));
      if (!allowed.length) {
        const blocked = new Error('blocked_address');
        blocked.code = 'blocked_address';
        return cb(blocked);
      }
      return cb(null, allowed[0].address, allowed[0].family);
    });
  };
}

async function resolveHostname(hostname) {
  const candidate = String(hostname || '').trim().toLowerCase();
  const isIpLiteral = candidate.includes(':') || /^(\d{1,3}\.){3}\d{1,3}$/.test(candidate);
  let ips = [];
  if (isIpLiteral) {
    ips = [candidate];
  } else if (candidate === 'localhost' || candidate.endsWith('.localhost')) {
    ips = ['127.0.0.1', '::1'];
  } else {
    try {
      const resolved = await dns.promises.resolve(hostname);
      ips = resolved || [];
    } catch (e) {
      return { ok: false, error: 'dns_resolution_failed' };
    }
  }
  return { ok: true, ips };
}

async function validateDeliveryUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'invalid_protocol' };
  }
  if (IS_PRODUCTION && parsed.protocol !== 'https:') {
    return { ok: false, error: 'https_required' };
  }
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!Number.isNaN(port) && BLOCKED_OUTBOUND_PORTS.has(port)) {
    return { ok: false, error: 'blocked_port' };
  }
  const hostname = parsed.hostname;
  if (!hostname) {
    return { ok: false, error: 'missing_hostname' };
  }
  const resolved = await resolveHostname(hostname);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  for (const ip of resolved.ips) {
    const loopback = isLoopbackIp(ip);
    const unsafe = isBlockedIp(ip);
    if (unsafe && !(loopback && !IS_PRODUCTION)) {
      return { ok: false, error: 'blocked_address' };
    }
  }
  return { ok: true, ips: resolved.ips, url: parsed.toString() };
}

/**
 * Re-check a destination URL immediately before an outbound delivery.
 *
 * Defeats DNS rebinding by resolving + validating the connected IP at
 * delivery time rather than only at registration time. Does not re-apply
 * the production HTTPS-only policy (that is a registration-time concern);
 * it only re-applies network-level address/port safety.
 */
async function recheckDeliveryDestination(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'invalid_protocol' };
  }
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!Number.isNaN(port) && BLOCKED_OUTBOUND_PORTS.has(port)) {
    return { ok: false, error: 'blocked_port' };
  }
  const hostname = parsed.hostname;
  if (!hostname) {
    return { ok: false, error: 'missing_hostname' };
  }
  const resolved = await resolveHostname(hostname);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  for (const ip of resolved.ips) {
    const loopback = isLoopbackIp(ip);
    const unsafe = isBlockedIp(ip);
    if (unsafe && !(loopback && !IS_PRODUCTION)) {
      return { ok: false, error: 'blocked_address' };
    }
  }
  return { ok: true, ips: resolved.ips, url: parsed.toString() };
}

function hashApiKey(token) {
  return crypto.createHmac('sha256', API_KEY_PEPPER).update(token).digest('hex');
}

function encryptSecret(plaintext) {
  if (!SECRET_ENCRYPTION_KEY) {
    // Development-only fallback. Production requires SIGNALMESH_SECRET_ENCRYPTION_KEY.
    return 'plain:' + plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptSecret(ciphertextB64) {
  if (typeof ciphertextB64 !== 'string') {
    return ciphertextB64;
  }
  if (ciphertextB64.startsWith('plain:')) {
    return ciphertextB64.slice('plain:'.length);
  }
  if (!ciphertextB64.startsWith('enc:')) {
    // Legacy plaintext value stored before encryption was introduced.
    return ciphertextB64;
  }
  if (!SECRET_ENCRYPTION_KEY) {
    throw new Error('SIGNALMESH_SECRET_ENCRYPTION_KEY is required to decrypt this secret');
  }
  const data = Buffer.from(ciphertextB64.slice('enc:'.length), 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function signDelivery(secret, timestamp, body) {
  const signature = crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
  return 'v1=' + signature;
}

function verifyDeliverySignature(secret, timestamp, signature, body) {
  const expected = signDelivery(secret, timestamp, body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature || '', 'utf8');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  IS_PRODUCTION,
  MAX_RESPONSE_BYTES,
  isBlockedIp,
  isLoopbackIp,
  validateDeliveryUrl,
  recheckDeliveryDestination,
  isAllowedAddress,
  createSafeLookup,
  hashApiKey,
  encryptSecret,
  decryptSecret,
  signDelivery,
  verifyDeliverySignature,
};