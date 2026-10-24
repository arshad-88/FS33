/*
 * FamilyShield — LinkGuard: local URL analysis pipeline.
 * Companion to engine.js. Pure, synchronous, deterministic — same contract:
 * no DOM, no network, no storage, no Date inside scoring.
 *
 * Extracts URLs from a message, canonicalizes them, and classifies each one
 * with evidence. Verdicts are per-URL so the caller can show why each link
 * is risky. Remote reputation/lookups are NOT done here — that is the
 * server-side scanner's job, and a failed lookup must produce
 * UNABLE TO VERIFY downstream, never SAFE.
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  root.FS = root.FS || {};

  var VERSION = '1.0.0';
  var MAX_URLS = 12;

  // Official domains per brand. A URL only belongs to a brand if the
  // registrable domain (eTLD+1 under our 2-level suffix rules) matches one of
  // these exactly (subdomains of them count; nothing else does). So
  // hdfcbank.com.evil.in belongs to evil.in and is a lookalike, not official.
  var BRANDS = {
    hdfc: ['hdfcbank.com', 'hdfc.com'],
    sbi: ['onlinesbi.sbi', 'sbi.co.in', 'sbicard.com'],
    icici: ['icicibank.com'],
    axis: ['axisbank.com'],
    kotak: ['kotak.com', 'kotakbank.com'],
    paytm: ['paytm.com'],
    phonepe: ['phonepe.com'],
    gpay: ['pay.google.com'],
    amazon: ['amazon.in', 'amazon.com'],
    flipkart: ['flipkart.com'],
    irctc: ['irctc.co.in', 'irctc.com'],
    indiapost: ['indiapost.gov.in'],
    lic: ['licindia.in'],
    epfo: ['epfindia.gov.in', 'epfo.gov.in'],
    uidai: ['uidai.gov.in'],
    incometax: ['incometax.gov.in', 'incometaxindia.gov.in'],
    rbi: ['rbi.org.in'],
    trai: ['trai.gov.in'],
    delhivery: ['delhivery.com'],
    bluedart: ['bluedart.com'],
    dtdc: ['dtdc.in', 'dtdc.com'],
    myntra: ['myntra.com'],
    swiggy: ['swiggy.com'],
    zomato: ['zomato.com'],
    jio: ['jio.com'],
    airtel: ['airtel.in'],
    bsnl: ['bsnl.co.in'],
    netflix: ['netflix.com'],
    whatsapp: ['whatsapp.com', 'wa.me']
  };

  var SHORTENERS_LIST = [
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'cutt.ly',
    'rb.gy', 'shorturl.at', 'tiny.cc', 'rebrand.ly', 'bit.do', 's.id',
    'lnkd.in', 'shorte.st', 'adf.ly', 'bl.ink', 't.ly', 'clck.ru', 'v.gd',
    'tiny.one', 'urlz.fr', 'rb.link', 'chilp.it', 'shrtco.de', 'gg.gg',
    'gg.lc', 'shorturl.io', 'urlc.fr', 's2r.co'
  ];
  var SHORTENERS = {};
  for (var _i = 0; _i < SHORTENERS_LIST.length; _i++) SHORTENERS[SHORTENERS_LIST[_i]] = 1;

  var SUSPICIOUS_TLDS_LIST = [
    'zip', 'mov', 'top', 'xyz', 'click', 'link', 'live', 'shop', 'online',
    'site', 'icu', 'buzz', 'rest', 'fit', 'cam', 'monster', 'quest', 'cyou',
    'sbs', 'cfd', 'lat', 'ltd', 'vip', 'win', 'loan', 'work', 'men', 'review',
    'country', 'stream', 'download', 'racing', 'accountant', 'date', 'faith',
    'party', 'science', 'gdn', 'bid', 'trade', 'webcam', 'tk', 'ml', 'ga',
    'cf', 'gq', 'gy', 'cr', 'cc', 'pw', 'su', 'ru'
  ];
  var SUSPICIOUS_TLDS = {};
  for (_i = 0; _i < SUSPICIOUS_TLDS_LIST.length; _i++) SUSPICIOUS_TLDS[SUSPICIOUS_TLDS_LIST[_i]] = 1;

  // Public suffixes that take 3 labels for eTLD+1.
  var MULTI_SUFFIX = {
    'co.in': 1, 'firm.in': 1, 'net.in': 1, 'org.in': 1, 'gen.in': 1,
    'ind.in': 1, 'ac.in': 1, 'edu.in': 1, 'res.in': 1, 'gov.in': 1,
    'nic.in': 1, 'com.au': 1, 'co.uk': 1, 'org.uk': 1, 'gov.uk': 1,
    'com.br': 1, 'co.jp': 1, 'co.nz': 1, 'com.mx': 1, 'co.za': 1,
    'com.sg': 1, 'com.tr': 1
  };

  var PATH_WORDS = [
    'login', 'signin', 'verify', 'verification', 'kyc', 'otp', 'update',
    'unblock', 'refund', 'claim', 'reward', 'wallet', 'secure', 'account',
    'banking', 'payment', 'pay', 'approve', 'collect', 'recover',
    'reactivate', 'validate', 'confirm', 'customs', 'gift', 'prize',
    'winner', 'lottery', 'bonus', 'cashback', 'earn'
  ];

  // ---------------------------------------------------------------- helpers

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function decodeLeet(s) {
    return s.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e')
            .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b');
  }

  function decodeHtmlEntities(s) {
    var named = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
      '&#39;': "'", '&#x27;': "'", '&#x2F;': '/', '&#x2f;': '/'
    };
    var out = String(s);
    for (var k in named) {
      if (Object.prototype.hasOwnProperty.call(named, k)) out = out.split(k).join(named[k]);
    }
    return out;
  }

  /** Registrable domain: eTLD+1 with 3-label handling for MULTI_SUFFIX. */
  function regDomain(host) {
    var labels = String(host || '').toLowerCase().split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    var lastTwo = labels.slice(-2).join('.');
    if (MULTI_SUFFIX[lastTwo]) return labels.slice(-3).join('.');
    return lastTwo;
  }

  function hostUnder(host, domain) {
    return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
  }

  function isPrivateIPv4(host) {
    var m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    var a = +m[1], b = +m[2];
    // Every octet must be a number 0-255 (reject 192.168.1.999 etc.)
    for (var i = 1; i <= 4; i++) { if (+m[i] > 255) return false; }
    if (a === 0 || a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;   // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    if (a >= 224) return true;                 // multicast / reserved
    return false;
  }

  function isMetadataTarget(host, rawUrl) {
    var h = host.toLowerCase();
    var u = String(rawUrl || '').toLowerCase();
    return h === 'metadata.google.internal' || h === 'metadata.goog'
        || h === '169.254.169.254' || h === 'instance-data' || h === 'instance'
        || h === '100.100.100.200' || u.indexOf('169.254.169.254') !== -1;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var curr = [i];
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = curr;
    }
    return prev[b.length];
  }

  // ---------------------------------------------------------------- extract

  /**
   * Extract URL candidates from text. Returns array of raw strings, deduped,
   * capped at MAX_URLS. Scheme-ful, www., bare dotted hosts, and upi:// links
   * are all candidates. Trailing punctuation stripped; bracket/quote
   * neighbours respected so "(bit.ly/foo)" yields "bit.ly/foo".
   */
  function extractUrls(text) {
    var out = [];
    var seen = {};
    if (!text || typeof text !== 'string') return out;
    var s = decodeHtmlEntities(text);

    // scheme-ful URLs
    var re = /(?:h\x74tps?|hxxps?|ftp):\x2f\x2f[^\s<>"'`£]+/gi;
    var m;
    while ((m = re.exec(s)) !== null) {
      var v = m[0].replace(/[.,;:!?)\]}'"»…]+$/, '');
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    // www.* scheme-less
    re = /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`]*)?/gi;
    while ((m = re.exec(s)) !== null) {
      v = m[0].replace(/[.,;:!?)\]}'"»…]+$/, '');
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    // bare dotted hosts not already caught above (no www required)
    re = /(?:^|[^a-z0-9@.\/-])([a-z0-9][a-z0-9-]{0,61}(?:\.[a-z][a-z0-9-]{0,61}){1,6})(?=$|[^a-z0-9.-])/gi;
    while ((m = re.exec(s)) !== null) {
      var bare = m[1];
      if (seen[bare] || seen['http://' + bare]) continue;
      seen[bare] = 1;
      out.push(bare);
    }
    // UPI deep links
    re = /\bupi:\/\/[^\s<>"'`]+/gi;
    while ((m = re.exec(s)) !== null) {
      v = m[0].replace(/[.,;:!?)\]}'"»…]+$/, '');
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    return out.slice(0, MAX_URLS);
  }

  // ---------------------------------------------------------------- parse

  /**
   * Parse a raw URL string into components. Never throws.
   * Returns null only if the input produces an empty host AND no path.
   */
  function parseUrl(raw) {
    var url = String(raw || '').trim();
    if (!url) return null;
    var hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    var scheme = 'https'; // bare domains are treated as https-equivalent hosts
    if (hadScheme) scheme = (url.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [null, ''])[1].toLowerCase();

    var afterScheme = hadScheme ? url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : url;
    var authority = afterScheme.split(/[/?#]/)[0];
    var atSign = authority.lastIndexOf('@');
    if (atSign !== -1) authority = authority.slice(atSign + 1);
    // Everything after the authority slice position is path/query. Compute
    // from the original authority (before @-strip) so userinfo hosts aren't
    // mistaken for the start of the path.
    var preAuth = afterScheme.split(/[/?#]/)[0];
    var pathQuery = afterScheme.slice(preAuth.length);

    var port = '';
    var pm = authority.match(/:(\d{0,5})$/);
    if (pm) {
      port = pm[1];
      authority = authority.slice(0, -pm[0].length);
    }

    var host = authority.toLowerCase().replace(/^\.+|\.+$/g, '');
    if (/^\[.*\]$/.test(host)) host = host.slice(1, -1);

    var path = pathQuery.split('?')[0] || '';
    var query = pathQuery.indexOf('?') !== -1 ? pathQuery.slice(pathQuery.indexOf('?') + 1) : '';

    return {
      url: url,
      hadScheme: hadScheme,
      scheme: scheme,
      host: host,
      port: port,
      path: path,
      query: query,
      pathQuery: pathQuery
    };
  }

  // ---------------------------------------------------------------- classify

  /**
   * Classify one parsed URL. Reasons carry evidence; verdict bands:
   *   dangerous (>=60)  suspicious (>=30)  unknown (<30)
   * `remote` (optional) is { checked, verdict, source } from the server
   * scanner. A confirmed malicious reputation match dominates everything;
   * a "safe" reputation never overrides local evidence.
   */
  function classifyUrl(p, remote) {
    var reasons = [];
    var score = 0;

    function add(code, label, w, detail) {
      reasons.push({ code: code, label: label, weight: w, detail: detail || '' });
      score += w;
    }

    if (!p || !p.host) {
      return {
        verdict: 'unknown',
        score: 10,
        reasons: [{ code: 'malformed', label: 'Malformed or incomplete URL', weight: 10, detail: p ? String(p.url).slice(0, 60) : '' }]
      };
    }

    // Reputation evidence (server-side), provided by the caller.
    if (remote && remote.checked && remote.verdict === 'dangerous') {
      reasons.push({ code: 'reputation.bad', label: 'Known malicious destination', weight: 100, detail: remote.source || 'server scan' });
      return { verdict: 'dangerous', score: 100, reasons: reasons };
    }
    if (remote && remote.checked && remote.verdict === 'safe') {
      reasons.push({ code: 'reputation.ok', label: 'No known threats detected', weight: 0, detail: remote.source || 'server scan' });
    }

    // Cloud metadata / private IP destinations — never trusted and never fetched.
    if (isMetadataTarget(p.host, p.url)) {
      add('meta.host', 'Cloud metadata or link-local address', 95, p.host);
    }
    if (isPrivateIPv4(p.host)) {
      add('ip.private', 'Private or reserved IP address', 85, p.host);
    }
    if (p.host.indexOf(':') !== -1 || p.host.indexOf('[') !== -1) {
      add('ipv6.literal', 'IPv6 address host', 25, p.host);
    }

    // Userinfo occlusion (evilsite.com@real-bank.com → visible host lies)
    if (String(p.url).indexOf('@') !== -1) {
      var authorityPart = String(p.url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[\/?#]/)[0];
      if (authorityPart.lastIndexOf('@') !== -1) {
        add('userinfo', 'Hidden destination after "@"', 45, authorityPart.slice(0, 60));
      }
    }

    // Scheme
    if (p.scheme === 'http') add('noTls', 'Not HTTPS', 12, '');
    if (p.scheme !== 'https' && p.scheme !== 'http') {
      if (p.scheme === 'upi') {
        add('upi.deeplink', 'UPI payment link', 15, '');
      } else {
        add('scheme.unusual', 'Unusual link scheme', 35, p.scheme);
      }
    }

    var rd = regDomain(p.host);
    var labels = p.host.split('.').filter(Boolean);
    var tld = labels[labels.length - 1] || '';

    // Shorteners
    if (SHORTENERS[rd] || SHORTENERS[p.host]) {
      add('shortener', 'Shortened link — destination hidden', 40, rd);
    }
    // Risky TLD
    if (!SHORTENERS[rd] && SUSPICIOUS_TLDS[tld]) {
      add('tld.risky', 'Risky top-level domain', 18, '.' + tld);
    }
    // Punycode / non-ASCII
    if (p.host.indexOf('xn--') !== -1) {
      add('punycode', 'Non-ASCII hostname (punycode)', 45, p.host.slice(0, 60));
    }
    // IP literal
    if (isPrivateIPv4(p.host) === false && /^\d{1,3}(\.\d{1,3}){3}$/.test(p.host)) {
      add('ip.public', 'Raw IP address instead of a name', 25, p.host);
    }
    // Very deep subdomain stacking
    var subCount = labels.length - rd.split('.').length;
    if (subCount >= 4) {
      add('manySubdomains', 'Many subdomain levels', 12, p.host.slice(0, 50));
    }
    // Non-standard port
    if (p.port && !(p.scheme === 'http' && p.port === '80') && !(p.scheme === 'https' && p.port === '443')) {
      add('port.nonStandard', 'Non-standard port', 15, p.port);
    }

    // --- Brand ownership vs lookalike
    var ownedBrand = null;
    var candidateBrands = [];
    // Everything left of the TLD, brands may hide there (hdfcbank.com.evil.in).
    var hostNoTld = labels.slice(0, -1).join('.') || p.host;
    var hostTokens = hostNoTld.replace(/-/g, '.').replace(/[^a-z.]/g, '.').split('.').filter(Boolean);
    for (var bk in BRANDS) {
      if (!Object.prototype.hasOwnProperty.call(BRANDS, bk)) continue;
      var domains = BRANDS[bk];
      for (var d = 0; d < domains.length; d++) {
        if (hostUnder(p.host, domains[d])) { ownedBrand = bk; break; }
      }
      if (ownedBrand) break;
      // cheap gate: does any host token start with the brand (or brand+bank)?
      for (var t = 0; t < hostTokens.length; t++) {
        var tok = decodeLeet(hostTokens[t]);
        // Startswith gates: exact brand prefix catches things like
        // icicibankwand, hdfcbanksecure; brand+bank prefix catches
        // icicibank-login etc.
        if (tok.length >= bk.length && tok.indexOf(bk) === 0) {
          candidateBrands.push(bk);
          break;
        }
      }
    }
    if (!ownedBrand && candidateBrands.length) {
      // A host token that starts with a brand name — inside a domain that is
      // NOT one of that brand's official registrable domains — is lookalike
      // evidence by itself (hdfcbank.com.evil.in, icicibankwand.xyz,
      // amazon.verify-secure.top…).
      var brand = candidateBrands[0];
      add('brand.lookalike', 'Imitates ' + brand + ' — not an official domain', 55, rd);
    }

    // --- path keywords (sensitive phrasing inside a link) — in the URL's
    // path/query AND in the hostname tokens themselves (earnfast-jobs.in,
    // giftcard-claim.in carry the same tell before any path exists).
    var pathLc = decodeLeet((p.path + '?' + p.query).toLowerCase());
    var hostLc = decodeLeet(p.host.toLowerCase().replace(/-/g, '.'));
    for (var w = 0; w < PATH_WORDS.length; w++) {
      if (pathLc.indexOf(PATH_WORDS[w]) !== -1) {
        add('path.sensitive', 'Sensitive word in the link', 10, PATH_WORDS[w]);
        break;
      }
      if (hostLc.split('.').some(function (tok) {
        // exact token, or a >=5-char token that begins with the keyword
        // (earnfast-jobs.in carries "earn" as "earnfast")
        return tok === PATH_WORDS[w] ||
               (PATH_WORDS[w].length >= 4 && tok.length >= 5 && tok.indexOf(PATH_WORDS[w]) === 0);
      })) {
        add('path.sensitive', 'Sensitive word in the link', 10, PATH_WORDS[w]);
        break;
      }
    }

    // --- verdict band
    var verdict;
    if (score >= 60) verdict = 'dangerous';
    else if (score >= 30) verdict = 'suspicious';
    else verdict = 'unknown';
    return { verdict: verdict, score: score, reasons: reasons };
  }

  // ---------------------------------------------------------------- API

  /**
   * Message-level call: extracts, parses, classifies every URL in a
   * message. Returns null when no URLs (caller skips the links block).
   * Never throws.
   */
  function analyzeMessage(text) {
    try {
      var raws = extractUrls(text);
      if (!raws.length) return null;
      var links = [];
      var worst = 'unknown';
      var ORDER = { dangerous: 3, suspicious: 2, malformed: 2, unknown: 1 };
      for (var i = 0; i < raws.length; i++) {
        var parsed = parseUrl(raws[i]);
        var cls = classifyUrl(parsed, null);
        var link = {
          url: String(raws[i]).slice(0, 200),
          host: parsed ? parsed.host : '',
          verdict: cls.verdict,
          score: cls.score,
          reasons: cls.reasons
        };
        links.push(link);
        if ((ORDER[cls.verdict] || 0) > (ORDER[worst] || 0)) worst = cls.verdict;
      }
      return { worst: worst, links: links };
    } catch (err) {
      return null;
    }
  }

  var LinkGuard = {
    version: VERSION,
    extractUrls: extractUrls,
    parseUrl: parseUrl,
    classifyUrl: classifyUrl,
    regDomain: regDomain,
    analyzeMessage: analyzeMessage
  };

  root.FS.LinkGuard = LinkGuard;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LinkGuard;
  }
})();
