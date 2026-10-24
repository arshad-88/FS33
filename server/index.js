'use strict';
/*
 * FamilyShield HTTP entry point: route table, error envelope, process wiring.
 *
 * Every route module exports plain handler functions with the signature
 *
 *     async handler(req, res)              // no path parameters
 *     async handler(req, res, <one param>) // one trailing path parameter
 *
 * The handler owns the response (it calls sendJson/sendNoContent) and signals
 * failure by throwing an HttpError. This file never inspects payloads: it only
 * maps method + path to a handler, and turns whatever escapes into the frozen
 * error shape { error, message, retryAfterSeconds? } from docs/API.md.
 *
 *   auth.js       requestOtp(req,res)  verifyOtp(req,res)  logout(req,res)
 *   family.js     listFamily(req,res)  createRequest(req,res)
 *                 respondRequest(req,res,id)  removeConnection(req,res,otherUserId)
 *   emergency.js  createEmergency(req,res)  getEmergency(req,res,id)
 *                 cancelEmergency(req,res,id)  listAssignments(req,res)
 *                 acceptAssignment(req,res,id)  declineAssignment(req,res,id)
 *                 submitReport(req,res)  publishHelperLocation(req,res)
 */

const http = require('node:http');
const { EventEmitter } = require('node:events');

const config = require('./config');
const { db, audit } = require('./db');
const { HttpError, log, normalizePhone, nowIso, uuid } = require('./util');
const { setCors, sendJson, sendNoContent, readBody, requireUser, publicUser } = require('./http');
const auth = require('./auth');
const family = require('./family');
const emergency = require('./emergency');

/* ------------------------------------------------------------------ *
 * Route table
 * ------------------------------------------------------------------ */

const routes = [];

/** Registers a route. `:name` segments become params.name for the handler. */
function route(method, path, handler) {
  routes.push({ method, path, segments: splitPath(path), handler });
}

function splitPath(pathname) {
  return String(pathname)
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch (err) {
        return segment; // malformed escape: treat literally, matching will fail
      }
    });
}

function matchRoute(method, pathname) {
  const parts = splitPath(pathname);
  for (const entry of routes) {
    if (entry.method !== method) continue;
    if (entry.segments.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < entry.segments.length; i += 1) {
      const segment = entry.segments[i];
      if (segment.startsWith(':')) params[segment.slice(1)] = parts[i];
      else if (segment !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: entry.handler, params };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Small route adapters
 * ------------------------------------------------------------------ */

/**
 * family.respondRequest() reads `{ action }` from the body, while the frozen
 * contract exposes accept/reject as sub-paths. Instead of forking the module we
 * hand it a minimal request stand-in whose body is the client body plus the
 * action carried by the path.
 */
function withBodyPatch(req, patch) {
  const proxy = new EventEmitter();
  proxy.method = req.method;
  proxy.url = req.url;
  proxy.headers = req.headers;
  proxy.socket = req.socket;
  proxy.destroy = () => {}; // readBody() may call it on oversize input; nothing to tear down
  readBody(req).then(
    (body) => {
      const merged = Buffer.from(JSON.stringify(Object.assign({}, body, patch)));
      process.nextTick(() => {
        proxy.emit('data', merged);
        proxy.emit('end');
      });
    },
    (err) => {
      // Only forward the failure if the handler is still listening; otherwise
      // EventEmitter would turn it into an uncaught 'error' event.
      process.nextTick(() => {
        if (proxy.listenerCount('error') > 0) proxy.emit('error', err);
      });
    }
  );
  return proxy;
}

function respond(action) {
  return (req, res, params) => family.respondRequest(withBodyPatch(req, { action }), res, params.id);
}

/* ------------------------------------------------------------------ *
 * /v1/me — profile and consent flags
 * Expressing consent is per-flag: turning on family alerts never turns on
 * location sharing or helper duty.
 * ------------------------------------------------------------------ */

const PREF_COLUMNS = {
  alertsFamily: 'alerts_family',
  shareLocationOnEmergency: 'share_location',
  nearbyHelperOptIn: 'helper_opt_in'
};

function getMe(req, res) {
  const user = requireUser(req);
  sendJson(res, 200, publicUser(user));
}

async function patchMe(req, res) {
  const user = requireUser(req);
  const body = await readBody(req);
  const assignments = [];
  const values = [];

  if (body.displayName !== undefined) {
    if (typeof body.displayName !== 'string') {
      throw new HttpError(400, 'invalid_body', 'displayName must be a string');
    }
    const displayName = body.displayName.trim();
    if (displayName.length < 1 || displayName.length > 60) {
      throw new HttpError(400, 'invalid_body', 'displayName must be 1..60 characters');
    }
    assignments.push('display_name = ?');
    values.push(displayName);
  }

  if (body.prefs !== undefined) {
    if (!body.prefs || typeof body.prefs !== 'object' || Array.isArray(body.prefs)) {
      throw new HttpError(400, 'invalid_body', 'prefs must be an object');
    }
    for (const [key, column] of Object.entries(PREF_COLUMNS)) {
      if (body.prefs[key] === undefined) continue;
      if (typeof body.prefs[key] !== 'boolean') {
        throw new HttpError(400, 'invalid_body', 'prefs.' + key + ' must be a boolean');
      }
      assignments.push(column + ' = ?');
      values.push(body.prefs[key] ? 1 : 0);
    }
  }

  if (assignments.length) {
    db.prepare('UPDATE users SET ' + assignments.join(', ') + ' WHERE id = ?').run(...values, user.id);
    audit(user.id, 'user.updated', user.id, { fields: assignments.map((a) => a.split(' ')[0]) });
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, publicUser(updated));
}

/* ------------------------------------------------------------------ *
 * /v1/devices — push registration (token status is never assumed)
 * ------------------------------------------------------------------ */

async function registerDevice(req, res) {
  const user = requireUser(req);
  const body = await readBody(req);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || token.length > 4096) {
    throw new HttpError(400, 'invalid_body', 'token must be 1..4096 characters');
  }
  const platform = body.platform === undefined ? 'android' : body.platform;
  if (typeof platform !== 'string' || !/^[a-z0-9_]{2,20}$/.test(platform)) {
    throw new HttpError(400, 'invalid_body', 'platform must be a short lowercase identifier');
  }
  // A token belongs to whichever device last registered it: a handed-over phone
  // must not keep delivering the previous owner's alerts.
  db.prepare(
    `INSERT INTO devices (id, user_id, token, platform, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`
  ).run(uuid(), user.id, token, platform, nowIso());
  audit(user.id, 'device.registered', null, { platform });
  sendNoContent(res);
}

/**
 * Drops push registrations. With a token body only that device is removed
 * (logout on one phone); without one every device of the caller is removed.
 * Ownership is enforced in the WHERE clause, so a caller can never delete a
 * token that belongs to somebody else.
 */
async function unregisterDevice(req, res) {
  const user = requireUser(req);
  const body = await readBody(req);
  const token = typeof body.token === 'string' ? body.token.trim() : '';

  if (token) {
    if (token.length > 4096) throw new HttpError(400, 'invalid_body', 'token must be 1..4096 characters');
    const removal = db.prepare('DELETE FROM devices WHERE token = ? AND user_id = ?').run(token, user.id);
    // `removed` is 0 when the token belongs to somebody else: the audit trail
    // says nothing was dropped instead of claiming a deletion that never happened.
    // Number() because node:sqlite may hand back a BigInt, which JSON.stringify
    // (used by audit) refuses to serialise.
    audit(user.id, 'device.unregistered', null, { scope: 'single', removed: Number(removal.changes) });
  } else {
    const removal = db.prepare('DELETE FROM devices WHERE user_id = ?').run(user.id);
    audit(user.id, 'device.unregistered', null, { scope: 'all', removed: Number(removal.changes) });
  }
  sendNoContent(res);
}

/* ------------------------------------------------------------------ *
 * /v1/blocks — one-way block that severs visibility for both sides
 * ------------------------------------------------------------------ */

async function createBlock(req, res) {
  const user = requireUser(req);
  const body = await readBody(req);

  let targetId = typeof body.userId === 'string' && body.userId ? body.userId : null;
  if (!targetId) {
    if (body.phone === undefined) throw new HttpError(400, 'invalid_body', 'userId or phone is required');
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'invalid_phone', 'Use E.164 format, e.g. +919876543210');
    const target = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    if (!target) throw new HttpError(404, 'not_found', 'No account for that number');
    targetId = target.id;
  }

  if (targetId === user.id) throw new HttpError(400, 'invalid_body', 'You cannot block yourself');
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) throw new HttpError(404, 'not_found', 'No such user');

  db.prepare('INSERT OR IGNORE INTO blocks (id, user_id, blocked_user_id, created_at) VALUES (?,?,?,?)').run(
    uuid(),
    user.id,
    targetId,
    nowIso()
  );
  // Keep the invariant that a blocked pair holds no live connection, so family
  // lists cannot keep showing someone who was explicitly blocked.
  const at = nowIso();
  db.prepare(
    `UPDATE connections SET removed_at = ?
      WHERE removed_at IS NULL
        AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))`
  ).run(at, user.id, targetId, targetId, user.id);
  audit(user.id, 'block.created', targetId, null);
  sendNoContent(res);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

route('GET', '/healthz', (req, res) => sendJson(res, 200, { status: 'ok' }));

route('POST', '/v1/auth/otp/request', auth.requestOtp);
route('POST', '/v1/auth/otp/verify', auth.verifyOtp);
route('POST', '/v1/auth/logout', auth.logout);

route('GET', '/v1/me', getMe);
route('PATCH', '/v1/me', patchMe);

route('GET', '/v1/family', family.listFamily);
route('POST', '/v1/family/requests', family.createRequest);
route('POST', '/v1/family/requests/:id/accept', respond('accept'));
route('POST', '/v1/family/requests/:id/reject', respond('reject'));
route(
  'DELETE',
  '/v1/family/connections/:userId',
  (req, res, params) => family.removeConnection(req, res, params.userId)
);

route('POST', '/v1/emergency', emergency.createEmergency);
route('GET', '/v1/emergency/:id', (req, res, params) => emergency.getEmergency(req, res, params.id));
route(
  'POST',
  '/v1/emergency/:id/cancel',
  (req, res, params) => emergency.cancelEmergency(req, res, params.id)
);

route('GET', '/v1/helper/assignments', emergency.listAssignments);
route(
  'POST',
  '/v1/helper/assignments/:id/accept',
  (req, res, params) => emergency.acceptAssignment(req, res, params.id)
);
route(
  'POST',
  '/v1/helper/assignments/:id/decline',
  (req, res, params) => emergency.declineAssignment(req, res, params.id)
);
// helper_locations is the only pool the nearby matcher reads (emergency.js
// eligibleHelpers()), and docs/API.md section 4 documents the matching rules but
// not the write that feeds them. The module exports publishHelperLocation() for
// exactly this route, so it is wired here; flag it to the contract owner rather
// than leaving the matcher unable to ever see a helper.
route('POST', '/v1/helper/location', emergency.publishHelperLocation);

route('POST', '/v1/reports', emergency.submitReport);
route('POST', '/v1/devices', registerDevice);
route('DELETE', '/v1/devices', unregisterDevice);
route('POST', '/v1/blocks', createBlock);

// URL scanner. Disabled by config unless explicitly opted in; the module
// itself enforces SSRF/redirect/rebind guards (see server/urlscan.js).
if (config.urlScanEnabled) {
  const { scanUrl } = require('./urlscan');
  route('POST', '/v1/scan/url', scanUrl);
}

/* ------------------------------------------------------------------ *
 * Dispatch and the frozen error envelope
 * ------------------------------------------------------------------ */

function notFound(res) {
  sendJson(res, 404, { error: 'not_found', message: 'No such endpoint' });
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    const payload = { error: err.code, message: err.message };
    if (err.extra && typeof err.extra === 'object') Object.assign(payload, err.extra);
    return sendJson(res, err.status, payload);
  }
  // A provider or filesystem failure must never look like a validation error.
  log('unhandled route error:', (err && err.stack) || err);
  return sendJson(res, 500, { error: 'internal', message: 'Unexpected server error' });
}

async function handleRequest(req, res) {
  const startedAt = Date.now();
  setCors(res);

  res.on('finish', () => {
    if (config.devMode) {
      log(req.method, req.url, '->', res.statusCode, Date.now() - startedAt + 'ms');
    } else if (res.statusCode >= 500) {
      log(req.method, req.url, '->', res.statusCode);
    }
  });

  if (req.method === 'OPTIONS') return sendNoContent(res);

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (err) {
    return notFound(res);
  }

  const match = matchRoute(req.method, pathname);
  if (!match) return notFound(res);

  try {
    await match.handler(req, res, match.params);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, err);
  }
}

/* ------------------------------------------------------------------ *
 * Server lifecycle
 * ------------------------------------------------------------------ */

function createServer() {
  const server = http.createServer(handleRequest);
  server.on('clientError', (err, socket) => {
    if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

let activeServer = null;

function start() {
  if (activeServer) return activeServer;
  const server = createServer();
  server.listen(config.port, config.host, () => {
    log('familyshield listening on http://' + config.host + ':' + config.port);
    log(
      'providers: otp=' + config.otpProvider + ' push=' + config.pushProvider +
        (config.webhookUrl ? ' webhook=on' : ' webhook=off') +
        (config.devMode ? ' devMode=on' : '')
    );
  });

  const shutdown = (signal) => {
    log(signal + ' received, closing server');
    server.close(() => {
      try {
        db.close();
      } catch (err) {
        log('database close failed:', err.message);
      }
      process.exit(0);
    });
    // Do not hang forever on keep-alive sockets.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  activeServer = server;
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, handleRequest, matchRoute, routes };
