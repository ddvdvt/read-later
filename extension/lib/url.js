// URL helpers: which pages can be saved, canonical form for duplicate detection, display host.

/** Query parameters that only track the click and never change the article. */
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|yclid|ysclid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|si|ref_src|ref_url|cmpid|spm|from_source|vero_id|mkt_tok|__twitter_impression|_openstat|rb_clickid|share_source)$/i;

/**
 * Only regular web pages can be captured (not chrome://, the Web Store, file:// or data:).
 * @param {string} url
 */
export function isSavableUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (/^(chrome\.google\.com|chromewebstore\.google\.com)$/i.test(u.hostname) && /webstore|detail/.test(u.href)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical URL for duplicate detection: lower-case host without "www.", no fragment, no
 * tracking parameters, sorted query, no trailing slash, http and https treated alike.
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return String(url).trim();
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const q = params.length ? '?' + new URLSearchParams(params).toString() : '';
    let path = u.pathname.replace(/\/{2,}/g, '/');
    if (path.length > 1) path = path.replace(/\/+$/, '');
    if (path === '/') path = '';
    path = path.replace(/\/(index|default)\.(html?|php|aspx?)$/i, '');
    const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) ? `:${u.port}` : '';
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${port}${path}${q}`;
  } catch {
    return String(url || '').trim();
  }
}

/**
 * Remove tracking parameters but keep the URL otherwise intact (for "open original").
 * @param {string} url
 */
export function stripTracking(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch {
    return url;
  }
}

/** Host for display: "example.com". @param {string} url */
export function displayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Origin match pattern for chrome.permissions ("https://example.com/*").
 * @param {string} url
 * @returns {string | null}
 */
export function originPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * A readable title from a bare URL ("example.com — some article name").
 * @param {string} url
 */
export function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
      .replace(/\.(html?|php|aspx?)$/i, '')
      .replace(/[-_+]+/g, ' ')
      .trim();
    return last && !/^\d+$/.test(last) ? `${host} — ${last}` : host;
  } catch {
    return String(url || '');
  }
}

/**
 * All http(s) URLs found in free text (one URL list, a note, a CSV column…), in order, unique.
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let u = m[0];
    const tail = /[),.;:!?»”’\]]+$/.exec(u);
    if (tail) {
      u = u.slice(0, tail.index);
      // keep a closing parenthesis that belongs to the URL: wiki/Foo_(bar)
      if (tail[0][0] === ')' && (u.match(/\(/g) || []).length > (u.match(/\)/g) || []).length) u += ')';
    }
    try {
      u = new URL(u).href;
    } catch {
      continue;
    }
    const key = normalizeUrl(u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}
