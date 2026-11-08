'use strict';

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');

const IS_PRODUCTION = (process.env.SIGNALMESH_ENV || 'development').toLowerCase() === 'production';
const MAX_RESPONSE_BYTES = Math.max(0, parseInt(process.env.SIGNALMESH_MAX_RESPONSE_BYTES || '16384', 10) || 16384);

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
  signDelivery,
  verifyDeliverySignature,
};