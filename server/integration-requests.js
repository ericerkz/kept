const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

// These rules apply only to CalDAV and web-push delivery, not incoming Kept
// requests, the user's Kept URL, or the existing image/link proxy policies.
const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blockedV4.addSubnet(address, prefix);
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new net.BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blockedV6.addSubnet(address, prefix, 'ipv6');
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  // Restrict IPv6 to global unicast; this also excludes mapped IPv4, local,
  // link-local, multicast, and translation ranges that could reach private IPv4.
  return family === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

function targetError(message) {
  const error = new Error(message);
  error.code = 'OUTBOUND_TARGET_BLOCKED';
  error.status = 400;
  return error;
}

function parseTarget(value, push = false) {
  let url;
  try {
    if (typeof value !== 'string' || !value.trim()) throw new Error();
    url = new URL(value);
  } catch { throw targetError('Invalid destination URL.'); }
  if (push ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) {
    throw targetError(push ? 'Push delivery requires an HTTPS URL.' : 'CalDAV requires an HTTP or HTTPS URL.');
  }
  if (url.username || url.password || url.hash) {
    throw targetError('Destination URLs cannot contain embedded credentials or fragments.');
  }
  return url;
}

function privateOrigins(value, name, push) {
  const origins = new Set();
  for (const item of String(value || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const url = parseTarget(item, push);
    if (url.pathname !== '/' || url.search) throw new Error(`${name} entries must be exact origins (scheme, host and port), without paths or queries.`);
    origins.add(url.origin);
  }
  return origins;
}

function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options?.all;
    if (all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

function checkedSubscription(subscription) {
  const { endpoint, keys } = subscription || {};
  if (typeof endpoint !== 'string' || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
    throw targetError('A valid push subscription is required.');
  }
  const keyBytes = value => {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error();
    return Buffer.from(value, 'base64url');
  };
  try {
    const publicKey = keyBytes(keys.p256dh);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || keyBytes(keys.auth).length !== 16) throw new Error();
    crypto.ECDH.convertKey(publicKey, 'prime256v1');
  } catch { throw targetError('A valid push subscription is required.'); }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function createIntegrationRequests({
  lookup = (hostname, options) => dns.promises.lookup(hostname, options),
  caldavPrivateOrigins = process.env.KEPT_CALDAV_ALLOWED_PRIVATE_ORIGINS,
  pushPrivateOrigins = process.env.KEPT_PUSH_ALLOWED_PRIVATE_ORIGINS
} = {}) {
  const allowedCaldav = privateOrigins(caldavPrivateOrigins, 'KEPT_CALDAV_ALLOWED_PRIVATE_ORIGINS', false);
  const allowedPush = privateOrigins(pushPrivateOrigins, 'KEPT_PUSH_ALLOWED_PRIVATE_ORIGINS', true);

  async function destination(value, push = false) {
    const url = parseTarget(value, push);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const literalFamily = net.isIP(hostname);
    let addresses;
    try {
      addresses = literalFamily ? [{ address: hostname, family: literalFamily }]
        : await lookup(hostname, { all: true, verbatim: true });
    } catch { throw targetError('Could not resolve the destination.'); }
    const privateAllowed = (push ? allowedPush : allowedCaldav).has(url.origin);
    const candidates = addresses.filter(item => net.isIP(item.address) && (privateAllowed || isPublicAddress(item.address)));
    const resolved = candidates.find(item => net.isIP(item.address) === 4) || candidates[0];
    if (!resolved) throw targetError('Private or reserved network destinations require server administrator approval.');
    // Preserve the URL hostname for Host/SNI/certificate verification, but
    // force this connection to the address that just passed validation.
    return { url, lookup: pinnedLookup(resolved.address, net.isIP(resolved.address)) };
  }

  async function validateCaldavUrl(value, { resolveAddress = true } = {}) {
    // Disabling an existing integration must remain possible while its host
    // is offline or newly blocked. Every actual request still validates DNS.
    if (!resolveAddress) return parseTarget(value).href;
    return (await destination(value)).url.href;
  }

  async function caldavRequest(settings, reminderId, method, body) {
    const target = parseTarget(settings.calendarUrl);
    if (reminderId != null) {
      target.pathname = `${target.pathname.replace(/\/?$/, '/')}kept-reminder-${encodeURIComponent(reminderId)}.ics`;
    }
    const checked = await destination(target.href);
    const transport = checked.url.protocol === 'https:' ? https : http;
    const auth = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
    const bytes = body ? Buffer.from(body, 'utf8') : null;
    return new Promise((resolve, reject) => {
      const request = transport.request(checked.url, {
        method, lookup: checked.lookup, agent: false,
        headers: {
          Authorization: `Basic ${auth}`,
          ...(method === 'PROPFIND' ? { 'Content-Type': 'application/xml', Depth: '0' } : {}),
          ...(bytes ? { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Length': bytes.length } : {})
        }
      }, response => {
        response.resume();
        // Do not follow redirects or forward calendar credentials elsewhere.
        if (response.statusCode >= 300 && response.statusCode < 400) reject(new Error('CalDAV redirected the request. Use the final calendar URL.'));
        else if (response.statusCode < 500) resolve({ status: response.statusCode });
        else reject(new Error(`CalDAV ${method} failed: HTTP ${response.statusCode}`));
      });
      request.setTimeout(8000, () => request.destroy(new Error('Connection timed out.')));
      request.on('error', reject);
      request.end(bytes);
    });
  }

  async function validatePushSubscription(value) {
    const subscription = checkedSubscription(value);
    subscription.endpoint = (await destination(subscription.endpoint, true)).url.href;
    return subscription;
  }

  async function sendWebPush(value, payload, webPush) {
    const subscription = checkedSubscription(value);
    const checked = await destination(subscription.endpoint, true);
    subscription.endpoint = checked.url.href;
    // web-push accepts an HTTPS Agent, but ignores a top-level lookup option.
    // A fresh agent also prevents an old pooled socket bypassing a new check.
    const agent = new https.Agent({ lookup: checked.lookup, keepAlive: false, maxSockets: 1 });
    try { return await webPush.sendNotification(subscription, payload, { agent, timeout: 8000 }); }
    finally { agent.destroy(); }
  }

  return { validateCaldavUrl, caldavRequest, validatePushSubscription, sendWebPush };
}

module.exports = { createIntegrationRequests, isPublicAddress };
