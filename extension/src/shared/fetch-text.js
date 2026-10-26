// "Load text later" for items saved as links (imports, context menu on a link) and saving
// several selected tabs. Both need access to sites the user did not click on, so the extension
// asks for the optional host permission at that moment and gives it back right after the job.
//
// Pages that use this module must also load vendor/Readability.js and src/content/capture.js.
import { detectCharset } from '../../lib/settings.js';
import { originPattern, isSavableUrl } from '../../lib/url.js';
import { storeCapture, captureTab, imageBudget, saveLink } from './save.js';
import { updateItems } from './db.js';

export const ALL_SITES = ['http://*/*', 'https://*/*'];
const MAX_PAGE = 15 * 1024 * 1024;

/**
 * Origins needed for these URLs, unique.
 * @param {string[]} urls
 */
export function originsFor(urls) {
  return [...new Set(urls.map(originPattern).filter(Boolean))];
}

/**
 * Ask for host access. MUST be the first await inside a click handler (user gesture).
 * Chrome shows its own prompt; already granted origins resolve without a prompt.
 * @param {string[]} origins
 */
export async function requestOrigins(origins) {
  if (!origins.length) return false;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

/** Give host access back (errors for permissions declared in the manifest are ignored). @param {string[]} origins */
export async function releaseOrigins(origins) {
  try {
    if (origins.length) await chrome.permissions.remove({ origins });
  } catch {
    /* required permission (tests) or already removed */
  }
}

/**
 * Download a page and run the capture on it (no scripts of the page run: DOMParser documents are inert).
 * @param {string} url
 * @param {number} budget image bytes
 * @param {AbortSignal} [signal]
 */
export async function fetchCapture(url, budget, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml/i.test(type)) throw new Error('not-html');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_PAGE) throw new Error('too-large');
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 4096));
    const html = new TextDecoder(detectCharset(type, head)).decode(buf);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const finalUrl = res.url || url;
    const base = doc.createElement('base');
    base.href = finalUrl;
    doc.head.prepend(base);
    const cap = await /** @type {any} */ (globalThis).__readLaterCapture(doc, { url: finalUrl, imageBudget: budget });
    return { ...cap, url };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Load text for link items. Calls onProgress after each one. Items that fail are marked 'failed'
 * (they stay links and can be retried).
 * @param {Array<{ id: string, url: string }>} items
 * @param {import('../../lib/settings.js').Settings} settings
 * @param {{ onProgress?: (done: number, ok: number, failed: number) => void, signal?: AbortSignal, concurrency?: number }} [opts]
 */
export async function loadTexts(items, settings, opts = {}) {
  let done = 0;
  let ok = 0;
  let failed = 0;
  const queue = [...items];
  const budget = imageBudget(settings);
  const worker = async () => {
    while (queue.length && !opts.signal?.aborted) {
      const it = /** @type {{ id: string, url: string }} */ (queue.shift());
      try {
        const cap = await fetchCapture(it.url, budget, opts.signal);
        const r = await storeCapture(cap, { existingId: it.id });
        if (r.hasText) ok++;
        else {
          failed++;
          await updateItems([it.id], (x) => ({ ...x, content: 'failed' }), { silent: true });
        }
      } catch {
        if (opts.signal?.aborted) break;
        failed++;
        await updateItems([it.id], (x) => (x.content === 'full' ? x : { ...x, content: 'failed' }), { silent: true }).catch(() => {});
      }
      done++;
      opts.onProgress?.(done, ok, failed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency || 3, items.length) }, worker));
  return { done, ok, failed };
}

/**
 * Save several tabs (requires host access, see requestOrigins(ALL_SITES)).
 * @param {number[]} tabIds
 * @param {import('../../lib/settings.js').Settings} settings
 * @param {(done: number, ok: number, failed: number) => void} [onProgress]
 */
export async function saveTabs(tabIds, settings, onProgress) {
  let done = 0;
  let ok = 0;
  let failed = 0;
  for (const id of tabIds) {
    /** @type {chrome.tabs.Tab | null} */
    let tab = null;
    try {
      tab = await chrome.tabs.get(id);
      if (!isSavableUrl(tab.url || '')) throw new Error('not-savable');
      const cap = await captureTab(id, imageBudget(settings));
      const r = await storeCapture({ ...cap, url: cap.url || tab.url, title: cap.title || tab.title }, { source: 'page' });
      if (r.hasText) ok++;
      else failed++;
    } catch {
      failed++;
      // keep at least the link (e.g. a PDF tab)
      if (tab && isSavableUrl(tab.url || '')) await saveLink(/** @type {string} */ (tab.url), tab.title).catch(() => null);
    }
    done++;
    onProgress?.(done, ok, failed);
  }
  return { done, ok, failed };
}
