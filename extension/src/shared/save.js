// Saving: capture a tab (Readability in the page) or store a bare link, then write the article
// in one transaction. Shared by the service worker (shortcut, context menu, popup) and the
// library page (saving several tabs, loading text for imported links).
import { buildArticle } from '../../lib/article.js';
import { makeItem, mergeCapture, normalizeTags } from '../../lib/model.js';
import { termsOf } from '../../lib/search.js';
import { normalizeUrl, isSavableUrl, titleFromUrl } from '../../lib/url.js';
import { ensureSettings } from '../../lib/settings.js';
import { findByUrl, getItem, putRecord } from './db.js';

/** @typedef {import('../../lib/model.js').Item} Item */
/** @typedef {Awaited<ReturnType<typeof import('../../lib/article.js').buildArticle>>} Built */

// Absolute paths: Firefox resolves relative `files` against the calling page (e.g. src/library/),
// Chrome against the extension root; with a leading slash both mean the extension root.
export const CAPTURE_FILES = ['/vendor/Readability.js', '/src/content/capture.js'];

/** @returns {Promise<import('../../lib/settings.js').Settings>} */
export async function loadSettings() {
  try {
    const r = await chrome.storage.local.get('settings');
    return ensureSettings(r.settings);
  } catch {
    return ensureSettings({});
  }
}

/** Image byte budget for one article. @param {import('../../lib/settings.js').Settings} s */
export function imageBudget(s) {
  return s.saveImages ? s.imageCapMb * 1024 * 1024 : 0;
}

/**
 * Run the capture script in a tab. Needs activeTab (user gesture) or a host permission.
 * @param {number} tabId
 * @param {number} budget image bytes
 */
export async function captureTab(tabId, budget) {
  await chrome.scripting.executeScript({ target: { tabId }, files: CAPTURE_FILES });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (b) => /** @type {any} */ (globalThis).__readLaterCapture(document, { imageBudget: b }),
    args: [budget],
  });
  if (!res || !res.result) throw new Error('no result from the page');
  return res.result;
}

/** data: URL → Blob without fetch. @param {string} dataUrl */
export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

/**
 * Store a capture: a new item, or the existing one for the same URL updated with fresh text
 * (status, tags, favorite, progress and highlights are kept).
 * @param {any} cap result of __readLaterCapture
 * @param {{ source?: string, tags?: string[], existingId?: string }} [opts]
 * @returns {Promise<{ item: Item, created: boolean, hasText: boolean }>}
 */
export async function storeCapture(cap, opts = {}) {
  const built = buildArticle(cap);
  const hasText = !!built.html;
  const now = Date.now();
  const existing = opts.existingId ? await getItem(opts.existingId) : await findByUrl(normalizeUrl(cap.url));
  const fresh = {
    url: cap.url,
    title: built.title,
    byline: built.byline,
    site: built.site,
    excerpt: built.excerpt,
    lang: built.lang,
    dir: built.dir,
    publishedAt: built.publishedAt,
    leadImage: built.leadImage,
    words: built.words,
    content: /** @type {const} */ (hasText ? 'full' : 'link'),
    tags: normalizeTags(opts.tags || []),
  };
  const item = existing ? mergeCapture(existing, fresh, now) : makeItem({ ...fresh, source: opts.source || 'page' }, now);
  if (existing && opts.existingId) item.url = existing.url; // keep the saved address when re-fetching
  const images = [];
  for (const im of Array.isArray(cap.images) ? cap.images : []) {
    const blob = typeof im.data === 'string' ? dataUrlToBlob(im.data) : null;
    if (blob && built.images.includes(im.url)) images.push({ url: im.url, blob });
  }
  await putRecord({
    item,
    content: hasText ? { id: item.id, html: built.html, text: built.text } : null,
    terms: hasText || !existing || existing.content !== 'full' ? termsOf({ ...item, text: hasText ? built.text : '' }) : null,
    images: hasText ? images : null,
  });
  return { item, created: !existing, hasText };
}

/**
 * Save a link without its text (context menu on a link, imported URL).
 * @param {string} url
 * @param {string} [title]
 * @returns {Promise<{ item: Item, created: boolean } | null>}
 */
export async function saveLink(url, title) {
  if (!isSavableUrl(url)) return null;
  const existing = await findByUrl(normalizeUrl(url));
  if (existing && !existing.deletedAt) return { item: existing, created: false };
  const item = existing ? { ...existing, deletedAt: null, updatedAt: Date.now() } : makeItem({ url, title: title || titleFromUrl(url), content: 'link', source: 'link' });
  await putRecord({ item, terms: existing ? null : termsOf(item) });
  return { item, created: !existing };
}
