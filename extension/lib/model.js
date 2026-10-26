// The library item model: creation, merging a re-save into an existing item, state changes,
// trash with a 30-day retention, tags, filtering and sorting. Pure functions, no storage.
import { normalizeUrl, displayHost, titleFromUrl } from './url.js';
import { clean, readingMinutes } from './article.js';

/**
 * @typedef {'unread' | 'archived'} Status
 * @typedef {'full' | 'link' | 'failed'} ContentState
 *
 * @typedef {object} Item
 * @property {string} id
 * @property {string} url
 * @property {string} normUrl
 * @property {string} title
 * @property {string} byline
 * @property {string} site
 * @property {string} excerpt
 * @property {string} lang
 * @property {string} dir
 * @property {string} publishedAt
 * @property {string} leadImage
 * @property {number} words
 * @property {Status} status
 * @property {boolean} favorite
 * @property {string[]} tags
 * @property {number} addedAt
 * @property {number} updatedAt
 * @property {number | null} archivedAt
 * @property {number | null} deletedAt
 * @property {number} progress     0..1 scroll position in the reader
 * @property {number | null} lastReadAt
 * @property {ContentState} content
 * @property {string} source       page | link | pocket | omnivore | bookmarks | urls | backup | html
 * @property {number} highlights   number of highlights (denormalized for the list)
 * @property {number} imageBytes   bytes of images saved for offline reading
 */

export const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/** Random id (time-sortable prefix + randomness). */
export function newId(now = Date.now()) {
  const rnd = Array.from({ length: 8 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return now.toString(36).padStart(9, '0') + rnd;
}

/**
 * Normalize a tag list: trimmed, lower-case, no '#', unique, max 40 chars each, max 50 tags.
 * @param {unknown} tags string[] or "a, b; c"
 * @returns {string[]}
 */
export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,;|\n]/);
  const out = [];
  for (const t of list) {
    const v = String(t ?? '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase()
      .slice(0, 40);
    if (v && !out.includes(v) && v !== '_untagged_') out.push(v);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Create an item from partial data (an import row, a capture…). Missing fields get safe defaults.
 * @param {Partial<Item> & { url: string }} data
 * @param {number} [now]
 * @returns {Item}
 */
export function makeItem(data, now = Date.now()) {
  const url = String(data.url || '').trim();
  const status = data.status === 'archived' ? 'archived' : 'unread';
  const addedAt = validTime(data.addedAt) || now;
  return {
    id: data.id && /^[\w-]{4,64}$/.test(data.id) ? data.id : newId(now),
    url,
    normUrl: normalizeUrl(url),
    title: clean(data.title) || titleFromUrl(url),
    byline: clean(data.byline, 200),
    site: clean(data.site, 120) || displayHost(url),
    excerpt: clean(data.excerpt, 400),
    lang: String(data.lang || ''),
    dir: data.dir === 'rtl' ? 'rtl' : '',
    publishedAt: String(data.publishedAt || ''),
    leadImage: String(data.leadImage || ''),
    words: Math.max(0, Math.round(Number(data.words) || 0)),
    status,
    favorite: !!data.favorite,
    tags: normalizeTags(data.tags || []),
    addedAt,
    updatedAt: validTime(data.updatedAt) || now,
    archivedAt: status === 'archived' ? validTime(data.archivedAt) || addedAt : null,
    deletedAt: validTime(data.deletedAt) || null,
    progress: clamp01(data.progress),
    lastReadAt: validTime(data.lastReadAt) || null,
    content: data.content === 'full' || data.content === 'failed' ? data.content : 'link',
    source: String(data.source || 'page'),
    highlights: Math.max(0, Number(data.highlights) || 0),
    imageBytes: Math.max(0, Number(data.imageBytes) || 0),
  };
}

/** @param {unknown} v */
function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Accepts ms timestamps (or seconds, as Pocket exports them). @param {unknown} v */
export function validTime(v) {
  if (v === null || v === undefined || v === '') return 0;
  let n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    n = Date.parse(String(v));
    if (!Number.isFinite(n)) return 0;
  }
  if (n > 0 && n < 1e11) n *= 1000; // seconds
  if (n < Date.UTC(1995, 0, 1) || n > Date.UTC(2100, 0, 1)) return 0;
  return Math.round(n);
}

/**
 * Apply a fresh capture to an existing item ("save again"): new text and metadata,
 * the user's state (status, favorite, tags, progress, highlights) is kept.
 * A restored-from-trash item comes back.
 * @param {Item} item
 * @param {Partial<Item>} fresh
 * @param {number} [now]
 * @returns {Item}
 */
export function mergeCapture(item, fresh, now = Date.now()) {
  const keep = (a, b) => (b ? b : a);
  return {
    ...item,
    url: keep(item.url, fresh.url),
    normUrl: normalizeUrl(keep(item.url, fresh.url)),
    title: keep(item.title, fresh.title),
    byline: keep(item.byline, fresh.byline),
    site: keep(item.site, fresh.site),
    excerpt: keep(item.excerpt, fresh.excerpt),
    lang: keep(item.lang, fresh.lang),
    dir: fresh.dir !== undefined ? fresh.dir || '' : item.dir,
    publishedAt: keep(item.publishedAt, fresh.publishedAt),
    leadImage: keep(item.leadImage, fresh.leadImage),
    words: fresh.content === 'full' ? Number(fresh.words) || 0 : item.words,
    content: fresh.content === 'full' ? 'full' : item.content === 'full' ? 'full' : fresh.content || item.content,
    tags: normalizeTags([...item.tags, ...(fresh.tags || [])]),
    deletedAt: null,
    updatedAt: now,
  };
}

/**
 * @param {Item} item
 * @param {'archive' | 'unarchive' | 'favorite' | 'unfavorite' | 'trash' | 'restore'} action
 * @param {number} [now]
 * @returns {Item}
 */
export function applyAction(item, action, now = Date.now()) {
  switch (action) {
    case 'archive':
      return { ...item, status: 'archived', archivedAt: now, updatedAt: now };
    case 'unarchive':
      return { ...item, status: 'unread', archivedAt: null, updatedAt: now };
    case 'favorite':
      return { ...item, favorite: true, updatedAt: now };
    case 'unfavorite':
      return { ...item, favorite: false, updatedAt: now };
    case 'trash':
      return { ...item, deletedAt: now, updatedAt: now };
    case 'restore':
      return { ...item, deletedAt: null, updatedAt: now };
    default:
      return item;
  }
}

/**
 * Items in the trash longer than the retention period.
 * @param {Item[]} items
 * @param {number} [now]
 * @param {number} [days]
 */
export function expiredTrash(items, now = Date.now(), days = TRASH_DAYS) {
  return items.filter((i) => i.deletedAt && now - i.deletedAt >= days * DAY);
}

/** Days left before an item in the trash is deleted for good. @param {Item} item @param {number} [now] */
export function trashDaysLeft(item, now = Date.now()) {
  if (!item.deletedAt) return TRASH_DAYS;
  return Math.max(0, Math.ceil((item.deletedAt + TRASH_DAYS * DAY - now) / DAY));
}

/**
 * @typedef {'unread' | 'favorites' | 'archive' | 'all' | 'trash' | 'highlights'} View
 * @typedef {'newest' | 'oldest' | 'title' | 'site' | 'shortest' | 'longest' | 'progress'} Sort
 */

/**
 * Filter and sort items for the library list.
 * @param {Item[]} items
 * @param {{ view?: View, tag?: string, ids?: Set<string> | null, sort?: Sort, content?: '' | 'link' | 'full' }} q
 * @param {string} [locale]
 */
export function filterItems(items, q = {}, locale = 'ru') {
  const view = q.view || 'unread';
  const out = items.filter((i) => {
    if (view === 'trash') {
      if (!i.deletedAt) return false;
    } else {
      if (i.deletedAt) return false;
      if (view === 'unread' && i.status !== 'unread') return false;
      if (view === 'archive' && i.status !== 'archived') return false;
      if (view === 'favorites' && !i.favorite) return false;
      if (view === 'highlights' && !i.highlights) return false;
    }
    if (q.tag === '\u0000untagged') {
      if (i.tags.length) return false;
    } else if (q.tag && !i.tags.includes(q.tag)) return false;
    if (q.content === 'link' && i.content === 'full') return false;
    if (q.content === 'full' && i.content !== 'full') return false;
    if (q.ids && !q.ids.has(i.id)) return false;
    return true;
  });
  return sortItems(out, view === 'trash' && !q.sort ? 'deleted' : q.sort || 'newest', locale);
}

/**
 * @param {Item[]} items
 * @param {Sort | 'deleted'} sort
 * @param {string} [locale]
 */
export function sortItems(items, sort, locale = 'ru') {
  const coll = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const by = {
    newest: (a, b) => b.addedAt - a.addedAt,
    oldest: (a, b) => a.addedAt - b.addedAt,
    deleted: (a, b) => (b.deletedAt || 0) - (a.deletedAt || 0),
    title: (a, b) => coll.compare(a.title, b.title) || b.addedAt - a.addedAt,
    site: (a, b) => coll.compare(a.site, b.site) || b.addedAt - a.addedAt,
    shortest: (a, b) => (a.words || Infinity) - (b.words || Infinity) || b.addedAt - a.addedAt,
    longest: (a, b) => b.words - a.words || b.addedAt - a.addedAt,
    progress: (a, b) => b.progress - a.progress || (b.lastReadAt || 0) - (a.lastReadAt || 0),
  };
  return [...items].sort(by[sort] || by.newest);
}

/**
 * Tag counts over items that are not in the trash, most used first.
 * @param {Item[]} items
 * @returns {Array<[string, number]>}
 */
export function tagCounts(items) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const i of items) if (!i.deletedAt) for (const t of i.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Counters for the sidebar.
 * @param {Item[]} items
 */
export function viewCounts(items) {
  const c = { unread: 0, favorites: 0, archive: 0, all: 0, trash: 0, highlights: 0, links: 0 };
  for (const i of items) {
    if (i.deletedAt) {
      c.trash++;
      continue;
    }
    c.all++;
    if (i.status === 'unread') c.unread++;
    else c.archive++;
    if (i.favorite) c.favorites++;
    if (i.highlights) c.highlights++;
    if (i.content !== 'full') c.links++;
  }
  return c;
}

/** Reading time for an item. @param {Item} item @param {number} [wpm] */
export function itemMinutes(item, wpm) {
  return readingMinutes(item.words, wpm);
}
