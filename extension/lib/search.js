// Local full-text search. Each article is reduced to a list of unique normalized terms
// (stored next to it); the library keeps an in-memory inverted index over them.
// Query: every word must match (AND), each word matches term prefixes ("програм" → "программирование"),
// "quoted phrases" are checked against title/excerpt/site text when available.

const MAX_TERMS = 6000;

/**
 * Normalize a string for matching: lower case, ё→е, no diacritics.
 * @param {string} s
 */
export function normalize(s) {
  return String(s || '')
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[À-ɏ]/g, (c) => c.normalize('NFKD').replace(/[̀-ͯ]/g, '').slice(0, 1) || c);
}

/**
 * Split text into normalized word tokens (letters/digits; inner apostrophes and dots kept out).
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) || [];
}

/**
 * Unique terms of a document (title + site + tags + text), capped.
 * Single characters are skipped except digits and CJK.
 * @param {{ title?: string, site?: string, byline?: string, tags?: string[], text?: string, excerpt?: string, url?: string }} doc
 * @returns {string[]}
 */
export function termsOf(doc) {
  const set = new Set();
  const add = (s) => {
    for (const t of tokenize(s)) {
      if (t.length < 2 && !/[\d぀-鿿]/.test(t)) continue;
      if (t.length > 40) continue;
      set.add(t);
      if (set.size >= MAX_TERMS) return false;
    }
    return true;
  };
  add([doc.title, doc.site, doc.byline, (doc.tags || []).join(' '), doc.excerpt, hostWords(doc.url)].join(' ')) && add(doc.text || '');
  return [...set];
}

/** @param {string | undefined} url */
function hostWords(url) {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

/**
 * Parse a query into words and phrases.
 * @param {string} q
 * @returns {{ words: string[], phrases: string[] }}
 */
export function parseQuery(q) {
  const phrases = [];
  const rest = String(q || '').replace(/"([^"]+)"/g, (_, p) => {
    const n = normalize(p).replace(/\s+/g, ' ').trim();
    if (n) phrases.push(n);
    return ' ' + p + ' ';
  });
  const words = [...new Set(tokenize(rest))];
  return { words, phrases };
}

export class SearchIndex {
  constructor() {
    /** @type {Map<string, Set<string>>} term → ids */
    this.postings = new Map();
    /** @type {Map<string, string[]>} id → terms */
    this.docs = new Map();
    /** @type {string[] | null} sorted vocabulary cache */
    this.vocab = null;
  }

  /** @param {string} id @param {string[]} terms */
  add(id, terms) {
    if (this.docs.has(id)) this.remove(id);
    this.docs.set(id, terms);
    for (const t of terms) {
      let s = this.postings.get(t);
      if (!s) {
        s = new Set();
        this.postings.set(t, s);
        this.vocab = null;
      }
      s.add(id);
    }
  }

  /** @param {string} id */
  remove(id) {
    const terms = this.docs.get(id);
    if (!terms) return;
    for (const t of terms) {
      const s = this.postings.get(t);
      if (!s) continue;
      s.delete(id);
      if (!s.size) {
        this.postings.delete(t);
        this.vocab = null;
      }
    }
    this.docs.delete(id);
  }

  get size() {
    return this.docs.size;
  }

  /** Sorted vocabulary (built lazily). */
  vocabulary() {
    if (!this.vocab) this.vocab = [...this.postings.keys()].sort();
    return this.vocab;
  }

  /**
   * Ids whose terms start with `prefix`.
   * @param {string} prefix normalized
   * @returns {Set<string>}
   */
  prefixIds(prefix) {
    const v = this.vocabulary();
    // binary search for the first term >= prefix
    let lo = 0;
    let hi = v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    /** @type {Set<string>} */
    const out = new Set();
    for (let i = lo; i < v.length && v[i].startsWith(prefix); i++) for (const id of /** @type {Set<string>} */ (this.postings.get(v[i]))) out.add(id);
    return out;
  }

  /**
   * Ids matching every word of the query (prefix match). Empty query → null (no filtering).
   * @param {string} q
   * @returns {Set<string> | null}
   */
  query(q) {
    const { words } = parseQuery(q);
    if (!words.length) return null;
    /** @type {Set<string> | null} */
    let acc = null;
    // rarest-looking (longest) words first narrows quickly
    for (const w of [...words].sort((a, b) => b.length - a.length)) {
      const ids = this.prefixIds(w);
      if (!acc) acc = ids;
      else {
        const next = new Set();
        for (const id of acc) if (ids.has(id)) next.add(id);
        acc = next;
      }
      if (!acc.size) break;
    }
    return acc || new Set();
  }
}

/**
 * Rank matches: title hits first, then newer items. Phrases must appear in the given haystack.
 * @param {Array<{ id: string, title: string, site?: string, excerpt?: string, tags?: string[], addedAt: number }>} items
 * @param {string} q
 */
export function rankByQuery(items, q) {
  const { words, phrases } = parseQuery(q);
  if (!words.length) return items;
  const scored = items.map((it) => {
    const title = normalize(it.title);
    const meta = normalize([it.site, (it.tags || []).join(' ')].join(' '));
    let score = 0;
    for (const w of words) {
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}`, 'u').test(title)) score += 10;
      if (meta.includes(w)) score += 3;
    }
    for (const p of phrases) if (title.includes(p)) score += 20;
    return { it, score };
  });
  scored.sort((a, b) => b.score - a.score || b.it.addedAt - a.it.addedAt);
  return scored.map((s) => s.it);
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Snippet of `text` around the first query word, for search results.
 * @param {string} text
 * @param {string} q
 * @param {number} [radius]
 * @returns {string}
 */
export function snippet(text, q, radius = 90) {
  const { words } = parseQuery(q);
  if (!words.length || !text) return '';
  const norm = normalize(text);
  let best = -1;
  for (const w of words) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}`, 'u');
    const m = re.exec(norm);
    if (m && (best < 0 || m.index < best)) best = m.index + m[1].length;
  }
  if (best < 0) return '';
  // normalize() keeps the string length for Cyrillic/Latin text, so positions map back closely enough
  const start = Math.max(0, best - radius);
  const end = Math.min(text.length, best + radius);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s.replace(/^\S*\s/, '');
  if (end < text.length) s = s.replace(/\s\S*$/, '') + '…';
  return s;
}
