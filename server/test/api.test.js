'use strict';
/*
 * End-to-end wiring tests for server/index.js.
 *
 * These talk to the route table over a real HTTP socket (no supertest, no
 * dependencies), so a broken adapter signature in index.js fails here rather
 * than in production. config.js freezes its values at require time, so the
 * environment is set before anything from the server is loaded.
 *
 * The assertions follow docs/API.md: status codes, error envelope, and the
 * honest delivery states (nothing here pretends a push or SMS was sent).
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'familyshield-test-'));
process.env.FS_DATA_DIR = DATA_DIR;
process.env.FS_DEV_MODE = '1';
process.env.FS_OTP_PHONE_LIMIT = '20';
process.env.FS_OTP_IP_LIMIT = '100';
// Pinned so the emergency rate-limit test below knows exactly where the wall is.
process.env.FS_EMERGENCY_RATE_LIMIT = '4';

const index = require('../index.js');

let server;
let port;

/** Boots one real server on an ephemeral port, shared by every test below. */
const ready = (async () => {
  server = index.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return port;
})();

async function teardown() {
  await ready.catch(() => {});
  if (server) {
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch (err) {
        resolve();
      }
    });
  }
  // Close SQLite before deleting: Windows keeps WAL files locked while open.
  try {
    require('../db.js').db.close();
  } catch (err) {
    /* already closed */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (err) {
    /* a lingering WAL handle on Windows is not a test failure */
  }
}

if (typeof after === 'function') after(teardown);

/** Minimal HTTP client: no keep-alive, so teardown never waits on sockets. */
async function call(method, routePath, options) {
  await ready;
  const { body, token, headers, raw } = options || {};
  const payload = raw !== undefined ? Buffer.from(raw) : body === undefined ? null : Buffer.from(JSON.stringify(body));
  const requestHeaders = Object.assign({ Connection: 'close' }, headers);
  if (payload) requestHeaders['Content-Type'] = 'application/json';
  if (payload) requestHeaders['Content-Length'] = payload.length;
  if (token) requestHeaders.Authorization = 'Bearer ' + token;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: routePath, headers: requestHeaders, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (err) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Reads the dev-mode OTP code that auth.js prints to the console. */
async function requestOtpAndReadCode(phone) {
  const original = console.log;
  const codes = [];
  console.log = (...args) => {
    const line = args.join(' ');
    const match = /code (\d{6})/.exec(line);
    if (match) codes.push(match[1]);
    original(...args);
  };
  try {
    const res = await call('POST', '/v1/auth/otp/request', { body: { phone } });
    return { res, code: codes[0] };
  } finally {
    console.log = original;
  }
}

async function signIn(phone) {
  const { res, code } = await requestOtpAndReadCode(phone);
  assert.strictEqual(res.status, 202, 'otp request accepted: ' + res.text);
  assert.ok(res.json.challengeId);
  assert.ok(code, 'dev mode must expose the otp code for tests');
  const verified = await call('POST', '/v1/auth/otp/verify', {
    body: { challengeId: res.json.challengeId, code }
  });
  assert.strictEqual(verified.status, 200, 'otp verify: ' + verified.text);
  assert.ok(verified.json.token);
  return verified.json;
}

test('health check answers without auth', async () => {
  const res = await call('GET', '/healthz');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.status, 'ok');
});

test('route table matches the frozen contract exactly, plus declared extensions', () => {
  const contract = [
    'GET /healthz',
    'POST /v1/auth/otp/request',
    'POST /v1/auth/otp/verify',
    'POST /v1/auth/logout',
    'GET /v1/me',
    'PATCH /v1/me',
    'POST /v1/family/requests',
    'GET /v1/family',
    'POST /v1/family/requests/:id/accept',
    'POST /v1/family/requests/:id/reject',
    'DELETE /v1/family/connections/:userId',
    'POST /v1/emergency',
    'GET /v1/emergency/:id',
    'POST /v1/emergency/:id/cancel',
    'GET /v1/helper/assignments',
    'POST /v1/helper/assignments/:id/accept',
    'POST /v1/helper/assignments/:id/decline',
    'POST /v1/reports',
    'POST /v1/devices',
    'DELETE /v1/devices',
    'POST /v1/blocks'
  ];
  // docs/API.md documents the nearby matching rules but no write endpoint that
  // fills helper_locations, which emergency.js eligibleHelpers() reads. index.js
  // wires emergency.publishHelperLocation() so the matcher can ever see anyone;
  // it is additive and never shadows a contract route.
  // POST /v1/scan/url is the guarded URL scanner (server/urlscan.js); it is
  // additive, authenticated, rate-limited, and SSRF-guarded, and can be
  // disabled entirely with FS_URL_SCAN_ENABLED=0.
  const documentedExtensions = ['POST /v1/helper/location', 'POST /v1/scan/url'];

  const actual = index.routes.map((entry) => entry.method + ' ' + entry.path);
  const duplicates = actual.filter((route, i) => actual.indexOf(route) !== i);
  assert.deepStrictEqual(duplicates, [], 'no duplicate routes');
  assert.deepStrictEqual(
    actual.slice().sort(),
    contract.concat(documentedExtensions).sort(),
    'route table must be exactly the contract plus declared extensions'
  );
});

test('unknown endpoints and unauthenticated calls use the error envelope', async () => {
  const missing = await call('GET', '/v1/nope');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.json.error, 'not_found');
  assert.ok(typeof missing.json.message === 'string');

  const me = await call('GET', '/v1/me');
  assert.strictEqual(me.status, 401);
  assert.strictEqual(me.json.error, 'unauthorized');
  assert.ok(typeof me.json.message === 'string');

  const fake = await call('GET', '/v1/me', { token: 'not-a-real-token' });
  assert.strictEqual(fake.status, 401);
  assert.strictEqual(fake.json.error, 'unauthorized');
});

test('preflight is answered with CORS headers', async () => {
  const res = await call('OPTIONS', '/v1/me');
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-methods'], /PATCH/);
  assert.match(res.headers['access-control-allow-headers'], /Idempotency-Key/);
});

test('invalid phone numbers are rejected before any work happens', async () => {
  const res = await call('POST', '/v1/auth/otp/request', { body: { phone: '12345' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'invalid_phone');
});

test('a wrong otp code is a 400 invalid_code, not a 500', async () => {
  const { res, code } = await requestOtpAndReadCode('+919000000010');
  assert.strictEqual(res.status, 202);
  const wrong = code === '123456' ? '123457' : '123456';
  const verified = await call('POST', '/v1/auth/otp/verify', {
    body: { challengeId: res.json.challengeId, code: wrong }
  });
  assert.strictEqual(verified.status, 400, verified.text);
  assert.strictEqual(verified.json.error, 'invalid_code');
});

test('logout is 204 and the token stops working', async () => {
  const session = await signIn('+919000000011');
  const before = await call('GET', '/v1/me', { token: session.token });
  assert.strictEqual(before.status, 200);

  const out = await call('POST', '/v1/auth/logout', { token: session.token });
  assert.strictEqual(out.status, 204);
  assert.strictEqual(out.text, '');

  const after = await call('GET', '/v1/me', { token: session.token });
  assert.strictEqual(after.status, 401);
  assert.strictEqual(after.json.error, 'unauthorized');
});

test('malformed json is rejected as invalid_body', async () => {
  const session = await signIn('+919000000012');
  const res = await call('PATCH', '/v1/me', { token: session.token, raw: '{"displayName": ' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'invalid_body');
});

test('profile patch keeps consent flags independent', async () => {
  const session = await signIn('+919000000002');
  const patched = await call('PATCH', '/v1/me', {
    token: session.token,
    body: { displayName: 'Asha', prefs: { nearbyHelperOptIn: true } }
  });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.json.displayName, 'Asha');
  assert.strictEqual(patched.json.prefs.nearbyHelperOptIn, true);
  assert.strictEqual(patched.json.prefs.alertsFamily, true);
  assert.strictEqual(patched.json.prefs.shareLocationOnEmergency, true);

  const read = await call('GET', '/v1/me', { token: session.token });
  assert.strictEqual(read.json.displayName, 'Asha');

  const bad = await call('PATCH', '/v1/me', {
    token: session.token,
    body: { prefs: { alertsFamily: 'yes' } }
  });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.error, 'invalid_body');
});

test('family accept and revoke work through the path-based adapters', async () => {
  const asha = await signIn('+919000000003');
  const ravi = await signIn('+919000000004');
  await call('PATCH', '/v1/me', { token: ravi.token, body: { displayName: 'Ravi' } });

  const created = await call('POST', '/v1/family/requests', {
    token: asha.token,
    body: { phone: '+919000000004' }
  });
  assert.strictEqual(created.status, 200, created.text);
  assert.strictEqual(created.json.request.status, 'pending');

  const incoming = await call('GET', '/v1/family', { token: ravi.token });
  assert.strictEqual(incoming.status, 200);
  assert.strictEqual(incoming.json.incoming.length, 1);
  const requestId = incoming.json.incoming[0].id;

  // respondRequest() reads body.action; the adapter injects it from the path,
  // and the client sends no body at all.
  const accepted = await call('POST', '/v1/family/requests/' + requestId + '/accept', {
    token: ravi.token,
    body: {}
  });
  assert.strictEqual(accepted.status, 200, accepted.text);
  assert.strictEqual(accepted.json.request.status, 'accepted');

  const afterAccept = await call('GET', '/v1/family', { token: asha.token });
  assert.strictEqual(afterAccept.json.connections.length, 1);
  assert.strictEqual(afterAccept.json.connections[0].name, 'Ravi');

  const revoked = await call('DELETE', '/v1/family/connections/' + ravi.user.id, {
    token: asha.token
  });
  assert.strictEqual(revoked.status, 204, revoked.text);

  const afterRevoke = await call('GET', '/v1/family', { token: asha.token });
  assert.strictEqual(afterRevoke.json.connections.length, 0);
});

test('family reject closes the request without creating a connection', async () => {
  const asha = await signIn('+919000000013');
  const ravi = await signIn('+919000000014');

  await call('POST', '/v1/family/requests', { token: asha.token, body: { phone: '+919000000014' } });
  const incoming = await call('GET', '/v1/family', { token: ravi.token });
  const requestId = incoming.json.incoming[0].id;

  const rejected = await call('POST', '/v1/family/requests/' + requestId + '/reject', {
    token: ravi.token
  });
  assert.strictEqual(rejected.status, 200, rejected.text);
  assert.strictEqual(rejected.json.request.status, 'rejected');

  const afterReject = await call('GET', '/v1/family', { token: ravi.token });
  assert.strictEqual(afterReject.json.incoming.length, 0);
  assert.strictEqual(afterReject.json.connections.length, 0);
});

test('a duplicate pending request surfaces as 409', async () => {
  const asha = await signIn('+919000000015');
  const ravi = await signIn('+919000000016');

  const first = await call('POST', '/v1/family/requests', {
    token: asha.token,
    body: { phone: '+919000000016' }
  });
  assert.strictEqual(first.status, 200, first.text);

  const second = await call('POST', '/v1/family/requests', {
    token: asha.token,
    body: { phone: '+919000000016' }
  });
  assert.strictEqual(second.status, 409, second.text);
  assert.strictEqual(second.json.error, 'already_requested');
  assert.ok(ravi.user.id);
});

test('path ids are passed through to the handler', async () => {
  const session = await signIn('+919000000001');
  const res = await call('GET', '/v1/emergency/does-not-exist', { token: session.token });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.json.error, 'not_found');
});

test('device registration is accepted and blocks are one-way', async () => {
  const asha = await signIn('+919000000005');
  const ravi = await signIn('+919000000006');

  const device = await call('POST', '/v1/devices', {
    token: asha.token,
    body: { token: 'fcm-token-abc', platform: 'android' }
  });
  assert.strictEqual(device.status, 204);

  // Unregistering is scoped by ownership in the WHERE clause, so a foreign
  // token is silently untouched and the caller's own token is removed. Both
  // are 204: the endpoint never reveals whether a token exists.
  const foreign = await call('DELETE', '/v1/devices', {
    token: ravi.token,
    body: { token: 'fcm-token-abc' }
  });
  assert.strictEqual(foreign.status, 204);
  const own = await call('DELETE', '/v1/devices', {
    token: asha.token,
    body: { token: 'fcm-token-abc' }
  });
  assert.strictEqual(own.status, 204);
  const everything = await call('DELETE', '/v1/devices', { token: asha.token });
  assert.strictEqual(everything.status, 204);

  const blocked = await call('POST', '/v1/blocks', {
    token: asha.token,
    body: { userId: ravi.user.id }
  });
  assert.strictEqual(blocked.status, 204);

  const attempted = await call('POST', '/v1/family/requests', {
    token: asha.token,
    body: { phone: '+919000000006' }
  });
  assert.strictEqual(attempted.status, 403);
  assert.strictEqual(attempted.json.error, 'forbidden');
});

test('device tokens are authenticated, user-scoped, and removable only by their owner', async () => {
  // Same-process handle on the DB: the assertions below are about rows, not
  // status codes, because the endpoints deliberately answer 204 either way.
  const { db } = require('../db.js');
  const owner = await signIn('+919000000021');
  const other = await signIn('+919000000022');
  const token = 'fcm-token-ownership-check';

  const anonymous = await call('POST', '/v1/devices', { body: { token } });
  assert.strictEqual(anonymous.status, 401);
  assert.strictEqual(anonymous.json.error, 'unauthorized');

  const registered = await call('POST', '/v1/devices', {
    token: owner.token,
    body: { token, platform: 'android' }
  });
  assert.strictEqual(registered.status, 204);

  const row = db.prepare('SELECT user_id FROM devices WHERE token = ?').get(token);
  assert.ok(row, 'the token was stored');
  assert.strictEqual(row.user_id, owner.user.id, 'ownership comes from the session, never the body');

  // A foreign delete is a no-op that still answers 204, so it cannot be used to
  // probe whether somebody else registered a token.
  const foreign = await call('DELETE', '/v1/devices', { token: other.token, body: { token } });
  assert.strictEqual(foreign.status, 204);
  const survived = db.prepare('SELECT user_id FROM devices WHERE token = ?').get(token);
  assert.ok(survived, 'a foreign caller cannot delete another user token');
  assert.strictEqual(survived.user_id, owner.user.id);

  const own = await call('DELETE', '/v1/devices', { token: owner.token, body: { token } });
  assert.strictEqual(own.status, 204);
  assert.strictEqual(db.prepare('SELECT 1 FROM devices WHERE token = ?').get(token), undefined);

  // Re-registering an existing token moves it to the latest owner instead of
  // duplicating it, so a handed-over phone stops receiving the old alerts.
  await call('POST', '/v1/devices', { token: owner.token, body: { token } });
  await call('POST', '/v1/devices', { token: other.token, body: { token } });
  const moved = db.prepare('SELECT user_id FROM devices WHERE token = ?').all(token);
  assert.strictEqual(moved.length, 1, 'the unique constraint keeps one row per token');
  assert.strictEqual(moved[0].user_id, other.user.id);
  await call('DELETE', '/v1/devices', { token: other.token });
});

test('emergency creation reports honest delivery states and honours Idempotency-Key', async () => {
  const asha = await signIn('+919000000007');
  const ravi = await signIn('+919000000008');
  await call('PATCH', '/v1/me', { token: ravi.token, body: { displayName: 'Ravi' } });

  // A real connection, so the family fan-out runs and must admit it had no channel.
  await call('POST', '/v1/family/requests', { token: asha.token, body: { phone: '+919000000008' } });
  const incoming = await call('GET', '/v1/family', { token: ravi.token });
  await call('POST', '/v1/family/requests/' + incoming.json.incoming[0].id + '/accept', {
    token: ravi.token
  });

  // Make the nearby pool deterministic: one opted-in helper publishes a
  // location inside the radius, so the state under test is "candidates exist
  // but no push transport", not the unrelated "nobody is nearby" branch.
  const nearbyHelper = await signIn('+919000000009');
  await call('PATCH', '/v1/me', {
    token: nearbyHelper.token,
    body: { displayName: 'Neha', prefs: { nearbyHelperOptIn: true } }
  });
  await call('POST', '/v1/helper/location', {
    token: nearbyHelper.token,
    body: { lat: 17.3801, lng: 78.4801, accuracyM: 15 }
  });

  const body = { location: { lat: 17.38, lng: 78.48, accuracyM: 12, ageSeconds: 0 } };
  const created = await call('POST', '/v1/emergency', {
    token: asha.token,
    body,
    headers: { 'Idempotency-Key': 'test-emergency-key-1' }
  });
  assert.strictEqual(created.status, 201, created.text);
  const emergency = created.json.emergency;
  assert.ok(emergency.id);
  assert.ok(emergency.expiresAt);
  // No push provider is configured in tests: the server must say so rather than
  // claim nearby helpers were reached (providers.js never fakes delivery).
  assert.strictEqual(emergency.nearby.state, 'not_configured');
  assert.strictEqual(emergency.nearby.candidates, 1);
  assert.strictEqual(emergency.family.length, 1);
  assert.strictEqual(emergency.family[0].name, 'Ravi');
  assert.strictEqual(emergency.family[0].status, 'no_channel');
  assert.strictEqual(emergency.familyNotified, 0);

  // Same key inside 24 h replays the same emergency instead of creating another.
  const replay = await call('POST', '/v1/emergency', {
    token: asha.token,
    body,
    headers: { 'Idempotency-Key': 'test-emergency-key-1' }
  });
  assert.strictEqual(replay.status, 201, replay.text);
  assert.strictEqual(replay.json.emergency.id, emergency.id);

  // A fresh key while an emergency is live is a conflict, never a second alert.
  const conflicting = await call('POST', '/v1/emergency', {
    token: asha.token,
    body,
    headers: { 'Idempotency-Key': 'test-emergency-key-2' }
  });
  assert.strictEqual(conflicting.status, 409, conflicting.text);
  assert.strictEqual(conflicting.json.error, 'state_conflict');
  assert.strictEqual(conflicting.json.emergency.id, emergency.id);

  // Family membership does not grant a write path on someone else's emergency.
  const strangerCancel = await call('POST', '/v1/emergency/' + emergency.id + '/cancel', {
    token: ravi.token
  });
  assert.strictEqual(strangerCancel.status, 403, strangerCancel.text);
  assert.strictEqual(strangerCancel.json.error, 'forbidden');

  const cancelled = await call('POST', '/v1/emergency/' + emergency.id + '/cancel', {
    token: asha.token
  });
  assert.strictEqual(cancelled.status, 200, cancelled.text);
  assert.strictEqual(cancelled.json.emergency.state, 'cancelled');

  // Cancel is idempotent so a retried cancel cannot trap the client in a 409.
  const cancelledAgain = await call('POST', '/v1/emergency/' + emergency.id + '/cancel', {
    token: asha.token
  });
  assert.strictEqual(cancelledAgain.status, 200, cancelledAgain.text);
  assert.strictEqual(cancelledAgain.json.emergency.state, 'cancelled');
});

test('emergency creation is rate limited per user, with a retry hint', async () => {
  // A dedicated number: this test deliberately leaves a live emergency behind.
  const user = await signIn('+919000000020');
  const body = { location: { lat: 17.38, lng: 78.48, accuracyM: 9, ageSeconds: 0 } };

  const first = await call('POST', '/v1/emergency', {
    token: user.token,
    body,
    headers: { 'Idempotency-Key': 'rl-1' }
  });
  assert.strictEqual(first.status, 201, first.text);

  // FS_EMERGENCY_RATE_LIMIT is 4 for this suite: attempts 2..4 are charged and
  // answered with the "already active" conflict, attempt 5 must be refused.
  const attempts = [];
  for (let i = 2; i <= 5; i += 1) {
    attempts.push(
      await call('POST', '/v1/emergency', {
        token: user.token,
        body,
        headers: { 'Idempotency-Key': 'rl-' + i }
      })
    );
  }
  assert.deepStrictEqual(
    attempts.slice(0, 3).map((res) => res.status),
    [409, 409, 409],
    attempts.map((res) => res.status + ':' + res.text).join(' | ')
  );
  const limited = attempts[3];
  assert.strictEqual(limited.status, 429, limited.text);
  assert.strictEqual(limited.json.error, 'rate_limited');
  assert.ok(limited.json.retryAfterSeconds > 0, 'retryAfterSeconds must be present');
});

test('helper location publishing is auth- and opt-in-gated', async () => {
  const unauthenticated = await call('POST', '/v1/helper/location', {
    body: { location: { lat: 17.38, lng: 78.48 } }
  });
  assert.strictEqual(unauthenticated.status, 401);

  const ravi = await signIn('+919000000017');
  const refused = await call('POST', '/v1/helper/location', {
    token: ravi.token,
    body: { location: { lat: 17.38, lng: 78.48 } }
  });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(refused.json.error, 'not_opted_in');

  await call('PATCH', '/v1/me', { token: ravi.token, body: { prefs: { nearbyHelperOptIn: true } } });
  const published = await call('POST', '/v1/helper/location', {
    token: ravi.token,
    body: { location: { lat: 17.38, lng: 78.48, accuracyM: 15 } }
  });
  assert.strictEqual(published.status, 200, published.text);
  assert.strictEqual(published.json.published, true);

  const missingLocation = await call('POST', '/v1/helper/location', { token: ravi.token, body: {} });
  assert.strictEqual(missingLocation.status, 400);
  assert.strictEqual(missingLocation.json.error, 'invalid_body');

  // An unknown assignment id is a clean 404, not a crash or a silent 200.
  const unknownAssignment = await call('POST', '/v1/helper/assignments/nope/accept', {
    token: ravi.token
  });
  assert.strictEqual(unknownAssignment.status, 404, unknownAssignment.text);
  assert.strictEqual(unknownAssignment.json.error, 'not_found');

  // With no push transport the emergency must not claim helpers were reached,
  // yet the pending row still exists so an open helper app (foreground polling)
  // can see and act on it. Nothing here simulates a delivered notification.
  const requester = await signIn('+919000000021');
  const created = await call('POST', '/v1/emergency', {
    token: requester.token,
    body: { location: { lat: 17.38, lng: 78.48, accuracyM: 20, ageSeconds: 0 } }
  });
  assert.strictEqual(created.status, 201, created.text);
  const emergency = created.json.emergency;
  assert.strictEqual(emergency.nearby.state, 'not_configured');
  assert.strictEqual(emergency.nearby.notified, 0);

  const assignments = await call('GET', '/v1/helper/assignments', { token: ravi.token });
  assert.strictEqual(assignments.status, 200, assignments.text);
  assert.strictEqual(assignments.json.assignments.length, 1);
  const assignment = assignments.json.assignments[0];
  assert.strictEqual(assignment.status, 'pending');
  assert.strictEqual(assignment.emergencyId, emergency.id);
  // Pre-accept payload carries no requester identity, only distance.
  assert.strictEqual(assignment.requester, undefined);
  assert.ok(assignment.request.distanceM >= 0);

  const accepted = await call('POST', '/v1/helper/assignments/' + assignment.id + '/accept', {
    token: ravi.token
  });
  assert.strictEqual(accepted.status, 200, accepted.text);
  assert.strictEqual(accepted.json.assignment.status, 'accepted');
  assert.strictEqual(
    accepted.json.requester && accepted.json.requester.phone,
    '+919000000021',
    accepted.text
  );
  assert.strictEqual(accepted.json.requester.lat, 17.38);

  // The atomic claim means a second accept can never overwrite the assignment.
  const second = await call('POST', '/v1/helper/assignments/' + assignment.id + '/accept', {
    token: ravi.token
  });
  assert.strictEqual(second.status, 409, second.text);

  const requesterView = await call('GET', '/v1/emergency/' + emergency.id, { token: requester.token });
  assert.strictEqual(requesterView.status, 200, requesterView.text);
  assert.strictEqual(requesterView.json.emergency.state, 'helper_accepted');
  assert.strictEqual(requesterView.json.emergency.helper.phone, '+919000000017');
});

test('reports are accepted with 202', async () => {
  const asha = await signIn('+919000000018');

  // An unknown reason is a client bug, not something to swallow into a 202.
  const bad = await call('POST', '/v1/reports', { token: asha.token, body: { reason: 'nonsense' } });
  assert.strictEqual(bad.status, 400, bad.text);
  assert.strictEqual(bad.json.error, 'invalid_body');

  const res = await call('POST', '/v1/reports', { token: asha.token, body: { reason: 'spam' } });
  assert.strictEqual(res.status, 202, res.text);
});
