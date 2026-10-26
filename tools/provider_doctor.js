#!/usr/bin/env node
'use strict';
/*
 * Provider credential doctor.
 *
 * Proves that the server-side delivery paths actually work with the credentials
 * present in the environment — without sending an SMS and without delivering a
 * notification unless you explicitly ask for one.
 *
 *   node tools/provider_doctor.js                 # offline checks only
 *   node tools/provider_doctor.js --device-token TOKEN
 *                                                 # + FCM validate_only handshake
 *
 * FCM `validate_only: true` makes Google authenticate the request, apply the
 * message to the target project, and reject malformed payloads, while
 * guaranteeing nothing is delivered. That validates project id, service-account
 * signing, the API being enabled, and token plausibility in one call.
 *
 * Never prints secrets: only presence, lengths, and provider status codes.
 */

const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader — avoids adding a dependency just for local diagnostics.
(function loadEnvFile() {
  const file = path.join(__dirname, '..', 'server', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
})();

const config = require('../server/config');
const fcmAuth = require('../server/fcm-auth');

const results = [];
function record(name, state, detail) {
  results.push({ name, state, detail });
  const mark = state === 'ok' ? 'PASS' : state === 'warn' ? 'WARN' : 'FAIL';
  console.log(`[${mark}] ${name}: ${detail}`);
}

async function checkFcm(deviceToken) {
  if (config.pushProvider !== 'fcm') {
    record('fcm/config', 'warn', `FS_PUSH_PROVIDER is "${config.pushProvider}", expected "fcm" (push dispatch disabled)`);
    return;
  }
  if (!fcmAuth.serviceAccountAvailable()) {
    record('fcm/credentials', 'fail', `FS_FCM_SERVICE_ACCOUNT (${config.fcm.serviceAccountPath || 'unset'}) is missing or unreadable`);
    return;
  }

  let account;
  try {
    account = fcmAuth.readServiceAccount();
  } catch (err) {
    record('fcm/credentials', 'fail', err.message);
    return;
  }
  record('fcm/credentials', 'ok', `service account ${account.client_email}`);

  // Signing a JWT and exchanging it proves the private key, clock, and the
  // firebase.messaging scope end-to-end. It sends no message.
  let credentials;
  try {
    fcmAuth.resetCache();
    credentials = await fcmAuth.getAccessToken({ force: true });
  } catch (err) {
    record('fcm/oauth', 'fail', `token exchange rejected: ${err.message}`);
    return;
  }
  if (!credentials.projectId) {
    record('fcm/oauth', 'fail', 'no project id (set FS_FCM_PROJECT_ID or use a service account that contains project_id)');
    return;
  }
  record('fcm/oauth', 'ok', `access token acquired for project ${credentials.projectId}`);

  if (!deviceToken) {
    record('fcm/handshake', 'warn', 'skipped: pass --device-token <token from the app> to validate a device target');
    return;
  }

  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + credentials.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        validate_only: true,
        message: {
          token: deviceToken,
          notification: { title: 'FamilyShield', body: 'Delivery check' },
          data: { type: 'doctor_check' }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();
    if (response.ok) {
      record('fcm/handshake', 'ok', 'validate_only accepted: project, key, API and device token are all valid');
    } else {
      record('fcm/handshake', 'fail', `HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    record('fcm/handshake', 'fail', err.message);
  }
}

async function checkSms() {
  if (config.otpProvider !== 'twilio') {
    record('otp/config', 'warn', `FS_OTP_PROVIDER is "${config.otpProvider}", expected "twilio" (real OTP delivery disabled)`);
    return;
  }
  const { accountSid, authToken, from } = config.twilio;
  const missing = [!accountSid && 'TWILIO_ACCOUNT_SID', !authToken && 'TWILIO_AUTH_TOKEN', !from && 'TWILIO_FROM']
    .filter(Boolean);
  if (missing.length) {
    record('otp/credentials', 'fail', 'missing ' + missing.join(', '));
    return;
  }
  // Reading the account resource validates SID+token against Twilio without
  // sending a message or incurring SMS cost.
  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`, {
      headers: { Authorization: 'Basic ' + Buffer.from(accountSid + ':' + authToken).toString('base64') },
      signal: AbortSignal.timeout(10000)
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      record('otp/credentials', 'ok', `Twilio account ${body.friendly_name || accountSid} (status: ${body.status || 'unknown'})`);
    } else {
      record('otp/credentials', 'fail', `HTTP ${response.status}: ${body.message || 'rejected'}`);
    }
  } catch (err) {
    record('otp/credentials', 'fail', err.message);
  }
  try {
    const sender = String(from);
    if (sender.startsWith('+')) record('otp/sender', 'ok', `E.164 sender ${sender.slice(0, 4)}***${sender.slice(-2)}`);
    else record('otp/sender', 'warn', 'TWILIO_FROM is not E.164 (e.g. +15551234567) or a Messaging Service SID (MG...)');
  } catch (err) {
    record('otp/sender', 'fail', err.message);
  }
}

function checkConfigHygiene() {
  const problems = [];
  if (config.devMode) problems.push('FS_DEV_MODE is enabled — console OTP echo must never reach production');
  if (!config.tokenSecret) problems.push('FS_TOKEN_SECRET absent — sessions cannot be signed');
  record('config/hygiene', problems.length ? 'fail' : 'ok', problems.length ? problems.join('; ') : 'no development shortcuts enabled');
}

(async () => {
  const tokenArg = process.argv.indexOf('--device-token');
  const deviceToken = tokenArg > -1 ? process.argv[tokenArg + 1] : null;

  checkConfigHygiene();
  await checkSms();
  await checkFcm(deviceToken);

  const failed = results.filter((r) => r.state === 'fail').length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
})();
