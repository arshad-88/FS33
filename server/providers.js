'use strict';
/*
 * Outbound delivery: SMS OTP, push, and the family webhook.
 *
 * Every function reports what actually happened. Nothing here pretends a
 * message was sent: an unconfigured provider returns `provider_not_configured`
 * and the route surfaces that state to the client.
 */

const config = require('./config');
const fcmAuth = require('./fcm-auth');
const { db } = require('./db');
const { nowIso, uuid, log } = require('./util');

function record({ userId, emergencyId, kind, channel, provider, status, detail }) {
  db.prepare(
    `INSERT INTO notifications (id, user_id, emergency_id, kind, channel, provider, status, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(uuid(), userId || null, emergencyId || null, kind, channel, provider, status,
    detail ? String(detail).slice(0, 500) : null, nowIso());
}

/* ------------------------------------------------------------------ SMS OTP */

function otpProviderConfigured() {
  return (
    config.otpProvider === 'twilio' &&
    !!config.twilio.accountSid &&
    !!config.twilio.authToken &&
    !!config.twilio.from
  );
}

async function sendSmsOtp(phone, code) {
  if (!otpProviderConfigured()) {
    return { channel: 'sms', status: 'provider_not_configured', provider: 'none' };
  }
  try {
    const body = new URLSearchParams({
      To: phone,
      From: config.twilio.from,
      Body: 'FamilyShield verification code: ' + code + ' (valid for ' +
        Math.round(config.otpTtlSeconds / 60) + ' min)'
    });
    const auth = Buffer.from(config.twilio.accountSid + ':' + config.twilio.authToken).toString('base64');
    const response = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(config.twilio.accountSid) +
        '/Messages.json',
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body,
        signal: AbortSignal.timeout(8000)
      }
    );
    const payload = await response.json().catch(() => ({}));
    const status = response.ok ? 'sent' : 'failed';
    record({
      kind: 'otp', channel: 'sms', provider: 'twilio', status,
      detail: response.ok ? payload.sid : payload.message || response.status
    });
    return { channel: 'sms', status, provider: 'twilio' };
  } catch (err) {
    log('SMS OTP delivery failed:', err.message);
    record({ kind: 'otp', channel: 'sms', provider: 'twilio', status: 'failed', detail: err.message });
    return { channel: 'sms', status: 'failed', provider: 'twilio' };
  }
}

/* --------------------------------------------------------------------- Push */

function pushConfigured() {
  return config.pushProvider === 'fcm' && fcmAuth.serviceAccountAvailable();
}

// FCM error codes that mean "this token will never work again". The row is
// deleted so a stale token cannot keep absorbing retries forever.
const INVALID_TOKEN_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);

// HTTP statuses worth one immediate retry (quota/per-second limits, provider blips).
const TRANSIENT_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);

// MainActivity owns the only activity; a tap on the tray notification resumes it
// and hands the data payload to the WebView (see the FS.android bridge).
const ANDROID_CLICK_ACTION = 'com.familyshield.app.EMERGENCY_ALERT';

/**
 * Lock-screen visible text. Deliberately free of names, phone numbers, precise
 * coordinates and medical detail: the notification only says a request exists.
 */
function notificationFor(data) {
  switch (String(data && data.type ? data.type : '')) {
    case 'family_emergency':
      return { title: 'FamilyShield', body: 'A family member has requested emergency assistance.' };
    case 'helper_request':
      return { title: 'FamilyShield', body: 'Someone nearby needs emergency assistance.' };
    default:
      return { title: 'FamilyShield', body: 'Open FamilyShield to view the update.' };
  }
}

function stringData(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * One HTTP attempt against messages:send, retried once on a transient failure.
 * Returns { ok, status, body, error } and never throws for provider responses.
 */
async function sendFcmMessage(credentials, message) {
  const url =
    'https://fcm.googleapis.com/v1/projects/' +
    encodeURIComponent(credentials.projectId) +
    '/messages:send';
  const payload = JSON.stringify({ message });

  let last = { ok: false, status: 0, body: '', error: null };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + credentials.accessToken, 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(8000)
      });
      const body = response.ok ? '' : await response.text().catch(() => '');
      last = { ok: response.ok, status: response.status, body: String(body).slice(0, 300), error: null };
      if (response.ok) return last;
      if (!TRANSIENT_HTTP_STATUS.has(response.status)) return last;
    } catch (err) {
      last = { ok: false, status: 0, body: '', error: err.message };
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

function pruneDeviceToken(token) {
  try {
    db.prepare('DELETE FROM devices WHERE token = ?').run(token);
  } catch (err) {
    log('FCM token prune failed:', err.message);
  }
}

/**
 * Sends one push to every registered device of `userId`.
 *
 * A `notification` block is included so an FCM-enabled Android build still shows
 * the alert when the app is backgrounded or killed; the `data` block carries the
 * deeplink keys the app uses to open the right screen after the tap.
 *
 * Returns { status: 'sent'|'failed'|'no_device'|'provider_not_configured',
 *           delivered, dispatched, pruned }.
 * `delivered` counts tokens the provider accepted. That is a hand-off, not proof
 * that a person saw or acted on the notification.
 */
async function pushToUser(userId, data, emergencyId) {
  if (!pushConfigured()) {
    return { status: 'provider_not_configured', delivered: 0, dispatched: 0, pruned: 0 };
  }
  const devices = db.prepare('SELECT token FROM devices WHERE user_id = ?').all(userId);
  if (!devices.length) return { status: 'no_device', delivered: 0, dispatched: 0, pruned: 0 };

  // Resolve the project id from the service-account file before any network
  // call: a credential without a project never produces a valid messages:send
  // URL, so failing here is cheaper and stays correct even when a token is
  // already cached.
  let account;
  try {
    account = fcmAuth.readServiceAccount();
  } catch (err) {
    log('FCM credentials unusable:', err.message);
    record({ userId, emergencyId, kind: 'push', channel: 'push', provider: 'fcm', status: 'failed', detail: err.message });
    return { status: 'failed', delivered: 0, dispatched: 0, pruned: 0 };
  }
  if (!fcmAuth.projectIdFor(account)) {
    const detail = 'no FCM project id: set FS_FCM_PROJECT_ID or use a service-account file with project_id';
    log('FCM dispatch skipped:', detail);
    record({ userId, emergencyId, kind: 'push', channel: 'push', provider: 'fcm', status: 'failed', detail });
    return { status: 'failed', delivered: 0, dispatched: 0, pruned: 0 };
  }

  let credentials;
  try {
    credentials = await fcmAuth.getAccessToken();
  } catch (err) {
    log('FCM auth failed:', err.message);
    record({ userId, emergencyId, kind: 'push', channel: 'push', provider: 'fcm', status: 'failed', detail: err.message });
    return { status: 'failed', delivered: 0, dispatched: 0, pruned: 0 };
  }
  if (!credentials.projectId) {
    // A service account without project_id and no FS_FCM_PROJECT_ID: refuse
    // before any HTTP call so the failure is diagnosable without a provider 404.
    const detail = 'no FCM project id: set FS_FCM_PROJECT_ID or use a service-account file with project_id';
    log('FCM dispatch skipped:', detail);
    record({ userId, emergencyId, kind: 'push', channel: 'push', provider: 'fcm', status: 'failed', detail });
    return { status: 'failed', delivered: 0, dispatched: 0, pruned: 0 };
  }

  const notification = notificationFor(data);
  const payloadData = stringData(data);

  let delivered = 0;
  let pruned = 0;
  for (const device of devices) {
    const result = await sendFcmMessage(credentials, {
      token: device.token,
      notification: { title: notification.title, body: notification.body },
      android: {
        priority: 'high',
        notification: {
          channel_id: 'familyshield_alerts',
          click_action: ANDROID_CLICK_ACTION,
          // Emergency alerts must be visible without unlocking the device.
          default_sound: true
        }
      },
      data: payloadData
    });

    if (result.ok) delivered += 1;

    let invalidToken = false;
    if (!result.ok && result.body) {
      try {
        const parsed = JSON.parse(result.body);
        const code = parsed && parsed.error && parsed.error.details
          ? parsed.error.details.map((d) => d && d.errorCode).find((c) => INVALID_TOKEN_CODES.has(c))
          : null;
        invalidToken = !!code;
      } catch (_) {
        invalidToken = false;
      }
    }
    if (invalidToken) {
      pruneDeviceToken(device.token);
      pruned += 1;
    }

    record({
      userId,
      emergencyId,
      kind: 'push',
      channel: 'push',
      provider: 'fcm',
      status: result.ok ? 'sent' : 'failed',
      detail: result.ok ? null : (result.error || result.body || ('HTTP ' + result.status))
    });
  }

  return { status: delivered ? 'sent' : 'failed', delivered, dispatched: devices.length, pruned };
}

/* ------------------------------------------------------- Family notifications */

function webhookConfigured() {
  return !!config.webhookUrl;
}

/**
 * Family alerts leave through the operator's webhook (SMS gateway, WhatsApp
 * Business, etc.). `status` is honest: `notified` means "accepted by the
 * channel", never "read".
 */
async function notifyFamilyWebhook({ emergencyId, requester, members }) {
  if (!webhookConfigured()) return { status: 'not_configured', delivered: 0 };
  try {
    const body = JSON.stringify({
      type: 'familyshield.emergency',
      emergencyId,
      requester: { name: requester.displayName || '', phone: requester.phone },
      members: members.map((m) => ({ name: m.display_name || '', phone: m.phone })),
      at: nowIso()
    });
    const headers = { 'Content-Type': 'application/json' };
    if (config.webhookSecret) {
      headers['X-FamilyShield-Signature'] = crypto
        .createHmac('sha256', config.webhookSecret)
        .update(body)
        .digest('hex');
    }
    const response = await fetch(config.webhookUrl, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(8000)
    });
    const ok = response.ok;
    record({
      emergencyId, kind: 'family', channel: 'webhook', provider: 'webhook',
      status: ok ? 'sent' : 'failed', detail: ok ? null : 'HTTP ' + response.status
    });
    return { status: ok ? 'notified' : 'failed', delivered: ok ? members.length : 0 };
  } catch (err) {
    record({ emergencyId, kind: 'family', channel: 'webhook', provider: 'webhook', status: 'failed', detail: err.message });
    return { status: 'failed', delivered: 0 };
  }
}

module.exports = {
  otpProviderConfigured,
  sendSmsOtp,
  pushConfigured,
  pushToUser,
  webhookConfigured,
  notifyFamilyWebhook
};
