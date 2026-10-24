'use strict';
/*
 * FamilyShield backend configuration.
 * Everything deploy-specific comes from the environment; nothing secret is hardcoded.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = process.env.FS_DATA_DIR
  ? path.resolve(process.env.FS_DATA_DIR)
  : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return Math.floor(value);
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function tokenSecret() {
  if (process.env.FS_TOKEN_SECRET) return process.env.FS_TOKEN_SECRET;
  const file = path.join(DATA_DIR, '.token-secret');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, generated, { mode: 0o600 });
    console.warn(
      '[familyshield] FS_TOKEN_SECRET is not set — generated a local development secret at ' +
        file +
        '. Set FS_TOKEN_SECRET in production and keep it out of source control.'
    );
    return generated;
  } catch (err) {
    console.warn('[familyshield] could not persist a dev secret, using an in-memory one:', err.message);
    return crypto.randomBytes(32).toString('hex');
  }
}

const otpProvider = (process.env.FS_OTP_PROVIDER || 'none').toLowerCase();
const pushProvider = (process.env.FS_PUSH_PROVIDER || 'none').toLowerCase();

// Dev mode echoes OTPs to the server console, so it must be impossible to reach
// in a production process even when FS_DEV_MODE survives into the deployed env.
const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
const isProduction = nodeEnv === 'production';
const devModeRequested = boolEnv('FS_DEV_MODE', false);
if (devModeRequested && isProduction) {
  console.warn('[familyshield] FS_DEV_MODE is set but NODE_ENV=production — console OTP echo stays disabled');
}
const devMode = devModeRequested && !isProduction;

module.exports = {
  port: intEnv('FS_PORT', 8787, 1, 65535),
  host: process.env.FS_HOST || '0.0.0.0',
  dataDir: DATA_DIR,
  dbPath: process.env.FS_DB_PATH ? path.resolve(process.env.FS_DB_PATH) : path.join(DATA_DIR, 'familyshield.db'),
  tokenSecret: tokenSecret(),

  devMode,

  otpTtlSeconds: intEnv('FS_OTP_TTL_SECONDS', 300, 60, 900),
  otpMaxAttempts: intEnv('FS_OTP_MAX_ATTEMPTS', 5, 3, 10),
  otpRequestLimitPerPhone: intEnv('FS_OTP_PHONE_LIMIT', 3, 1, 20),
  otpRequestLimitPerIp: intEnv('FS_OTP_IP_LIMIT', 10, 1, 100),
  otpRequestWindowSeconds: intEnv('FS_OTP_WINDOW_SECONDS', 600, 60, 86400),

  sessionTtlDays: intEnv('FS_SESSION_TTL_DAYS', 30, 1, 365),

  // Central home of the nearby-helper search radius. Never duplicate this value.
  nearbyRadiusM: intEnv('FS_NEARBY_RADIUS_M', 2000, 100, 20000),
  nearbyMaxHelpers: intEnv('FS_NEARBY_MAX_HELPERS', 5, 1, 50),
  // How long a helper presence row stays eligible for matching. Kept well above
  // the client's 2-minute republish interval so one dropped request is harmless.
  helperLocationFreshMs: intEnv('FS_HELPER_LOCATION_FRESH_MS', 1800000, 60000, 86400000),
  emergencyTtlSeconds: intEnv('FS_EMERGENCY_TTL_SECONDS', 1800, 60, 86400),
  emergencyRateLimit: intEnv('FS_EMERGENCY_RATE_LIMIT', 3, 1, 20),
  emergencyRateWindowSeconds: intEnv('FS_EMERGENCY_RATE_WINDOW', 1800, 60, 86400),
  familyInviteRateLimit: intEnv('FS_FAMILY_INVITE_RATE_LIMIT', 20, 1, 200),
  reportRateLimit: intEnv('FS_REPORT_RATE_LIMIT', 10, 1, 100),

  // URL scanner (server/urlscan.js). Scanning is authenticated and rate-
  // limited; set FS_URL_SCAN_ENABLED=0 to disable the route entirely.
  urlScanEnabled: boolEnv('FS_URL_SCAN_ENABLED', true),
  urlScanLimitPerUser: intEnv('FS_URL_SCAN_LIMIT_PER_USER', 12, 1, 100),
  urlScanWindowSeconds: intEnv('FS_URL_SCAN_WINDOW_SECONDS', 600, 60, 86400),

  otpProvider,
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || ''
  },
  pushProvider,
  fcm: {
    // Convenience: if the operator drops the service-account key at the
    // conventional path, no environment variable is needed. The file is
    // gitignored service-account*.json; FS_FCM_SERVICE_ACCOUNT still wins.
    serviceAccountPath: process.env.FS_FCM_SERVICE_ACCOUNT
      || (fs.existsSync(path.join(__dirname, 'service-account.json'))
        ? path.join(__dirname, 'service-account.json')
        : ''),
    // Optional override; normally read from the service-account file.
    projectId: process.env.FS_FCM_PROJECT_ID || ''
  },
  webhookUrl: process.env.FS_WEBHOOK_URL || '',
  webhookSecret: process.env.FS_WEBHOOK_SECRET || ''
};
