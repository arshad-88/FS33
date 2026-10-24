/* FamilyShield app shell — DOM wiring, storage, rendering. Classic script, no modules. */
(function () {
  'use strict';

  var FS = window.FS || (window.FS = {});
  var App = FS.app || (FS.app = {});
  var doc = document;
  var memory = {};
  // Resolve the native bridge once, before any UI wiring runs. Feature code
  // (share / dial / openUrl / version label) guards on FS.android, so leaving
  // this until late in the file silently disabled those actions.
  if (!FS.android) FS.android = window.FSAndroid || window.AndroidBridge || null;
  var nativeStore = function () { return window.FSAndroid || null; };
  var store = FS.store || {
    get: function (key, fallback) {
      try {
        var native = nativeStore();
        if (native && typeof native.storeGet === 'function') {
          var saved = native.storeGet(key);
          if (saved != null && saved !== '') return saved;
        }
      } catch (err) { /* bridge unavailable */ }
      try {
        var value = window.localStorage.getItem(key);
        return value == null ? (key in memory ? memory[key] : fallback) : value;
      } catch (err2) { return key in memory ? memory[key] : fallback; }
    },
    set: function (key, value) {
      memory[key] = value;
      try {
        var native = nativeStore();
        if (native && typeof native.storeSet === 'function') native.storeSet(key, value);
      } catch (err) { /* bridge unavailable */ }
      try { window.localStorage.setItem(key, value); } catch (err2) { /* private mode */ }
    }
  };

  var STATE = {
    lang: 'en',
    view: 'scan',
    result: null,
    lastInput: '',
    editingFamilyId: null
  };

  var HISTORY_KEY = 'fs.history.v1';
  var HISTORY_LIMIT = 20;
  var FAMILY_KEY = 'fs.family.v1';

  /* ---------- i18n ---------- */

  function t(key, params) {
    var packs = window.FS_I18N_PACKS || (window.FS && window.FS.i18nData) || {};
    var pack = packs[STATE.lang] || {};
    var base = packs.en || {};
    var str = pack[key];
    if (typeof str !== 'string') str = base[key];
    if (typeof str !== 'string') str = key;
    if (params) {
      Object.keys(params).forEach(function (name) {
        str = str.split('{' + name + '}').join(String(params[name]));
      });
    }
    return str;
  }

  function langList() {
    return FS.i18n && Array.isArray(FS.i18n.languages) ? FS.i18n.languages : [
      { code: 'en', native: 'English' },
      { code: 'hi', native: 'हिन्दी' },
      { code: 'hi', native: 'हिन्दी' },
      { code: 'te', native: 'తెలుగు' }

    ];
  }

  function applyStatic() {
    doc.documentElement.lang = STATE.lang;
    var nodes = doc.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      nodes[i].textContent = t(key);
    }
    var ph = doc.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < ph.length; j++) {
      ph[j].setAttribute('placeholder', t(ph[j].getAttribute('data-i18n-placeholder')));
    }
    var aria = doc.querySelectorAll('[data-i18n-aria-label]');
    for (var k = 0; k < aria.length; k++) {
      aria[k].setAttribute('aria-label', t(aria[k].getAttribute('data-i18n-aria-label')));
    }
    doc.title = t('app.name');
  }

  /* ---------- helpers ---------- */

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(id, extra) {
    var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon' + (extra ? ' ' + extra : ''));
    svg.setAttribute('aria-hidden', 'true');
    var use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  function qs(id) { return doc.getElementById(id); }

  function toast(message) {
    var node = qs('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('is-visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { node.classList.remove('is-visible'); }, 2600);
  }

  function readJSON(key, fallback) {
    var raw = store.get(key, null);
    if (!raw) return fallback;
    try {
      var value = JSON.parse(raw);
      return value == null ? fallback : value;
    } catch (err) { return fallback; }
  }

  function writeJSON(key, value) {
    store.set(key, JSON.stringify(value));
  }

  function formatRelative(ts) {
    var diff = Date.now() - ts;
    var min = Math.round(diff / 60000);
    if (min < 1) return t('history.justNow', {});
    if (min < 60) return t('history.minutesAgo', { count: min });
    var hrs = Math.round(min / 60);
    if (hrs < 24) return t('history.hoursAgo', { count: hrs });
    var days = Math.round(hrs / 24);
    return t('history.daysAgo', { count: days });
  }

  /* ---------- navigation ---------- */

  var navAlias = {
    home: 'scan',
    check: 'scan',
    'view-scan': 'scan',
    results: 'result',
    'view-result': 'result',
    tips: 'guide',
    'view-guide': 'guide',
    'view-family': 'family',
    'view-history': 'history',
    'view-settings': 'settings'
  };

  function go(view) {
    view = navAlias[view] || view;
    if (!doc.getElementById('view-' + view)) return;
    STATE.view = view;
    var views = doc.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.toggle('is-active', views[i].getAttribute('data-view') === view);
    }
    var tabs = doc.querySelectorAll('.tabbar__item');
    for (var j = 0; j < tabs.length; j++) {
      var isActive = tabs[j].getAttribute('data-nav') === view;
      tabs[j].classList.toggle('is-active', isActive);
      if (isActive) tabs[j].setAttribute('aria-current', 'page');
      else tabs[j].removeAttribute('aria-current');
    }
    var main = doc.querySelector('.app__main');
    if (main) main.scrollTop = 0;
    window.scrollTo(0, 0);
    if (view === 'family') renderFamily();
    if (FS.cloud && typeof FS.cloud.onView === 'function') FS.cloud.onView(view);
    if (FS.sos && typeof FS.sos.onView === 'function') FS.sos.onView(view);
    if (FS.helper && typeof FS.helper.onView === 'function') FS.helper.onView(view);
    if (view === 'history') renderHistory();
  }

  /* ---------- result rendering ---------- */

  function bandOf(result) {
    var band = result && result.band;
    return band === 'high' || band === 'suspicious' ? band : 'safe';
  }

  function verdictIcon(band) {
    return band === 'safe' ? 'i-check' : 'i-alert';
  }

  function extractEntities(text) {
    var out = [];
    var seen = {};
    function add(kind, value) {
      var key = kind + ':' + value.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ kind: kind, value: value });
    }
    var urlRe = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
    var m;
    while ((m = urlRe.exec(text)) && out.length < 24) {
      var raw = m[1].replace(/[).,;!?]+$/, '');
      add('url', raw);
    }
    var domainRe = /\b([a-z0-9][a-z0-9-]{0,62}\.(?:com|in|net|org|co|io|xyz|top|info|shop|online|link|me|site|live|app|biz|club|icu|vip|cc|ru)(?:\/[^\s<>"']*)?)/gi;
    while ((m = domainRe.exec(text)) && out.length < 24) add('domain', m[1]);
    var upiRe = /\b([a-z0-9._-]{2,64}@[a-z]{2,32})\b/gi;
    while ((m = upiRe.exec(text)) && out.length < 24) add('upi', m[1]);
    var phoneRe = /(?:\+91[\s-]?)?\b([6-9]\d{9})\b/g;
    while ((m = phoneRe.exec(text)) && out.length < 24) add('phone', m[0].trim());
    var amountRe = /(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d{1,2})?)/gi;
    while ((m = amountRe.exec(text)) && out.length < 24) add('amount', m[0].trim());
    var emailRe = /\b([\w.+-]+@[\w-]+\.[a-z]{2,24})\b/gi;
    while ((m = emailRe.exec(text)) && out.length < 24) {
      if (m[1].indexOf('@') > 0 && !/\d{9}/.test(m[1])) add('email', m[1]);
    }
    return out;
  }

  function entityGlyph(kind) {
    if (kind === 'url' || kind === 'domain') return 'i-link';
    if (kind === 'phone') return 'i-phone';
    if (kind === 'upi') return 'i-lock';
    return 'i-info';
  }

  function renderResult() {
    var result = STATE.result;
    var host = qs('result-body');
    if (!result || !host) return;
    host.textContent = '';
    var band = bandOf(result);

    var head = el('div', 'verdict verdict--' + band);
    var badge = el('div', 'verdict__badge');
    badge.appendChild(icon(verdictIcon(band), 'icon--lg'));
    head.appendChild(badge);
    head.appendChild(el('h1', 'verdict__title', t('result.verdict.' + band)));
    head.appendChild(el('p', 'verdict__sub', t('result.verdict.' + band + '.sub')));

    var scoreWrap = el('div', 'score');
    scoreWrap.style.setProperty('--score', String(Math.max(0, Math.min(100, result.score || 0))));
    var ring = el('div', 'score__ring');
    var value = el('div', 'score__value numeric', String(result.score == null ? 0 : result.score));
    ring.appendChild(value);
    scoreWrap.appendChild(ring);
    var scoreMeta = el('div', 'score__meta');
    scoreMeta.appendChild(el('div', 'score__label', t('result.score')));
    scoreMeta.appendChild(el('div', 'score__confidence', t('result.scale')));
    scoreWrap.appendChild(scoreMeta);
    head.appendChild(scoreWrap);

    var summary = el('p', 'verdict__summary', result.summaryKey ? t(result.summaryKey, result.params || {}) : t('summary.' + band));
    head.appendChild(summary);
    host.appendChild(head);

    var indicators = Array.isArray(result.indicators) ? result.indicators : [];
    var listCard = el('section', 'card');
    var listHead = el('div', 'row row--between');
    listHead.appendChild(el('h2', 'h2', t('result.indicators')));
    listHead.appendChild(el('span', 'pill pill--' + band, String(indicators.length)));
    listCard.appendChild(listHead);
    if (!indicators.length) {
      listCard.appendChild(el('p', 'small muted', t('result.nothingFound')));
    } else {
      var list = el('ul', 'indicator-list');
      indicators.forEach(function (item) {
        var li = el('li', 'indicator');
        li.appendChild(el('span', 'indicator__dot indicator__dot--' + (item.severity || 'medium')));
        var body = el('div', 'indicator__body');
        body.appendChild(el('div', 'indicator__title', t('ind.' + item.id + '.title')));
        var detail = t('ind.' + item.id + '.detail', item.params || {});
        body.appendChild(el('div', 'indicator__detail', detail));
        if (item.evidence) body.appendChild(el('code', 'indicator__evidence', item.evidence));
        li.appendChild(body);
        list.appendChild(li);
      });
      listCard.appendChild(list);
    }
    host.appendChild(listCard);

    var entities = extractEntities(STATE.lastInput || '');
    if (entities.length) {
      var entCard = el('section', 'card');
      entCard.appendChild(el('h2', 'h2', t('result.entitiesTitle')));
      var chips = el('div', 'chip-row');
      entities.forEach(function (entity) {
        var chip = el('span', 'chip chip--' + entity.kind);
        chip.appendChild(icon(entityGlyph(entity.kind), 'icon--sm'));
        chip.appendChild(el('span', 'chip__text', entity.value));
        chips.appendChild(chip);
      });
      entCard.appendChild(chips);
      host.appendChild(entCard);
    }

    // Per-URL LinkGuard verdicts. 'unknown' (could not classify) is shown
    // as a neutral "could not verify" row — never a safe/check mark.
    var links = result.links && Array.isArray(result.links.links) ? result.links.links : [];
    if (links.length) {
      var linkCard = el('section', 'card');
      linkCard.appendChild(el('h2', 'h2', t('links.title')));
      var linkList = el('ul', 'indicator-list');
      links.forEach(function (link) {
        var v = ['dangerous', 'suspicious', 'malformed'].indexOf(link.verdict) !== -1
          ? link.verdict : 'unknown';
        var li = el('li', 'indicator');
        li.appendChild(el('span', 'indicator__dot indicator__dot--' + (v === 'unknown' ? 'low' : v === 'dangerous' ? 'high' : 'medium')));
        var body = el('div', 'indicator__body');
        body.appendChild(el('div', 'indicator__title', t('links.verdict.' + v)));
        body.appendChild(el('code', 'indicator__evidence', String(link.host || link.url || '')));
        if (link.reasons && link.reasons.length) {
          var words = [];
          link.reasons.forEach(function (r) { words.push(typeof r === 'string' ? r : (r && r.label) || ''); });
          var label = words.filter(Boolean).slice(0, 3).join('; ');
          if (label) body.appendChild(el('div', 'indicator__detail', t('links.reason', label)));
        }
        li.appendChild(body);
        linkList.appendChild(li);
      });
      linkCard.appendChild(linkList);
      host.appendChild(linkCard);
    }

    var guidance = Array.isArray(result.guidance) ? result.guidance : [];
    if (guidance.length) {
      var guideCard = el('section', 'card');
      guideCard.appendChild(el('h2', 'h2', t('result.guidance')));
      var steps = el('ol', 'steps');
      guidance.forEach(function (key, index) {
        var step = el('li', 'step');
        step.appendChild(el('span', 'step__num numeric', String(index + 1)));
        step.appendChild(el('div', 'step__body', t(key)));
        steps.appendChild(step);
      });
      guideCard.appendChild(steps);
      host.appendChild(guideCard);
    }

    var actions = el('section', 'stack--sm');
    var copyBtn = el('button', 'btn btn--primary btn--block');
    copyBtn.type = 'button';
    copyBtn.appendChild(icon('i-copy'));
    copyBtn.appendChild(el('span', '', t('result.copy')));
    copyBtn.addEventListener('click', copyReport);
    actions.appendChild(copyBtn);

    var row = el('div', 'grid grid--2');
    var alertBtn = el('button', 'btn btn--ghost');
    alertBtn.type = 'button';
    alertBtn.appendChild(icon('i-users'));
    alertBtn.appendChild(el('span', '', t('result.alertFamily')));
    alertBtn.addEventListener('click', alertFamily);
    row.appendChild(alertBtn);

    var reportBtn = el('button', 'btn btn--ghost');
    reportBtn.type = 'button';
    reportBtn.appendChild(icon('i-external'));
    reportBtn.appendChild(el('span', '', t('result.report')));
    reportBtn.addEventListener('click', openReport);
    row.appendChild(reportBtn);
    actions.appendChild(row);

    var scanAgain = el('button', 'btn btn--ghost btn--block');
    scanAgain.type = 'button';
    scanAgain.appendChild(el('span', '', t('result.scanAgain')));
    scanAgain.addEventListener('click', function () { go('scan'); });
    actions.appendChild(scanAgain);
    host.appendChild(actions);
  }

  function reportText() {
    var result = STATE.result;
    if (!result) return '';
    var band = bandOf(result);
    var lines = [
      t('app.name'),
      t('result.verdict.' + band) + ' (' + (result.score || 0) + '/100)',
      t(result.summaryKey || ('summary.' + band), result.params || {}),
      '',
      t('result.message') + ':',
      STATE.lastInput
    ];
    var guidance = Array.isArray(result.guidance) ? result.guidance : [];
    if (guidance.length) {
      lines.push('');
      lines.push(t('result.whatToDo') + ':');
      guidance.forEach(function (key, i) { lines.push((i + 1) + '. ' + t(key)); });
    }
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = doc.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      doc.body.appendChild(area);
      area.select();
      try { doc.execCommand('copy') ? resolve() : reject(new Error('copy')); }
      catch (err) { reject(err); }
      finally { doc.body.removeChild(area); }
    });
  }

  function copyReport() {
    var text = reportText();
    if (!text) return;
    var done = function () { toast(t('toast.copied')); };
    var fail = function () {
      if (FS.android && typeof FS.android.shareText === 'function') {
        FS.android.shareText(t('app.name'), text);
      } else {
        toast(t('toast.error'));
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        copyText(text).then(done, fail);
      });
    } else {
      copyText(text).then(done, fail);
    }
  }

  function alertFamily() {
    var members = readJSON(FAMILY_KEY, []);
    var body = t('family.alertBody');
    if (members.length) {
      body += '\n\n' + t('family.alertTo') + ': ' + members.map(function (m) { return m.name; }).join(', ');
    }
    if (STATE.result) body += '\n\n' + reportText();
    if (FS.android && typeof FS.android.shareText === 'function') {
      FS.android.shareText(t('family.alertTitle'), body);
    } else {
      copyText(body).then(function () { toast(t('toast.copied')); }, function () { toast(t('toast.error')); });
    }
  }

  function openReport() {
    var url = 'https://cybercrime.gov.in';
    if (FS.android && typeof FS.android.openUrl === 'function') FS.android.openUrl(url);
    else window.open(url, '_blank');
  }

  /* ---------- analyze ---------- */

  function analyze() {
    var input = qs('scan-input');
    var text = input ? input.value : '';
    if (!text || !text.trim()) {
      toast(t('home.empty'));
      if (input) input.focus();
      return;
    }
    var result = FS.engine.analyze(text);
    // LinkGuard runs after the message engine and merges per-URL evidence
    // into the result as a separate, independent field — the original
    // message score is never mutated by link findings.
    if (FS.LinkGuard && typeof FS.LinkGuard.analyzeMessage === 'function') {
      try { result.links = FS.LinkGuard.analyzeMessage(text); } catch (err) { /* keep local verdict */ }
    }
    STATE.result = result;
    STATE.lastInput = text;
    renderResult();
    go('result');
    addHistory(result, text);
  }

  function addHistory(result, text) {
    var items = readJSON(HISTORY_KEY, []);
    items.unshift({
      ts: Date.now(),
      band: bandOf(result),
      score: result.score || 0,
      excerpt: text.replace(/\s+/g, ' ').slice(0, 160)
    });
    writeJSON(HISTORY_KEY, items.slice(0, HISTORY_LIMIT));
  }

  function renderHistory() {
    var host = qs('history-list');
    var summary = qs('history-summary');
    var clear = qs('btn-clear-history');
    if (!host) return;
    host.textContent = '';
    var items = readJSON(HISTORY_KEY, []);
    if (summary) {
      summary.textContent = items.length ? t('history.summary', { count: items.length }) : t('history.empty');
    }
    if (clear) clear.hidden = !items.length;

    if (!items.length) {
      var empty = el('div', 'empty');
      empty.appendChild(icon('i-history', 'icon--xl'));
      empty.appendChild(el('div', 'h3', t('history.empty')));
      empty.appendChild(el('p', 'small muted', t('history.emptyBody')));
      host.appendChild(empty);
      return;
    }

    items.forEach(function (item) {
      var card = el('button', 'list__row card card--flat');
      card.type = 'button';
      card.appendChild(el('span', 'dot dot--' + item.band));
      var body = el('span', 'list__body');
      body.appendChild(el('span', 'list__title', item.excerpt || ''));
      var meta = el('span', 'list__meta');
      meta.appendChild(el('span', '', formatRelative(item.ts)));
      meta.appendChild(el('span', 'dot-sep', '·'));
      meta.appendChild(el('span', 'numeric', String(item.score) + '/100'));
      body.appendChild(meta);
      card.appendChild(body);
      card.appendChild(icon('i-back', 'icon--sm'));
      card.addEventListener('click', function () {
        var input = qs('scan-input');
        if (input) input.value = item.excerpt;
        STATE.lastInput = item.excerpt;
        analyze();
      });
      host.appendChild(card);
    });
  }

  /* ---------- family ---------- */

  function familyInitial(name) {
    var trimmed = String(name || '').trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  function renderFamily() {
    var host = qs('family-list');
    if (!host) return;
    host.textContent = '';
    var members = readJSON(FAMILY_KEY, []);
    if (!members.length) {
      var empty = el('div', 'empty');
      empty.appendChild(icon('i-family', 'icon--xl'));
      empty.appendChild(el('div', 'h3', t('family.empty')));
      empty.appendChild(el('p', 'small muted', t('family.subtitle')));
      host.appendChild(empty);
      return;
    }
    members.forEach(function (member) {
      var card = el('div', 'list__row card');
      card.appendChild(el('span', 'avatar avatar--name', familyInitial(member.name)));
      var body = el('div', 'list__body');
      body.appendChild(el('div', 'list__title', member.name));
      body.appendChild(el('div', 'list__meta', member.phone));
      card.appendChild(body);
      var dial = el('button', 'btn btn--ghost btn--icon');
      dial.type = 'button';
      dial.setAttribute('aria-label', t('family.call') + ' ' + member.name);
      dial.appendChild(icon('i-phone'));
      dial.addEventListener('click', function () { dialFamily(member.phone); });
      card.appendChild(dial);
      var remove = el('button', 'btn btn--ghost btn--icon btn--danger');
      remove.type = 'button';
      remove.setAttribute('aria-label', t('family.remove') + ' ' + member.name);
      remove.appendChild(icon('i-trash'));
      remove.addEventListener('click', function () { removeFamily(member.id); });
      card.appendChild(remove);
      host.appendChild(card);
    });
  }

  function dialFamily(phone) {
    var clean = String(phone || '').replace(/[^\d+]/g, '');
    if (!clean) return;
    if (FS.android && typeof FS.android.dial === 'function') FS.android.dial(clean);
    else window.location.href = 'tel:' + clean;
  }

  function removeFamily(id) {
    var members = readJSON(FAMILY_KEY, []).filter(function (m) { return m.id !== id; });
    writeJSON(FAMILY_KEY, members);
    renderFamily();
    toast(t('family.removed'));
  }

  function openSheet(id) {
    var sheet = qs(id);
    if (!sheet) return;
    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');
    var focusable = sheet.querySelector('input, button');
    if (focusable) setTimeout(function () { focusable.focus(); }, 60);
  }

  function closeSheet(id) {
    var sheet = qs(id);
    if (!sheet) return;
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
  }

  function openFamilySheet() {
    STATE.editingFamilyId = null;
    var name = qs('family-name');
    var phone = qs('family-phone');
    var invalid = qs('family-invalid');
    if (name) name.value = '';
    if (phone) phone.value = '';
    if (invalid) { invalid.hidden = true; invalid.textContent = ''; }
    openSheet('family-sheet');
  }

  function saveFamily() {
    var nameInput = qs('family-name');
    var phoneInput = qs('family-phone');
    var invalid = qs('family-invalid');
    var name = nameInput ? nameInput.value.trim() : '';
    var phone = phoneInput ? phoneInput.value.trim() : '';
    var digits = phone.replace(/\D/g, '');
    var problem = '';
    if (name.length < 1) problem = t('family.nameRequired');
    else if (digits.length < 6 || digits.length > 15) problem = t('family.phoneInvalid');
    if (problem) {
      if (invalid) { invalid.textContent = problem; invalid.hidden = false; }
      return;
    }
    var members = readJSON(FAMILY_KEY, []);
    members.push({ id: 'f' + Date.now(), name: name, phone: phone });
    writeJSON(FAMILY_KEY, members);
    closeSheet('family-sheet');
    renderFamily();
    toast(t('family.saved'));
  }

  /* ---------- static view content ---------- */

  function renderGuide() {
    var host = qs('guide-rules');
    if (!host) return;
    host.textContent = '';
    for (var i = 1; i <= 8; i++) {
      var key = 'guide.r' + i;
      var title = t(key + '.title');
      if (title === key + '.title') continue;
      var card = el('article', 'card rule');
      var head = el('div', 'rule__head');
      head.appendChild(el('span', 'rule__num numeric', String(i)));
      head.appendChild(el('h2', 'rule__title', title));
      card.appendChild(head);
      card.appendChild(el('p', 'rule__body small muted', t(key + '.body')));
      host.appendChild(card);
    }
    var helpline = qs('guide-helpline');
    if (helpline) {
      helpline.textContent = '';
      var rows = [
        { label: 'guide.helplineNumber', value: '1930', kind: 'link', number: '1930' },
        { label: 'guide.cybercrime', value: 'cybercrime.gov.in', kind: 'link', url: 'https://cybercrime.gov.in' }
      ];
      rows.forEach(function (row) {
        var line = el('div', 'row row--between helpline');
        line.appendChild(el('span', 'small muted', t(row.label)));
        var action = el('button', 'link numeric', row.value);
        action.type = 'button';
        action.addEventListener('click', function () {
          if (row.number) dialFamily(row.number);
          else openReport();
        });
        line.appendChild(action);
        helpline.appendChild(line);
      });
    }
  }

  function renderSettings() {
    var select = qs('lang-select');
    if (select) {
      select.textContent = '';
      langList().forEach(function (lang) {
        var opt = doc.createElement('option');
        opt.value = lang.code;
        opt.textContent = lang.native + (lang.english ? ' · ' + lang.english : '');
        select.appendChild(opt);
      });
      select.value = STATE.lang;
    }
    var v = qs('settings-version');
    if (v) {
      // versionName is an @JavascriptInterface method, so it must be invoked; reading it as a
      // property would render the function source into the settings row.
      var version = '1.1';
      try {
        var bridge = FS.android;
        var reported = bridge ? (typeof bridge.versionName === 'function' ? bridge.versionName() : bridge.versionName) : null;
        if (typeof reported === 'string' && /^[\w.+\- ]+$/.test(reported)) version = reported;
      } catch (err) { /* keep the baked-in fallback */ }
      v.textContent = version;
    }
    var e = qs('settings-engine-version');
    if (e) e.textContent = (FS.engine && FS.engine.version) || '1.0.0';
  }

  function setLanguage(code) {
    if (!code) return;
    STATE.lang = code;
    if (FS.i18n && typeof FS.i18n.setLanguage === 'function') {
      try { FS.i18n.setLanguage(code); } catch (err) { /* pack not ready */ }
    }
    store.set('fs.lang', code);
    applyStatic();
    renderGuide();
    renderSettings();
    renderFamily();
    renderHistory();
    if (STATE.result) renderResult();
  }

  /* ---------- wiring ---------- */

  function wire() {
    var tabs = doc.querySelectorAll('.tabbar__item');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () { go(this.getAttribute('data-nav')); });
    }
    qs('btn-analyze').addEventListener('click', analyze);
    qs('btn-paste').addEventListener('click', function () {
      var input = qs('scan-input');
      var insert = function (text) {
        if (!input) return;
        input.value = text || input.value;
        updateCount();
        if (text) toast(t('toast.pasted'));
        input.focus();
      };
      // On the Android shell the WebView Clipboard API is unavailable on the file:// origin, so
      // read the clipboard through the native bridge first. The browser build keeps using the
      // async Clipboard API. A failure only shows a hint and focuses the field, so the user can
      // always long-press and paste manually.
      var failPaste = function () {
        toast(t('toast.pasteFailed'));
        if (input) input.focus();
      };
      if (FS.android && typeof FS.android.readClipboard === 'function') {
        var nativeText = '';
        try { nativeText = FS.android.readClipboard() || ''; } catch (err) { nativeText = ''; }
        if (nativeText) insert(nativeText); else failPaste();
      } else if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(insert, failPaste);
      } else {
        failPaste();
      }
    });
    qs('btn-example').addEventListener('click', function () {
      var input = qs('scan-input');
      if (!input) return;
      input.value = t('home.exampleText');
      STATE.lastInput = input.value;
      updateCount();
      input.focus();
    });
    qs('btn-result-back').addEventListener('click', function () { go('scan'); });
    qs('btn-copy').addEventListener('click', copyReport);
    qs('btn-add-family').addEventListener('click', openFamilySheet);
    qs('btn-save-family').addEventListener('click', saveFamily);
    qs('family-cancel').addEventListener('click', function () { closeSheet('family-sheet'); });
    qs('btn-clear-history').addEventListener('click', function () { openSheet('history-clear-sheet'); });
    qs('history-cancel-clear').addEventListener('click', function () { closeSheet('history-clear-sheet'); });
    qs('history-confirm-clear').addEventListener('click', function () {
      writeJSON(HISTORY_KEY, []);
      closeSheet('history-clear-sheet');
      renderHistory();
      toast(t('history.cleared'));
    });
    qs('btn-call-helpline').addEventListener('click', function () { dialFamily('1930'); });
    qs('btn-open-cybercrime').addEventListener('click', openReport);
    qs('btn-reset').addEventListener('click', function () {
      writeJSON(HISTORY_KEY, []);
      writeJSON(FAMILY_KEY, []);
      STATE.result = null;
      STATE.lastInput = '';
      var input = qs('scan-input');
      if (input) input.value = '';
      updateCount();
      renderHistory();
      renderFamily();
      toast(t('settings.resetDone'));
      go('scan');
    });
    var select = qs('lang-select');
    if (select) select.addEventListener('change', function () { setLanguage(this.value); });

    // Family account panel sits outside the five-tab bar; Settings is its entry point.
    var openAccount = qs('btn-open-account');
    if (openAccount) openAccount.addEventListener('click', function () { go('account'); });
    var accountBack = qs('btn-account-back');
    if (accountBack) accountBack.addEventListener('click', function () { go('settings'); });

    var scrims = doc.querySelectorAll('[data-close-sheet]');
    for (var s = 0; s < scrims.length; s++) {
      scrims[s].addEventListener('click', function () { closeSheet(this.getAttribute('data-close-sheet')); });
    }

    var input = qs('scan-input');
    if (input) {
      input.addEventListener('input', updateCount);
      input.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') analyze();
      });
    }

    doc.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      var open = doc.querySelector('.sheet.is-open');
      if (open) closeSheet(open.id);
    });
  }

  function updateCount() {
    var input = qs('scan-input');
    var count = qs('char-count');
    if (input && count) count.textContent = String(input.value.length);
  }

  function consumeShared() {
    if (!FS.android || typeof FS.android.consumeSharedText !== 'function') return false;
    var text = '';
    try { text = FS.android.consumeSharedText() || ''; } catch (err) { text = ''; }
    if (!text) return false;
    var input = qs('scan-input');
    if (input) input.value = text;
    STATE.lastInput = text;
    updateCount();
    analyze();
    return true;
  }

  function init() {
    if (!FS.android) FS.android = window.FSAndroid || window.AndroidBridge || null;
    var saved = store.get('fs.lang', null);
    var supported = langList().map(function (l) { return l.code; });
    STATE.lang = supported.indexOf(saved) >= 0 ? saved : (FS.i18n && FS.i18n.defaultLanguage) || 'en';
    applyStatic();
    // Offline note is shown only in true web-local mode (no Android shell), so
    // Android users aren't greeted with redundant status cards.
    if (!FS.android) {
      var offlineBadge = doc.getElementById('offline-badge');
      if (offlineBadge) offlineBadge.hidden = false;
      var offlineNote = doc.getElementById('offline-note');
      if (offlineNote) offlineNote.hidden = false;
    }
    renderGuide();
    renderSettings();
    renderFamily();
    renderHistory();
    updateCount();
    wire();
    consumeShared();
    if (FS.cloud && typeof FS.cloud.init === 'function') FS.cloud.init();
  }

  App.init = init;
  App.go = go;
  App.analyze = analyze;
  App.setLanguage = setLanguage;
  App.back = function () {
    var open = doc.querySelector('.sheet.is-open');
    if (open) { closeSheet(open.id); return true; }
    if (STATE.view === 'account') { go('settings'); return true; }
    if (STATE.view !== 'scan') { go('scan'); return true; }
    return false;
  };
  App.state = STATE;
  App.t = t;
  // Share the storage adapter with feature modules so a single code path
  // handles native secure storage and the web fallback.
  if (!FS.store) FS.store = store;
  // Used by screenshot OCR: put recognized text in the scanner and run it.
  App.setScanText = function (text, runNow) {
    var input = qs('scan-input');
    if (!input) return false;
    input.value = String(text == null ? '' : text);
    STATE.lastInput = input.value;
    updateCount();
    if (runNow) analyze();
    return true;
  };

  // Handoff target for js/cloud.js "Use in checker" on a scanned screenshot:
  // load the text into the scanner and run the check there.
  App.analyzeText = function (text) {
    var clean = String(text == null ? '' : text);
    if (!clean.trim()) return false;
    go('scan');
    if (!App.setScanText(clean, false)) return false;
    analyze();
    return true;
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
