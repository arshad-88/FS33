'use strict';
/*
 * Firebase Cloud Messaging authentication.
 *
 * Kept separate from providers.js so it can be exercised by tools/provider_doctor.js
 * without opening the database. The only credential is the service-account JSON
 * referenced by FS_FCM_SERVICE_ACCOUNT; no secret ever leaves the server.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const config = require('./config');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function serviceAccountPath() {
  return config.fcm.serviceAccountPath || '';
}

function serviceAccountAvailable() {
  const path = serviceAccountPath();
  return !!path && fs.existsSync(path);
}

/**
 * Reads and structurally validates the service-account file.
 * Throws with an actionable message; the private key is never logged.
 */
function readServiceAccount() {
  const path = serviceAccountPath();
  if (!path) throw new Error('FS_FCM_SERVICE_ACCOUNT is not set');
  if (!fs.existsSync(path)) throw new Error('service-account file not found: ' + path);
  const account = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!account.client_email || !account.private_key) {
    throw new Error('service-account file is missing client_email or private_key');
  }
  return account;
}

/** project_id lives in the service-account file; FS_FCM_PROJECT_ID can override it. */
function projectIdFor(account) {
  return String(config.fcm.projectId || (account && account.project_id) || '');
}

/**
 * Cached OAuth2 access token plus the project id it belongs to. `projectId` is
 * cached with the token because both come from the same service-account read;
 * messages:send needs it in the URL path.
 */
let cached = { accessToken: null, expiresAt: 0, projectId: '' };

async function getAccessToken({ force = false } = {}) {
  if (!force && cached.accessToken && Date.now() < cached.expiresAt - 60000) {
    return cached;
  }
  const account = readServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: account.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(header + '.' + claim)
    .sign(account.private_key);
  const assertion = header + '.' + claim + '.' + base64url(signature);
  const response = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }),
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'FCM token exchange failed');
  }
  cached = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
    projectId: projectIdFor(account)
  };
  return cached;
}

function resetCache() {
  cached = { accessToken: null, expiresAt: 0, projectId: '' };
}

module.exports = {
  base64url,
  serviceAccountPath,
  serviceAccountAvailable,
  readServiceAccount,
  projectIdFor,
  getAccessToken,
  resetCache
};
