/* FamilyShield — one-tap emergency (SOS).
 *
 * Contract: docs/CONTRACTS.md §3 (POST /v1/emergency, GET /:id, POST /:id/cancel).
 * Rules this file must keep:
 *   - One tap starts a ~5 s cancel window. Before the window ends nothing is sent.
 *   - After the window the alert is sent even if a location fix failed; the UI then
 *     says "location not shared" and the server records nearby state no_location.
 *   - Delivery states come from the server. This file never upgrades a status.
 *   - No emergency type / questionnaire before sending.
 *   - The user can cancel an active alert; cancellation is confirmed by the server.
 */
(function () {
  'use strict';

  var FS = window.FS || (window.FS = {});
  var Sos = FS.sos || (FS.sos = {});
  var doc = document;

  var CANCEL_SECONDS = 5;
  var STORAGE_KEY = 'fs.emergency.v1';
  var POLL_MS = 15000;
  var LOCATION_TIMEOUT_MS = 4000;

  var STATE = {
    phase: 'idle', // idle | counting | sending | active | cancelled | error
    emergency: null,
    secondsLeft: CANCEL_SECONDS,
    error: '',
    requestId: null,
    timer: null,
    poll: null,
    busy: false
  };

  function t(key, params) {
    if (FS.app && typeof FS.app.t === 'function') return FS.app.t(key, params);
    return key;
  }

  function store() {
    try {
      return window.localStorage;
    } catch (err) {
      return null;
    }
  }

  function savedId() {
    var s = store();
    if (!s) return null;
    try {
      var raw = s.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed.id === 'string' ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function saveEmergency(emergency) {
    var s = store();
    if (!s) return;
    try {
      if (emergency && emergency.id) {
        s.setItem(STORAGE_KEY, JSON.stringify({ id: emergency.id, createdAt: emergency.createdAt }));
      } else {
        s.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      /* storage full or blocked — polling just won't survive a reload */
    }
  }

  function api(path, options) {
    if (!FS.cloud || typeof FS.cloud.api !== 'function') {
      return Promise.reject(new Error('Backend is not configured.'));
    }
    return FS.cloud.api(path, options);
  }

  function signedIn() {
    return !!(FS.cloud && FS.cloud.currentUser && FS.cloud.currentUser());
  }

  function el(id) {
    return doc.getElementById(id);
  }

  function node(tag, className, text) {
    var n = doc.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function clearTimer() {
    if (STATE.timer) {
      clearInterval(STATE.timer);
      STATE.timer = null;
    }
  }

  function stopPolling() {
    if (STATE.poll) {
      clearInterval(STATE.poll);
      STATE.poll = null;
    }
  }

  function startPolling() {
    stopPolling();
    STATE.poll = setInterval(function () {
      if (doc.hidden) return;
      refreshActive();
    }, POLL_MS);
  }

  /* ---------- location ---------- */

  function currentLocation() {
    // Resolves {lat, lng, accuracyM, ageSeconds} or null. Never rejects: a failed
    // fix must not block the alert, it only makes the alert less precise.
    return new Promise(function (resolve) {
      if (!FS.geo || typeof FS.geo.getLocation !== 'function') {
        resolve(null);
        return;
      }
      var settled = false;
      var guard = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, LOCATION_TIMEOUT_MS);
      FS.geo.getLocation({ enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 30000 }).then(
        function (pos) {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          if (!pos || !isFinite(pos.lat) || !isFinite(pos.lon)) {
            resolve(null);
            return;
          }
          resolve({
            lat: Number(pos.lat),
            lng: Number(pos.lon),
            accuracyM: isFinite(pos.accuracy) ? Math.round(pos.accuracy) : null,
            ageSeconds: 0
          });
        },
        function () {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          resolve(null);
        }
      );
    });
  }

  /* ---------- send / cancel ---------- */

  function newRequestId() {
    var bytes = [];
    var cryptoObj = window.crypto || window.msCrypto;
    if (cryptoObj && cryptoObj.getRandomValues) {
      var buf = new Uint8Array(8);
      cryptoObj.getRandomValues(buf);
      for (var i = 0; i < buf.length; i += 1) bytes.push(('0' + buf[i].toString(16)).slice(-2));
      return 'sos-' + Date.now().toString(36) + '-' + bytes.join('');
    }
    return 'sos-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function adoptEmergency(emergency) {
    STATE.emergency = emergency;
    saveEmergency(emergency);
    if (emergency.state === 'cancelled') {
      STATE.phase = 'cancelled';
      stopPolling();
    } else if (emergency.state === 'expired' || emergency.state === 'closed' || emergency.state === 'resolved') {
      STATE.phase = 'cancelled';
      STATE.emergency = emergency;
      stopPolling();
    } else {
      STATE.phase = 'active';
      startPolling();
    }
  }

  function send() {
    if (STATE.busy) return;
    STATE.busy = true;
    clearTimer();
    STATE.phase = 'sending';
    STATE.requestId = newRequestId();
    render();

    currentLocation().then(function (location) {
      return api('/v1/emergency', {
        method: 'POST',
        headers: { 'Idempotency-Key': STATE.requestId },
        body: { location: location, note: null }
      });
    }).then(
      function (data) {
        STATE.busy = false;
        if (!data || !data.emergency) {
          STATE.phase = 'error';
          STATE.error = t('sos.errorGeneric');
          render();
          return;
        }
        adoptEmergency(data.emergency);
        render();
      },
      function (err) {
        STATE.busy = false;
        if (err && err.status === 409 && err.data && err.data.emergency) {
          adoptEmergency(err.data.emergency);
          render();
          return;
        }
        STATE.phase = 'error';
        STATE.error = honestError(err);
        render();
      }
    );
  }

  function honestError(err) {
    var code = err && err.code;
    if (code === 'not_opted_in') return t('sos.needsConsent');
    if (code === 'rate_limited') return t('sos.rateLimited');
    if (code === 'unauthorized') return t('sos.needsSignIn');
    if (err && err.message && /fetch|network|Failed/i.test(err.message)) return t('sos.offline');
    return (err && err.message) || t('sos.errorGeneric');
  }

  function cancelActive() {
    var emergency = STATE.emergency;
    if (!emergency || STATE.busy) return;
    STATE.busy = true;
    api('/v1/emergency/' + encodeURIComponent(emergency.id) + '/cancel', { method: 'POST', body: {} }).then(
      function (data) {
        STATE.busy = false;
        if (data && data.emergency) adoptEmergency(data.emergency);
        else STATE.phase = 'cancelled';
        render();
      },
      function (err) {
        STATE.busy = false;
        STATE.error = honestError(err);
        // Stay in 'active': the alert is still live unless the server says otherwise.
        STATE.phase = 'active';
        render();
      }
    );
  }

  function startCountdown() {
    if (!signedIn()) {
      STATE.phase = 'error';
      STATE.error = t('sos.needsSignIn');
      render();
      return;
    }
    STATE.phase = 'counting';
    STATE.secondsLeft = CANCEL_SECONDS;
    STATE.error = '';
    STATE.emergency = null;
    render();
    clearTimer();
    STATE.timer = setInterval(function () {
      STATE.secondsLeft -= 1;
      if (STATE.secondsLeft <= 0) {
        clearTimer();
        send();
        return;
      }
      render();
    }, 1000);
  }

  function abortCountdown() {
    clearTimer();
    STATE.phase = 'idle';
    STATE.secondsLeft = CANCEL_SECONDS;
    render();
  }

  function refreshActive() {
    if (!signedIn()) return;
    var saved = savedId();
    if (!saved) return;
    api('/v1/emergency/' + encodeURIComponent(saved.id)).then(
      function (data) {
        if (data && data.emergency) {
          adoptEmergency(data.emergency);
          render();
        }
      },
      function (err) {
        if (err && (err.status === 404 || err.status === 403)) {
          saveEmergency(null);
          if (STATE.phase === 'active') {
            STATE.phase = 'idle';
            STATE.emergency = null;
            render();
          }
        }
      }
    );
  }

  /* ---------- rendering ---------- */

  function nearbyText(nearby) {
    if (!nearby) return t('sos.nearbyDisabled');
    switch (nearby.state) {
      case 'notified':
        return t('sos.nearbyNotified', { n: nearby.notified });
      case 'no_helpers':
        return t('sos.nearbyNone');
      case 'not_configured':
        return t('sos.nearbyUnavailable');
      case 'no_location':
        return t('sos.nearbyNoLocation');
      case 'disabled':
        return t('sos.nearbyDisabled');
      default:
        return t('sos.nearbyUnknown');
    }
  }

  function emergencyStateText(state) {
    switch (state) {
      case 'sent':
        return t('sos.stateSent');
      case 'notified':
        return t('sos.stateNotified');
      case 'helper_accepted':
        return t('sos.stateHelperAccepted');
      case 'cancelled':
        return t('sos.stateCancelled');
      case 'expired':
        return t('sos.stateExpired');
      default:
        return t('sos.stateSent');
    }
  }

  function openAccount() {
    if (FS.app && typeof FS.app.go === 'function') FS.app.go('account');
  }

  function render() {
    var root = el('sos-root');
    if (!root) return;
    root.textContent = '';

    var card = node('div', 'card card--pad-sm sos');
    var head = node('div', 'row row--between');
    head.appendChild(node('h2', 'h2', t('sos.title')));
    if (STATE.phase === 'active' && STATE.emergency) {
      head.appendChild(node('span', 'pill pill--high', emergencyStateText(STATE.emergency.state)));
    }
    card.appendChild(head);

    if (!signedIn()) {
      // Compact signed-out state: one line + a single sign-in action.
      card.classList.remove('card--pad-sm');
      card.appendChild(node('p', 'muted', t('sos.signInShort')));
      var signIn = node('button', 'btn btn--primary btn--block mt-8', t('sos.openAccount'));
      signIn.type = 'button';
      signIn.addEventListener('click', openAccount);
      card.appendChild(signIn);
      root.appendChild(card);
      return;
    }

    if (STATE.phase === 'idle') {
      card.appendChild(node('p', 'muted mt-8', t('sos.body')));
      var start = node('button', 'btn btn--danger btn--block mt-12', t('sos.send'));
      start.type = 'button';
      start.setAttribute('data-sos-action', 'start');
      start.addEventListener('click', startCountdown);
      card.appendChild(start);
      card.appendChild(node('p', 'muted mt-8', t('sos.cancelHint', { n: CANCEL_SECONDS })));
      root.appendChild(card);
      return;
    }

    if (STATE.phase === 'counting') {
      card.appendChild(node('p', 'sos__count', t('sos.counting', { n: STATE.secondsLeft })));
      card.appendChild(node('p', 'muted', t('sos.countingHint')));
      var sendNow = node('button', 'btn btn--danger btn--block mt-12', t('sos.sendNow'));
      sendNow.type = 'button';
      sendNow.addEventListener('click', function () {
        clearTimer();
        send();
      });
      card.appendChild(sendNow);
      var stop = node('button', 'btn btn--ghost btn--block mt-8', t('sos.cancelCountdown'));
      stop.type = 'button';
      stop.setAttribute('data-sos-action', 'abort');
      stop.addEventListener('click', abortCountdown);
      card.appendChild(stop);
      root.appendChild(card);
      return;
    }

    if (STATE.phase === 'sending') {
      card.appendChild(node('p', 'muted mt-8', t('sos.sending')));
      var pending = node('button', 'btn btn--primary btn--block mt-12 is-loading', t('sos.sending'));
      pending.type = 'button';
      pending.disabled = true;
      card.appendChild(pending);
      root.appendChild(card);
      return;
    }

    if (STATE.phase === 'error') {
      card.appendChild(node('p', 'muted mt-8', STATE.error || t('sos.errorGeneric')));
      if (/consent|needsConsent/i.test(STATE.error || '')) {
        var consent = node('button', 'btn btn--primary btn--block mt-12', t('sos.openAccount'));
        consent.type = 'button';
        consent.addEventListener('click', openAccount);
        card.appendChild(consent);
      }
      var retry = node('button', 'btn btn--ghost btn--block mt-8', t('sos.back'));
      retry.type = 'button';
      retry.addEventListener('click', function () {
        STATE.error = '';
        STATE.phase = 'idle';
        render();
      });
      card.appendChild(retry);
      root.appendChild(card);
      return;
    }

    if (STATE.phase === 'cancelled') {
      card.appendChild(node('p', 'muted mt-8', t('sos.cancelledBody')));
      var again = node('button', 'btn btn--danger btn--block mt-12', t('sos.sendAgain'));
      again.type = 'button';
      again.addEventListener('click', function () {
        STATE.emergency = null;
        saveEmergency(null);
        startCountdown();
      });
      card.appendChild(again);
      root.appendChild(card);
      return;
    }

    // active
    var emergency = STATE.emergency || {};
    card.appendChild(node('p', 'muted mt-8', t('sos.activeBody')));

    var stats = node('div', 'sos__stats mt-12');
    stats.appendChild(node('div', 'sos__stat', t('sos.familyNotified', { n: emergency.familyNotified || 0 })));
    var nearby = emergency.nearby || {};
    stats.appendChild(node('div', 'sos__stat', nearbyText(emergency.nearby)));
    // "no_location" already explains the missing fix; avoid printing it twice.
    if (emergency.location) {
      stats.appendChild(node('div', 'sos__stat', t('sos.locationShared')));
    } else if (nearby.state !== 'no_location') {
      stats.appendChild(node('div', 'sos__stat', t('sos.locationMissing')));
    }
    card.appendChild(stats);

    if (STATE.error) card.appendChild(node('p', 'muted mt-8', STATE.error));

    var call = node('a', 'btn btn--primary btn--block mt-12', t('sos.call112'));
    call.href = 'tel:112';
    card.appendChild(call);

    var cancel = node('button', 'btn btn--ghost btn--danger btn--block mt-8', t('sos.cancelAlert'));
    cancel.type = 'button';
    cancel.setAttribute('data-sos-action', 'cancel');
    cancel.disabled = !!STATE.busy;
    cancel.addEventListener('click', cancelActive);
    card.appendChild(cancel);

    root.appendChild(card);
  }

  function onView(view) {
    if (view !== 'scan') return;
    render();
    if (signedIn()) refreshActive();
  }

  /* ---------- strings ---------- */

  if (FS.i18n && typeof FS.i18n.addStrings === 'function') {
    FS.i18n.addStrings({
      en: {
        'sos.title': 'Emergency',
        'sos.body': 'Sends your live location to your family and to nearby helpers who opted in.',
        'sos.send': 'Send SOS',
        'sos.cancelHint': 'You have {n} seconds to cancel.',
        'sos.counting': 'Sending in {n}s',
        'sos.countingHint': 'Your family will be alerted. Cancel if this was a mistake.',
        'sos.sendNow': 'Send now',
        'sos.cancelCountdown': 'Cancel — do not send',
        'sos.sending': 'Sending alert…',
        'sos.activeBody': 'Your alert is live. Keep this screen open if you can.',
        'sos.familyNotified': '{n} family member(s) notified',
        'sos.nearbyNotified': '{n} nearby helper(s) notified',
        'sos.nearbyNone': 'No verified helpers nearby right now',
        'sos.nearbyUnavailable': 'Nearby helpers are not configured on this server',
        'sos.nearbyNoLocation': 'Location not shared — nearby helpers cannot be matched',
        'sos.nearbyDisabled': 'Nearby helpers are turned off',
        'sos.nearbyUnknown': 'Nearby helper status unknown',
        'sos.locationShared': 'Live location shared',
        'sos.locationMissing': 'Location not shared — no fix was available',
        'sos.stateSent': 'Sent',
        'sos.stateNotified': 'Family notified',
        'sos.stateHelperAccepted': 'Helper on the way',
        'sos.stateCancelled': 'Cancelled',
        'sos.stateExpired': 'Expired',
        'sos.call112': 'Call emergency services (112)',
        'sos.cancelAlert': 'Cancel alert',
        'sos.cancelledBody': 'This alert was cancelled. Nothing is being shared.',
        'sos.sendAgain': 'Send a new alert',
        'sos.needsSignIn': 'Sign in to send an alert to your family.',
        'sos.needsConsent': 'Family alerts are off. Turn them on in Family account, then try again.',
        'sos.rateLimited': 'Too many alerts in a short time. Try again later.',
        'sos.offline': 'Could not reach the server. Check your connection — nothing was sent.',
        'sos.errorGeneric': 'The alert could not be sent. Nothing was delivered.',
        'sos.signInBody': 'Sign in to alert your family and reach nearby helpers.',
        'sos.signInShort': 'Sign in to enable SOS',
        'sos.openAccount': 'Open Family account',
        'sos.back': 'Back'
      },
      hi: {
        'sos.title': 'आपातकाल',
        'sos.body': 'आपकी लोकेशन परिवार और आस-पास के सहायकों को भेजी जाएगी।',
        'sos.send': 'SOS भेजें',
        'sos.cancelHint': 'रद्द करने के लिए {n} सेकंड हैं।',
        'sos.counting': '{n} सेकंड में भेजा जाएगा',
        'sos.countingHint': 'आपके परिवार को सूचना जाएगी। गलती से दबा हो तो रद्द करें।',
        'sos.sendNow': 'अभी भेजें',
        'sos.cancelCountdown': 'रद्द करें — न भेजें',
        'sos.sending': 'अलर्ट भेजा जा रहा है…',
        'sos.activeBody': 'आपका अलर्ट सक्रिय है। संभव हो तो यह स्क्रीन खुली रखें।',
        'sos.familyNotified': '{n} परिवार के सदस्यों को सूचना दी गई',
        'sos.nearbyNotified': '{n} आस-पास के सहायकों को सूचना दी गई',
        'sos.nearbyNone': 'अभी आस-पास कोई सत्यापित सहायक नहीं है',
        'sos.nearbyUnavailable': 'इस सर्वर पर आस-पास सहायक सुविधा सेट नहीं है',
        'sos.nearbyNoLocation': 'लोकेशन साझा नहीं हुई — सहायक नहीं खोजे जा सके',
        'sos.nearbyDisabled': 'आस-पास के सहायक बंद हैं',
        'sos.nearbyUnknown': 'आस-पास सहायक की स्थिति अज्ञात',
        'sos.locationShared': 'लोकेशन साझा की गई',
        'sos.locationMissing': 'लोकेशन साझा नहीं हुई — लोकेशन उपलब्ध नहीं थी',
        'sos.stateSent': 'भेजा गया',
        'sos.stateNotified': 'परिवार को सूचना दी गई',
        'sos.stateHelperAccepted': 'सहायक रास्ते में है',
        'sos.stateCancelled': 'रद्द किया गया',
        'sos.stateExpired': 'समाप्त',
        'sos.call112': 'आपातकालीन सेवा को कॉल करें (112)',
        'sos.cancelAlert': 'अलर्ट रद्द करें',
        'sos.cancelledBody': 'यह अलर्ट रद्द कर दिया गया है। कुछ भी साझा नहीं हो रहा है।',
        'sos.sendAgain': 'नया अलर्ट भेजें',
        'sos.needsSignIn': 'परिवार को अलर्ट भेजने के लिए साइन इन करें।',
        'sos.needsConsent': 'परिवार अलर्ट बंद हैं। फैमिली अकाउंट में चालू करें, फिर दोबारा कोशिश करें।',
        'sos.rateLimited': 'थोड़े समय में बहुत अधिक अलर्ट। बाद में कोशिश करें।',
        'sos.offline': 'सर्वर से संपर्क नहीं हुआ। कनेक्शन जांचें — कुछ नहीं भेजा गया।',
        'sos.errorGeneric': 'अलर्ट नहीं भेजा जा सका। कुछ भी डिलीवर नहीं हुआ।',
        'sos.signInBody': 'परिवार को अलर्ट और सहायकों तक पहुंचने के लिए साइन इन करें।',
        'sos.signInShort': 'SOS चालू करने के लिए साइन इन करें',
        'sos.openAccount': 'फैमिली अकाउंट खोलें',
        'sos.back': 'वापस'
      },
      te: {
        'sos.title': 'అత్యవసరం',
        'sos.body': 'మీ లొకేషన్ మీ కుటుంబానికి మరియు దగ్గరి సహాయకులకు పంపబడుతుంది.',
        'sos.send': 'SOS పంపండి',
        'sos.cancelHint': 'రద్దు చేయడానికి {n} సెకన్లు ఉన్నాయి.',
        'sos.counting': '{n} సెకన్లలో పంపబడుతుంది',
        'sos.countingHint': 'మీ కుటుంబానికి తెలియజేయబడుతుంది. పొరపాటున నొక్కితే రద్దు చేయండి.',
        'sos.sendNow': 'ఇప్పుడే పంపండి',
        'sos.cancelCountdown': 'రద్దు చేయి — పంపవద్దు',
        'sos.sending': 'అలర్ట్ పంపుతోంది…',
        'sos.activeBody': 'మీ అలర్ట్ యాక్టివ్‌గా ఉంది. వీలైతే ఈ స్క్రీన్ తెరిచి ఉంచండి.',
        'sos.familyNotified': '{n} కుటుంబ సభ్యులకు తెలియజేయబడింది',
        'sos.nearbyNotified': '{n} దగ్గరి సహాయకులకు తెలియజేయబడింది',
        'sos.nearbyNone': 'ప్రస్తుతం దగ్గరలో ధృవీకరించిన సహాయకులు లేరు',
        'sos.nearbyUnavailable': 'ఈ సర్వర్‌లో దగ్గరి సహాయకుల సౌకర్యం సెట్ చేయలేదు',
        'sos.nearbyNoLocation': 'లొకేషన్ పంచుకోలేదు — సహాయకులను కనుగొనలేము',
        'sos.nearbyDisabled': 'దగ్గరి సహాయకులు ఆఫ్‌లో ఉన్నారు',
        'sos.nearbyUnknown': 'దగ్గరి సహాయకుల స్థితి తెలియదు',
        'sos.locationShared': 'లొకేషన్ పంచుకోబడింది',
        'sos.locationMissing': 'లొకేషన్ పంచుకోలేదు — లొకేషన్ అందలేదు',
        'sos.stateSent': 'పంపబడింది',
        'sos.stateNotified': 'కుటుంబానికి తెలియజేయబడింది',
        'sos.stateHelperAccepted': 'సహాయకుడు దారిలో ఉన్నారు',
        'sos.stateCancelled': 'రద్దు చేయబడింది',
        'sos.stateExpired': 'గడువు ముగిసింది',
        'sos.call112': 'అత్యవసర సేవలకు కాల్ చేయండి (112)',
        'sos.cancelAlert': 'అలర్ట్ రద్దు చేయి',
        'sos.cancelledBody': 'ఈ అలర్ట్ రద్దు చేయబడింది. ఏదీ పంచుకోబడటం లేదు.',
        'sos.sendAgain': 'కొత్త అలర్ట్ పంపండి',
        'sos.needsSignIn': 'కుటుంబానికి అలర్ట్ పంపడానికి సైన్ ఇన్ చేయండి.',
        'sos.needsConsent': 'కుటుంబ అలర్ట్‌లు ఆఫ్‌లో ఉన్నాయి. ఫ్యామిలీ అకౌంట్‌లో ఆన్ చేసి మళ్లీ ప్రయత్నించండి.',
        'sos.rateLimited': 'కొద్ది సమయంలో చాలా అలర్ట్‌లు. తర్వాత ప్రయత్నించండి.',
        'sos.offline': 'సర్వర్‌ను చేరుకోలేకపోయాం. కనెక్షన్ చూడండి — ఏదీ పంపలేదు.',
        'sos.errorGeneric': 'అలర్ట్ పంపలేకపోయాం. ఏదీ డెలివరీ కాలేదు.',
        'sos.signInBody': 'కుటుంబానికి అలర్ట్ మరియు దగ్గరి సహాయకుల కోసం సైన్ ఇన్ చేయండి.',
        'sos.signInShort': 'SOS ప్రారంభించడానికి సైన్ ఇన్ చేయండి',
        'sos.openAccount': 'ఫ్యామిలీ అకౌంట్ తెరవండి',
        'sos.back': 'వెనుకకు'
      }
    });
  }

  /* ---------- lifecycle ---------- */

  function init() {
    render();
    if (signedIn()) refreshActive();
    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden && signedIn()) refreshActive();
    });
    window.addEventListener('online', function () {
      if (signedIn()) refreshActive();
    });
  }

  Sos.onView = onView;
  Sos.refresh = refreshActive;
  Sos.state = STATE;

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
