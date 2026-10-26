// Turns a raw capture (Readability output + page metadata) into what we store:
// sanitized HTML, plain text, word count, reading time, excerpt, lead image.
import { parseHtml } from './html.js';
import { sanitizeTree, treeToHtml, treeToText, imagesOf, safeSrc, resolveUrl } from './tree.js';
import { displayHost, titleFromUrl, normalizeUrl } from './url.js';

/**
 * @typedef {object} Capture  What the page script (src/content/capture.js) returns.
 * @property {string} url
 * @property {string} [title]
 * @property {string} [byline]
 * @property {string} [siteName]
 * @property {string} [excerpt]
 * @property {string} [publishedTime]
 * @property {string} [lang]
 * @property {string} [dir]
 * @property {string} [content]     article HTML (null/empty → saved as a link)
 * @property {string} [leadImage]   og:image or similar
 */

/**
 * @typedef {object} Built
 * @property {string} title
 * @property {string} byline
 * @property {string} site
 * @property {string} excerpt
 * @property {string} publishedAt  ISO date or ''
 * @property {string} lang
 * @property {string} dir
 * @property {string} leadImage
 * @property {number} words
 * @property {string} html         sanitized, '' when no text was extracted
 * @property {string} text
 * @property {string[]} images
 */

export const MAX_HTML = 6 * 1024 * 1024;

/** Collapse whitespace and cap the length. @param {unknown} s @param {number} [max] */
export function clean(s, max = 500) {
  const t = String(s ?? '').replace(/[\s\u00a0\u200b]+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/**
 * Number of words; CJK characters count as half a word each.
 * @param {string} text
 */
export function countWords(text) {
  const s = String(text || '');
  const words = (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length;
  const cjk = (s.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  return cjk ? Math.round(words - countCjkRuns(s) + cjk / 2) : words;
}

/** @param {string} s */
function countCjkRuns(s) {
  return (s.match(/[぀-ヿ㐀-鿿가-힯]+/g) || []).length;
}

/**
 * Reading time in whole minutes (0 for an empty text).
 * @param {number} words
 * @param {number} [wpm] words per minute
 */
export function readingMinutes(words, wpm = 200) {
  if (!words) return 0;
  return Math.max(1, Math.round(words / Math.max(50, wpm)));
}

/**
 * A short excerpt cut on a word boundary.
 * @param {string} text
 * @param {number} [max]
 */
export function makeExcerpt(text, max = 220) {
  const t = clean(text, 100000);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—–-]+$/, '') + '…';
}

/**
 * Parse a date-like string into an ISO date (YYYY-MM-DD) or ''.
 * @param {string} s
 */
export function isoDate(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1900 || d.getFullYear() > 2100) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Build the stored article from a capture.
 * @param {Capture} cap
 * @returns {Built}
 */
export function buildArticle(cap) {
  const url = String(cap.url || '');
  let html = '';
  let text = '';
  /** @type {string[]} */
  let images = [];
  const raw = typeof cap.content === 'string' ? cap.content.slice(0, MAX_HTML) : '';
  if (raw) {
    const tree = sanitizeTree(parseHtml(raw), { base: url });
    html = treeToHtml(tree);
    text = treeToText(tree);
    images = imagesOf(tree);
    if (!text && !images.length) html = '';
  }
  const words = countWords(text);
  const lead = safeSrc(cap.leadImage ? resolveUrl(cap.leadImage, url) : '') || images[0] || '';
  return {
    title: clean(cap.title) || titleFromUrl(url),
    byline: clean(cap.byline, 200),
    site: clean(cap.siteName, 120) || displayHost(url),
    excerpt: makeExcerpt(cap.excerpt && clean(cap.excerpt, 2000).length > 30 ? cap.excerpt : text || cap.excerpt || ''),
    publishedAt: isoDate(cap.publishedTime || ''),
    lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(cap.lang || '') ? String(cap.lang) : '',
    dir: cap.dir === 'rtl' ? 'rtl' : '',
    leadImage: lead,
    words,
    html,
    text,
    images,
  };
}

/**
 * Key used to find an existing item for the same page.
 * @param {string} url
 */
export const urlKey = normalizeUrl;
