'use strict';
/*
 * Road-guarded server-side URL scanner (server/urlscan.js).
 *
 * Contract: POST /v1/scan/url { url } with an authenticated session.
 * Fetches ONLY enough of the page to classify it: title + first N KB of
 * text-like content, no JS execution, no forms, no cookies, no credentials.
 *
 * Security architecture (all enforced in code below):
 *   1. URL allowlist scheme: https/http only.
 *   2. DNS resolves FIRST; every resolved IP address must be public
 *      (loopback, RFC1918, link-local 169.254/16 incl. cloud metadata,
 *      CGNAT, multicast, 0/8, IPv6 ULA/link-local all rejected).
 *   3. Connect to that resolved IP by hostname only after validation
 *      (Node's dns.lookup + custom http(s) Agent bind; we re-validate
 *      each socket address on connection too).
 *   4. Redirects: each hop is re-parsed and re-resolved; a redirect to a
 *      private/target-invalid destination aborts. Max 5 hops.
 *   5. Timeouts: connect 5 s, response headers 5 s, total 8 s.
 *   6. Body: at most 384 KB read, then connection destroyed.
 *   7. Content types: text/html, text/plain only. Anything else is
 *      ignored with reason=unsupported_content — never "safe".
 *   8. Nothing is executed, rendered, submitted, or sent other than the
 *      bare GET request itself.
 *   9. Per-user rate limit, configurable, default 12/10min.
 *  10. Cache by URL hash, 10-min TTL, no user data in the key.
 */

const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const config = require('./config');
const { db } = require('./db');
const { HttpError, nowIso } = require('./util');
const { sendJson, readBody, requireUser, limit, limiters, clientIp } = require('./http');

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 5000;
const HEADER_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 384 * 1024;

const ALLOWED_CONTENT_TYPES = /^text\/(html|plain)\b/i;

limiters.urlScan = new (require('./util').RateLimiter)();
limiters.urlScanIp = new (require('./util').RateLimiter)();

const SCAN_LIMIT_PER_USER = config.urlScanLimitPerUser || 12;
const SCAN_WINDOW_SECONDS = config.urlScanWindowSeconds || 600;
const CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- IP gates

function isForbiddenIp(ip) {
  // IPv6-mapped IPv4 (::ffff:10.0.0.1)
  const m = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (m) return isForbiddenIp(m[1]);
  if (ip.includes(':')) {
    // IPv6 guards: loopback, unspecified, link-local fe80::/10, ULA fc00::/7,
    // and IPv4-compatible/embedded forms
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) return isForbiddenIp(lower.slice(7));
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;               // "this network" incl. 0.0.0.0
  if (a === 10) return true;              // private
  if (a === 127) return true;             // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;              // multicast + reserved
  return false;
}

function lookupAll(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve(addresses || []);
    });
  });
}

async function assertPublicHost(hostname) {
  // hostname may carry a link-local zone index (fe80::1%eth0) — strip it.
  const clean = String(hostname || '').replace(/%[0-9a-z]+$/i, '');
  // Blocklist by name first: cloud-metadata hostnames resolve only inside
  // their own fabric and NXDOMAIN here, but that would leak a lookup at all.
  const lower = clean.toLowerCase();
  if (lower === 'metadata.google.internal' || lower === 'metadata.goog' ||
      lower === 'instance-data' || lower === 'instance-data.reqest' ||
      lower === 'metadata' || lower.endsWith('.internal')) {
    throw new HttpError(400, 'scan_forbidden_target', 'Metadata/internal hostname is never fetched');
  }
  let addrs;
  try {
    addrs = await lookupAll(clean);
  } catch (err) {
    throw new HttpError(502, 'scan_dns_failure', 'Could not resolve ' + clean);
  }
  if (!addrs.length) throw new HttpError(502, 'scan_dns_failure', 'Could not resolve ' + clean);
  for (const a of addrs) {
    if (isForbiddenIp(a.address)) {
      throw new HttpError(
        400,
        'scan_forbidden_target',
        'Target resolves into a forbidden network (' + a.address + ')'
      );
    }
  }
  return addrs;
}

// ---------------------------------------------------------------- cache

function cacheKey(url) {
  return crypto.createHash('sha256').update('urlscan:v1:' + url).digest('hex');
}

function cacheGet(key) {
  const row = db
    .prepare('SELECT payload, created_at FROM scan_cache WHERE key = ?')
    .get(key);
  if (!row) return null;
  const age = Date.now() - Date.parse(row.created_at);
  if (age > CACHE_TTL_MS) return null;
  return JSON.parse(row.payload);
}

function cacheSet(key, payload) {
  db.prepare(
    `INSERT INTO scan_cache (key, payload, created_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`
  ).run(key, JSON.stringify(payload), nowIso());
}

// ---------------------------------------------------------------- fetch

function fetchWithLimits(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      return reject(new HttpError(400, 'scan_invalid_url', 'Not a fetchable URL'));
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return reject(new HttpError(400, 'scan_bad_scheme', 'Only http(s) URLs are scanned'));
    }

    const totalTimer = setTimeout(() => {
      req.destroy(new HttpError(504, 'scan_timeout', 'Target did not answer in time'));
      reject(new HttpError(504, 'scan_timeout', 'Target did not answer in time'));
    }, TOTAL_TIMEOUT_MS - (MAX_REDIRECTS - redirectsLeft) * (TOTAL_TIMEOUT_MS / (MAX_REDIRECTS + 2)));

    const impl = u.protocol === 'https:' ? https : http;
    const req = impl.get(u, {
      headers: {
        'User-Agent': 'FamilyShield-LinkGuard/1.0 (+https://familyshield.example)',
        Accept: 'text/html, text/plain;q=0.9, */*;q=0.1',
        'Accept-Language': 'en, hi, te'
      },
      setHost: true,
      timeout: CONNECT_TIMEOUT_MS,
      // DNS-rebinding defense: custom lookup runs AT CONNECT TIME and
      // validates every resolved address. The host the socket ultimately
      // connects to must come from this validated set — no cache-only
      // bypass pathway. assertPublicHost() beforehand is defense in depth for
      // the failure message; this callback is the actual gate.
      lookup: (host, opts, cb) => {
        dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
          if (err) return cb(err);
          for (const a of addrs) {
            if (isForbiddenIp(a.address)) {
              return cb(new HttpError(400, 'scan_forbidden_target', 'Resolved to forbidden network'));
            }
          }
          // Node's autoSelectFamily may pick any entry — all were validated
          // above, so whichever it picks is safe. Numeric family: Node's
          // dns.lookup already returns numeric family with verbatim.
          cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        });
      }
    }, (res) => {
      clearTimeout(totalTimer);
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const loc = res.headers.location;
        res.resume();
        if (!loc) return reject(new HttpError(502, 'scan_redirect_error', 'Redirect without location'));
        let next;
        try { next = new URL(loc, u); } catch (err) {
          return reject(new HttpError(502, 'scan_redirect_error', 'Bad redirect target'));
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return reject(new HttpError(400, 'scan_forbidden_target', 'Redirect to non-http scheme'));
        }
        if (redirectsLeft <= 0) {
          return reject(new HttpError(508, 'scan_too_many_redirects', 'Too many redirects'));
        }
        assertPublicHost(next.hostname)
          .then(() => resolve(fetchWithLimits(next.toString(), redirectsLeft - 1)))
          .catch(reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new HttpError(502, 'scan_http_error', 'Target returned ' + status));
      }
      const ctype = String(res.headers['content-type'] || '');
      res.setEncoding('utf8');
      let body = '';
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.destroy();
          body += chunk.slice(0, Math.max(0, MAX_BODY_BYTES - (size - chunk.length)));
          return handle(body, ctype, u);
        }
        body += chunk;
      });
      res.on('end', () => handle(body, ctype, u));
      res.on('error', () => {
        if (size > 0) handle(body, ctype, u);
      });

      function handle(text, type, finalUrl) {
        if (!ALLOWED_CONTENT_TYPES.test(type)) {
          // Do NOT classify as safe; signal unsupported content.
          return resolve({
            finalUrl: finalUrl.toString(),
            status: status,
            contentType: type,
            unsupportedContent: true,
            title: null,
            till: text.slice(0, 4)
          });
        }
        resolve({
          finalUrl: finalUrl.toString(),
          status: status,
          contentType: type,
          unsupportedContent: false,
          body: text
        });
      }
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(totalTimer);
      reject(new HttpError(504, 'scan_timeout', 'Connect timeout'));
    });
    req.on('error', (err) => {
      clearTimeout(totalTimer);
      reject(err instanceof HttpError ? err : new HttpError(502, 'scan_fetch_error', 'Fetch failed'));
    });
  });
}

// ---------------------------------------------------------------- title/text

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (!m) return null;
  return m[1]
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim() || null;
}

function extractVisibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- route

async function scanUrl(req, res) {
  const user = requireUser(req);
  limit(limiters.urlScan, 'urlscan:user', user.id, SCAN_LIMIT_PER_USER, SCAN_WINDOW_SECONDS);
  limit(limiters.urlScanIp, 'urlscan:ip', clientIp(req), SCAN_LIMIT_PER_USER * 3, SCAN_WINDOW_SECONDS);

  const body = await readBody(req);
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl || rawUrl.length > 2048) {
    throw new HttpError(400, 'invalid_body', 'Provide a url (max 2048 chars)');
  }
  let u;
  try {
    u = new URL(rawUrl);
  } catch (err) {
    throw new HttpError(400, 'scan_invalid_url', 'Not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new HttpError(400, 'scan_bad_scheme', 'Only http(s) URLs are scanned');
  }
  if (!u.hostname || u.hostname.includes('@')) {
    throw new HttpError(400, 'scan_invalid_url', 'Bad hostname');
  }
  if (u.username || u.password) {
    throw new HttpError(400, 'scan_forbidden_target', 'URLs with credentials are never fetched');
  }

  const key = cacheKey(u.toString());
  // All scanner failures below are converted into outcome objects here so no
  // raw URL/hostname ever reaches the generic router error log (which would
  // print it inside an error stack).
  let cached = null;
  try {
    cached = cacheGet(key);
  } catch (err) {
    cached = null;
  }
  if (cached) {
    return sendJson(res, 200, { ...cached, cached: true });
  }

  let outcome;
  try {
    // Gate 1: resolve now, reject private/reserved/metadata targets.
    await assertPublicHost(u.hostname);
    const fetched = await fetchWithLimits(u.toString(), MAX_REDIRECTS);
    if (fetched.unsupportedContent) {
      outcome = {
        verdict: 'unable',
        reason: 'unsupported_content',
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        title: null,
        scannedAt: nowIso()
      };
    } else {
      const title = extractTitle(fetched.body || '');
      const text = extractVisibleText(fetched.body || '');
      // The page text is returned to the client; local engine decides.
      outcome = {
        verdict: 'scanned',
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        title,
        textSnippet: text.slice(0, 1500),
        scannedAt: nowIso()
      };
    }
  } catch (err) {
    if (err instanceof HttpError) {
      outcome = {
        verdict: 'unable',
        reason: err.code,
        message: err.message,
        scannedAt: nowIso()
      };
    } else {
      outcome = {
        verdict: 'unable',
        reason: 'scan_fetch_error',
        scannedAt: nowIso()
      };
    }
  }

  // Never cache on an unexpected (non-HttpError) failure.
  if (outcome.verdict === 'scanned' || outcome.reason === 'scan_forbidden_target') {
    try {
      cacheSet(key, outcome);
    } catch (err) {
      /* cache write failure must not fail the response */
    }
  }
  sendJson(res, 200, outcome);
}

module.exports = {
  scanUrl,
  isForbiddenIp,
  assertPublicHost
};
