# FamilyShield — FCM Work Handoff

**Trigger phrase to resume:** `Resume FamilyShield FCM — read docs/FCM_HANDOFF.md`

Last worked: **2026-10-20**. Previous pass was 2026-10-19.

## Honest status

The commit `c424a1f` titled "native FCM integration" was inaccurate: the APK contained no
`firebase-messaging` classes. As of 2026-10-20 that is fixed in the build itself — the packaged
APK contains the Firebase Messaging SDK, the app's receiver service, and the FCM permissions.

Update 2026-10-20 (later pass): the **client** side is now configured. `app/google-services.json`
exists (package `com.familyshield.app`, gitignored, validated by the build) and
`dist/FamilyShield-1.7.apk` carries `google_app_id` / `gcm_defaultSenderId` resources, so
`FirebaseApp` can auto-initialise without an explicit `FirebaseOptions`.

What is **still not true**: the server has no service-account key, so `FS_PUSH_PROVIDER` resolves
to `none` and no push is dispatched; and no handset has ever received a Firebase notification from
this app. Push is *configured on the client, unconfigured on the server, and never exercised
end-to-end*. Do not describe background notifications as working until the physical-device
checklist at the bottom has actually been run.

## What exists now

Pipeline: `tools/fetch_firebase_deps.py` → `.deps/firebase/` (AARs resolved from Maven Central via
`.deps/firebase/closure.json`, plus their bundled `AndroidManifest.xml` and `res/`) →
`tools/build_apk.py` (aapt2 resource compile, manifest merge across 41 AAR manifests, javac
against `android.jar` + 64 jars, d8, zipalign, apksigner).

- `app/java/com/familyshield/app/FsMessagingService.java` — `FirebaseMessagingService` subclass,
  `onNewToken` + `onMessageReceived`; validates `type`/id pairs before anything leaves the service.
- `app/java/com/familyshield/app/FsPush.java` — token cache (`fs_push` prefs, token + owning user),
  channel creation, neutral lock-screen text, validated `EXTRA_TARGET`, `canNotify()` for API 33+.
- `app/java/com/familyshield/app/MainActivity.java` — `getFcmToken()` / `clearFcmTokenUser()`
  bridge methods, `POST_NOTIFICATIONS` request, `onNewIntent` hand-off into the existing
  `openTarget()` router (the routing fix is untouched).
- `app/AndroidManifest.xml` — `<service FsMessagingService>` with the `MESSAGING_EVENT` filter
  (`exported=false`) and the SDK's default channel/icon metadata.
- Server side (pre-existing, unchanged apart from tests): RS256 service-account JWT → OAuth token
  cache → FCM HTTP v1 `messages:send`, single retry on 429/5xx, one `notifications` ledger row per
  device, `provider_not_configured` when no credentials. Never claims `read`.
- `server/test/fcm.test.js` — new: token registration validation, ownership on unregister,
  payload shape, dead-token pruning, 403 reporting, unconfigured-provider behaviour.

## Verified on 2026-10-20 (evidence, not intent)

- `python tools/build_apk.py` → OK, `dist/FamilyShield-1.6.apk`, 3,803,264 bytes, v2+v3 signed.
  Package `com.familyshield.app`, versionCode 7, versionName 1.6, minSdk 24, targetSdk 34.
  Resolved Firebase stack at build time: firebase-messaging **26.0.0**, firebase-common 23.0.0,
  play-services-base/basement 18.9.0. `dist/FamilyShield-1.5.apk` is kept as the previous
  known-good artifact.
- `aapt2 dump badging` on 1.6: permissions are INTERNET, COARSE+FINE_LOCATION,
  POST_NOTIFICATIONS, ACCESS_NETWORK_STATE, WAKE_LOCK, c2dm RECEIVE and the app's own
  DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION — no SMS, camera, or storage permissions.
- Build log: manifest merged 41 AAR manifests, added `com.google.android.c2dm.permission.RECEIVE`,
  `ACCESS_NETWORK_STATE`, `WAKE_LOCK`; `dex verified 2 firebase-messaging class(es) in classes.dex`.
- `aapt2 dump xmltree` on the *packaged* APK: `com.familyshield.app.FsMessagingService` with
  `com.google.firebase.MESSAGING_EVENT`, both `default_notification_*` metadata,
  `POST_NOTIFICATIONS`, package `com.familyshield.app`.
- `cd server && npm test` → 29 tests, 29 pass, 0 fail.
- Build prints `firebase UNCONFIGURED: ... cannot initialise without google-services.json`
  (this is the 1.6 artifact; superseded by 1.7 below).

## Verified on 2026-10-20 — APK 1.7 (client config present)

- `python tools/build_apk.py --require-fcm` → OK, `dist/FamilyShield-1.7.apk`, 3,807,360 bytes,
  SHA-256 `0ccc88dd12204ed948314db35e4bf94973caac94e5920f91c067fab0464c3fd0`, 111 entries,
  single `classes.dex` (7,540,880 bytes). Package `com.familyshield.app`, versionCode **8**,
  versionName **1.7**, minSdk 24, targetSdk 34.
- `apksigner verify --verbose`: v1 false, **v2 true, v3 true**, v3.1/v4 false. Signer
  `CN=Android Debug, O=Android, C=US` — still the debug keystore, not release-signed.
- Build log now prints `firebase configured from app/google-services.json (sha256 16a4143edfb5)`
  instead of `firebase UNCONFIGURED`. `--require-fcm` makes the build fail if that regresses.
- `npm test` → 32 tests, 32 pass, 0 fail. `node tools/check-i18n.js` → passed (en/hi/te 455 each).
- `node tools/provider_doctor.js` → 3/3 checks, with the two honest WARNs:
  `FS_OTP_PROVIDER` is `none`, `FS_PUSH_PROVIDER` is `none`.

## Tomorrow's mission (in order)

1. ~~Create the Firebase Android app and drop `google-services.json` into `app/google-services.json`~~
   Done. Remaining on this line: nothing — the build now enforces it via `--require-fcm`.
2. Put the service-account JSON outside the repo, set `FS_PUSH_PROVIDER=fcm`,
   `FS_FCM_SERVICE_ACCOUNT=<path>`, `FS_FCM_PROJECT_ID=<id>` on the server only.
3. On a handset: install the APK, log in, confirm `getFcmToken()` returns a token and
   `POST /v1/devices` returns 204, and confirm the `devices` row carries the right user.
4. Background test: second handset triggers a family emergency; first handset with FamilyShield
   backgrounded must show the alert; tap must land on that emergency, not the home screen.
5. Foreground test: alert appears in-app, no duplicate tray entry.
6. Token refresh: clear app data / reinstall, confirm the new token replaces the old row and the
   old one is pruned rather than left to fail forever.

## Service account — the exact missing piece (server only)

The client half is done. What the server still lacks is one file and three variables.
Nothing about this path belongs in the APK or in Git.

1. Open the Firebase console for the project in `app/google-services.json`
   (`project_id` is `familyshield-ad936`):
   **Project settings → Service accounts → Generate new private key → Generate key.**
   A `.json` downloads.
2. Move it **outside** the repository, e.g.
   `%LOCALAPPDATA%\FamilyShield\service-account.json`. Never place it under `app/`;
   `server/service-account*.json` stays Git-ignored as a second safety net.
3. Start the server with (server-side environment only):

   ```powershell
   $env:FS_PUSH_PROVIDER   = "fcm"
   $env:FS_FCM_SERVICE_ACCOUNT = "$env:LOCALAPPDATA\FamilyShield\service-account.json"
   $env:FS_FCM_PROJECT_ID  = "familyshield-ad936"   # optional: read from the file's project_id
   ```

4. Confirm: `node tools/provider_doctor.js` must flip the push check from WARN to OK.
   A wrong path, a truncated download, or a key for a different project all surface
   there before a single message is sent.

Do not paste the private key, the `client_email`, or the JSON contents into chat, logs,
or a commit. The server signs an RS256 JWT with the key in-process; it never logs it.

## OTP — what is and is not possible without paying

The server ships one real SMS channel (`FS_OTP_PROVIDER=twilio` → Twilio Messages API)
and the dev channel. There is no free public-SMS path:

- **Controlled trial (no cost, no fake code):** run the server with `NODE_ENV` unset and
  `FS_DEV_MODE=1`; the console prints `[otp] <phone> code <6 digits>` and the API reports
  `delivery.status: "logged"`. You read the code from the console and type it on the
  handset. This is the only dev-mode path, it is refused in production regardless of the
  flag, and three tests pin that behaviour.
- **Real users:** requires a paid SMS provider — Twilio (per-verification billing; a
  trial account can only message numbers you verify first) or Firebase phone sign-in
  (SMS billed per message past the small free daily allowance, and it would mean adding
  the Firebase Auth SDK to the app — new client work, not a config change).
  Either way the cost is the blocker, not the code: `sendSmsOtp()` is implemented and
  test-covered against a stub, so dropping in credentials is the only step left.

## Do not

- Do not claim the APK receives push until item 3+4 above were run on a real device.
- Do not embed service-account credentials in the APK or commit secrets.
- Do not treat an FCM API 200 as proof the user received or read the alert.
- Do not gate the emergency screens on Firebase being configured — `FsPush` degrades to an empty
  token by design.
