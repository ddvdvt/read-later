// Importers: Pocket (HTML and CSV exports), Omnivore (ZIP with JSON metadata + content +
// highlights), Netscape bookmark files (browsers, Instapaper, Raindrop…), generic CSV,
// plain URL lists, the browser's bookmark tree and our own JSON backup. Pure functions:
// every importer returns ImportRow[]; the caller merges rows into the library.
import { parseHtml, isEl } from './html.js';
import { extractUrls, isSavableUrl, normalizeUrl } from './url.js';
import { normalizeTags, validTime, makeItem, newId } from './model.js';
import { mdToTree } from './markdown.js';
import { treeToHtml, sanitizeTree, flatText } from './tree.js';
import { buildArticle } from './article.js';
import { termsOf } from './search.js';
import { makeSelector } from './highlights.js';

/**
 * @typedef {object} ImportRow
 * @property {string} url
 * @property {string} [title]
 * @property {number} [addedAt]
 * @property {string[]} [tags]
 * @property {'unread' | 'archived'} [status]
 * @property {boolean} [favorite]
 * @property {string} [excerpt]
 * @property {string} [byline]
 * @property {string} [publishedAt]
 * @property {string} [leadImage]
 * @property {number} [progress]
 * @property {string} [html]           article HTML (unsanitized; the caller builds the article)
 * @property {string} [folder]
 * @property {Array<{ exact: string, note?: string, color?: string, createdAt?: number }>} [highlights]
 * @property {string} source
 */

/** @param {string} s */
const lc = (s) => String(s || '').toLowerCase();

// ---------------------------------------------------------------- HTML (Pocket / Netscape)

/**
 * Pocket HTML export and Netscape bookmark files: <a href time_added|add_date tags>.
 * Pocket's "Read Archive" section marks items as archived; bookmark folders go to `folder`.
 * @param {string} html
 * @param {string} [source]
 * @returns {ImportRow[]}
 */
export function parseBookmarkHtml(html, source = 'html') {
  const nodes = parseHtml(html);
  const isPocket = /pocket/i.test(html.slice(0, 2000)) || /time_added=/i.test(html);
  /** @type {ImportRow[]} */
  const rows = [];
  /** @type {string[]} */
  const folders = [];
  let section = '';
  /** @param {import('./html.js').TreeNode[]} list @param {number} depth */
  const walk = (list, depth) => {
    for (const n of list) {
      if (!isEl(n)) continue;
      if (n.tag === 'h1' || n.tag === 'h2') {
        section = text(n);
        continue;
      }
      if (n.tag === 'h3') {
        folders[depth] = text(n);
        folders.length = depth + 1;
        continue;
      }
      if (n.tag === 'a') {
        const url = (n.attrs.href || '').trim();
        if (!isSavableUrl(url)) continue;
        const archived = /archive|read archive|прочитан|архив/i.test(section) || /^(archived|archive|read)$/i.test(n.attrs.status || '');
        rows.push({
          url,
          title: text(n).trim(),
          addedAt: validTime(n.attrs.time_added || n.attrs.add_date) || undefined,
          tags: normalizeTags((n.attrs.tags || '').split(/[,|]/)),
          status: archived ? 'archived' : 'unread',
          favorite: /^(1|true)$/i.test(n.attrs.favorite || n.attrs.starred || ''),
          folder: folders.slice(0, depth).filter(Boolean).join(' / ') || undefined,
          source: isPocket ? 'pocket' : source,
        });
        continue;
      }
      walk(n.children, n.tag === 'dl' ? depth + 1 : depth);
    }
  };
  walk(nodes, 0);
  return rows;
}

/** @param {import('./html.js').TreeNode} n @returns {string} */
function text(n) {
  return isEl(n) ? n.children.map(text).join('') : n;
}

// ---------------------------------------------------------------- CSV

/**
 * RFC 4180 CSV parser (quotes, escaped quotes, CRLF, newlines inside quotes). Detects ; or tab
 * separators when the header has no commas.
 * @param {string} src
 * @returns {string[][]}
 */
export function parseCsv(src) {
  const s = String(src || '').replace(/^\ufeff/, '');
  const firstLine = s.slice(0, s.indexOf('\n') >= 0 ? s.indexOf('\n') : s.length);
  const sep = firstLine.includes(',') ? ',' : firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
  /** @type {string[][]} */
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') q = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/**
 * CSV exports: Pocket (title,url,time_added,tags,status), Instapaper
 * (URL,Title,Selection,Folder,Timestamp,Tags) and similar. Columns are found by header name;
 * without a header the first column holding URLs is used.
 * @param {string} csv
 * @returns {ImportRow[]}
 */
export function parseCsvExport(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return [];
  const head = rows[0].map((h) => lc(h).trim());
  const find = (re) => head.findIndex((h) => re.test(h));
  let urlCol = find(/^(url|link|href|address|адрес|ссылка)$/);
  const hasHeader = urlCol >= 0 || head.some((h) => /^(title|tags|status|time_added)$/.test(h));
  if (urlCol < 0) urlCol = rows[hasHeader ? 1 : 0]?.findIndex((v) => /^https?:\/\//i.test(v.trim())) ?? -1;
  if (urlCol < 0) return [];
  const titleCol = hasHeader ? find(/^(title|name|заголовок|название)$/) : -1;
  const timeCol = hasHeader ? find(/^(time_added|timestamp|added|added_at|created|created_at|date|saved_at|date_added)$/) : -1;
  const tagsCol = hasHeader ? find(/^(tags|labels|теги|метки)$/) : -1;
  const statusCol = hasHeader ? find(/^(status|state|folder|read)$/) : -1;
  const favCol = hasHeader ? find(/^(favorite|favourite|starred|is_favorite)$/) : -1;
  const exCol = hasHeader ? find(/^(excerpt|description|selection|summary)$/) : -1;
  const isPocket = hasHeader && head.includes('time_added');
  const isInstapaper = hasHeader && head.includes('selection') && head.includes('folder');
  /** @type {ImportRow[]} */
  const out = [];
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    const url = (r[urlCol] || '').trim();
    if (!isSavableUrl(url)) continue;
    const st = lc(statusCol >= 0 ? r[statusCol] : '');
    const tagsRaw = tagsCol >= 0 ? r[tagsCol] || '' : '';
    out.push({
      url,
      title: titleCol >= 0 ? (r[titleCol] || '').trim() : '',
      addedAt: validTime(timeCol >= 0 ? r[timeCol] : '') || undefined,
      tags: normalizeTags(splitTags(tagsRaw)),
      status: /^(archive|archived|read|true|1)$/.test(st) ? 'archived' : 'unread',
      favorite: /^(1|true|yes)$/.test(lc(favCol >= 0 ? r[favCol] : '')) || st === 'starred',
      excerpt: exCol >= 0 ? (r[exCol] || '').trim().slice(0, 400) : '',
      source: isPocket ? 'pocket' : isInstapaper ? 'instapaper' : 'csv',
    });
  }
  return out;
}

/**
 * Tags cell of a CSV export: "a|b" (Pocket), ["a","b"] (Instapaper) or "a, b".
 * @param {string} raw
 * @returns {string[]}
 */
export function splitTags(raw) {
  const v = String(raw || '').trim();
  if (v.startsWith('[')) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map((x) => (typeof x === 'string' ? x : x && x.name) || '');
    } catch {
      /* not JSON */
    }
  }
  return v.includes('|') ? v.split('|') : v.split(/[,;]/);
}

// ---------------------------------------------------------------- plain list

/**
 * One URL per line (or any text with URLs in it).
 * @param {string} text
 * @returns {ImportRow[]}
 */
export function parseUrlList(text) {
  return extractUrls(text)
    .filter(isSavableUrl)
    .map((url) => ({ url, source: 'urls' }));
}

// ---------------------------------------------------------------- Omnivore

/**
 * Omnivore highlights file (Markdown): quotes start with "> ", the lines after a quote are its note.
 * @param {string} md
 * @returns {Array<{ exact: string, note: string }>}
 */
export function parseHighlightsMd(md) {
  const out = [];
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {{ exact: string[], note: string[], closed?: boolean } | null} */
  let cur = null;
  const done = () => {
    if (cur) {
      const exact = cur.exact.join(' ').replace(/\s*\[[^\]]*\]\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
      if (exact) out.push({ exact, note: cur.note.join('\n').trim() });
    }
    cur = null;
  };
  for (const line of lines) {
    if (/^\s*>/.test(line)) {
      if (cur && (cur.note.length || cur.closed)) done();
      if (!cur) cur = { exact: [], note: [] };
      cur.exact.push(line.replace(/^\s*>\s?/, ''));
    } else if (/^#{1,6}\s/.test(line)) {
      done();
    } else if (cur) {
      if (line.trim()) cur.note.push(line.trim());
      else if (cur.note.length) done();
      else cur.closed = true;
    }
  }
  done();
  return out;
}

/**
 * Omnivore export ZIP contents: metadata_*.json (arrays of articles), content/<slug>.html|.md,
 * highlights/<slug>.md.
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {ImportRow[]}
 */
export function parseOmnivore(entries) {
  const dec = new TextDecoder();
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const e of entries) files.set(e.name.replace(/\\/g, '/').replace(/^\.?\//, ''), dec.decode(e.data));
  const meta = [...files.keys()].filter((n) => /(^|\/)metadata[^/]*\.json$/i.test(n)).sort();
  /** @type {ImportRow[]} */
  const out = [];
  const findFile = (dir, slug, exts) => {
    for (const [name, body] of files) {
      for (const ext of exts) if (name === `${dir}/${slug}.${ext}` || name.endsWith(`/${dir}/${slug}.${ext}`)) return { body, ext };
    }
    return null;
  };
  for (const name of meta) {
    let list;
    try {
      list = JSON.parse(/** @type {string} */ (files.get(name)));
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || typeof a !== 'object') continue;
      const url = String(a.url || a.originalUrl || '').trim();
      if (!isSavableUrl(url)) continue;
      const slug = String(a.slug || a.id || '');
      const content = slug ? findFile('content', slug, ['html', 'md']) : null;
      const hl = slug ? findFile('highlights', slug, ['md']) : null;
      const labels = Array.isArray(a.labels) ? a.labels.map((l) => (typeof l === 'string' ? l : l && l.name)) : [];
      const state = lc(a.state);
      out.push({
        url,
        title: String(a.title || ''),
        addedAt: validTime(a.savedAt || a.createdAt) || undefined,
        tags: normalizeTags(labels),
        status: state === 'archived' || a.isArchived === true || !!a.archivedAt ? 'archived' : 'unread',
        favorite: false,
        excerpt: String(a.description || ''),
        byline: String(a.author || ''),
        publishedAt: String(a.publishedAt || '').slice(0, 10),
        leadImage: String(a.thumbnail || a.image || ''),
        progress: Number(a.readingProgress) > 1 ? Number(a.readingProgress) / 100 : Number(a.readingProgress) || 0,
        html: content ? (content.ext === 'md' ? treeToHtml(sanitizeTree(mdToTree(content.body), { base: url })) : content.body) : undefined,
        highlights: hl ? parseHighlightsMd(hl.body) : undefined,
        source: 'omnivore',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- browser bookmarks

/**
 * @typedef {{ id?: string, title?: string, url?: string, dateAdded?: number, children?: BookmarkNode[] }} BookmarkNode
 */

/**
 * Flatten a chrome.bookmarks subtree; folder names (below the chosen folder) become tags when asked.
 * @param {BookmarkNode[]} nodes
 * @param {{ folderTags?: boolean }} [opts]
 * @returns {ImportRow[]}
 */
export function bookmarksToRows(nodes, opts = {}) {
  /** @type {ImportRow[]} */
  const out = [];
  /** @param {BookmarkNode[]} list @param {string[]} path */
  const walk = (list, path) => {
    for (const n of list || []) {
      if (n.url) {
        if (!isSavableUrl(n.url)) continue;
        out.push({
          url: n.url,
          title: n.title || '',
          addedAt: validTime(n.dateAdded) || undefined,
          tags: opts.folderTags ? normalizeTags(path) : [],
          folder: path.join(' / ') || undefined,
          source: 'bookmarks',
        });
      } else if (n.children) walk(n.children, n.title ? [...path, n.title] : path);
    }
  };
  for (const root of nodes || []) walk(root.children || [root], []);
  return out;
}

/**
 * Folders of a bookmark tree for the picker: [{ id, title, depth, count }].
 * @param {BookmarkNode[]} nodes
 */
export function bookmarkFolders(nodes) {
  /** @type {Array<{ id: string, title: string, depth: number, count: number }>} */
  const out = [];
  /** @param {BookmarkNode} n */
  const count = (n) => (n.url ? 1 : (n.children || []).reduce((s, c) => s + count(c), 0));
  /** @param {BookmarkNode[]} list @param {number} depth */
  const walk = (list, depth) => {
    for (const n of list || []) {
      if (n.url || !n.children) continue;
      if (n.id !== '0') out.push({ id: String(n.id), title: n.title || '', depth, count: count(n) });
      walk(n.children, n.id === '0' ? depth : depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

// ---------------------------------------------------------------- detection

/**
 * Guess the format of an import file from its name and first bytes.
 * @param {string} name
 * @param {Uint8Array} head first bytes of the file
 * @returns {'zip' | 'json' | 'html' | 'csv' | 'text'}
 */
export function detectFormat(name, head) {
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  const start = new TextDecoder().decode(head.subarray(0, 512)).replace(/^\ufeff/, '').trimStart();
  const n = lc(name);
  if (n.endsWith('.json') || start.startsWith('{') || start.startsWith('[')) return 'json';
  if (n.endsWith('.html') || n.endsWith('.htm') || /^<(!doctype|html|!--|dl|h1|meta|title|ul)/i.test(start)) return 'html';
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return 'csv';
  const firstLine = start.split('\n')[0];
  if (/^"?(title|url)"?[,;\t]/i.test(firstLine)) return 'csv';
  return 'text';
}

/**
 * Merge import rows into the existing library: rows for URLs already present (and not in the
 * trash) become updates (tags union, favorite, archived state from the file is NOT forced);
 * duplicates inside the file are collapsed.
 * @param {Array<{ id: string, normUrl: string, deletedAt: number | null, tags: string[], content: string }>} existing
 * @param {ImportRow[]} rows
 */
export function planImport(existing, rows) {
  /** @type {Map<string, typeof existing[number]>} */
  const byUrl = new Map();
  for (const it of existing) if (!it.deletedAt) byUrl.set(it.normUrl, it);
  /** @type {Map<string, ImportRow>} */
  const fresh = new Map();
  /** @type {Array<{ id: string, row: ImportRow }>} */
  const updates = [];
  let duplicates = 0;
  for (const r of rows) {
    const key = normalizeUrl(r.url);
    const ex = byUrl.get(key);
    if (ex) {
      duplicates++;
      const newTags = (r.tags || []).some((t) => !ex.tags.includes(t));
      if (newTags || r.favorite || (r.html && ex.content !== 'full') || (r.highlights && r.highlights.length)) updates.push({ id: ex.id, row: r });
      continue;
    }
    const prev = fresh.get(key);
    if (prev) {
      duplicates++;
      prev.tags = normalizeTags([...(prev.tags || []), ...(r.tags || [])]);
      continue;
    }
    fresh.set(key, { ...r, tags: r.tags || [] });
  }
  return { creates: [...fresh.values()], updates, duplicates };
}

/**
 * Turn an import row into records for the database: the item, its text when the export
 * contained the article, search terms and highlights anchored in the article text.
 * @param {ImportRow} row
 * @param {number} [now]
 */
export function buildImportRecord(row, now = Date.now()) {
  const base = {
    url: row.url,
    title: row.title,
    addedAt: row.addedAt,
    tags: row.tags,
    status: row.status,
    favorite: row.favorite,
    excerpt: row.excerpt,
    byline: row.byline,
    publishedAt: row.publishedAt,
    leadImage: row.leadImage,
    progress: row.progress,
    source: row.source,
    content: /** @type {'link'} */ ('link'),
  };
  /** @type {{ id: string, html: string, text: string } | null} */
  let content = null;
  let text = '';
  let item;
  if (row.html) {
    const built = buildArticle({ url: row.url, title: row.title, byline: row.byline, excerpt: row.excerpt, publishedTime: row.publishedAt, leadImage: row.leadImage, content: row.html });
    if (built.html) {
      item = makeItem({ ...base, title: row.title || built.title, byline: row.byline || built.byline, excerpt: row.excerpt || built.excerpt, publishedAt: built.publishedAt, leadImage: built.leadImage, words: built.words, lang: built.lang, content: 'full' }, now);
      content = { id: item.id, html: built.html, text: built.text };
      text = built.text;
    }
  }
  if (!item) item = makeItem(base, now);
  /** @type {import('./highlights.js').Highlight[]} */
  const highlights = [];
  if (content && Array.isArray(row.highlights)) {
    const flat = flatText(parseHtml(content.html));
    for (const h of row.highlights) {
      const exact = String(h.exact || '').trim();
      if (!exact) continue;
      let idx = flat.indexOf(exact);
      if (idx < 0) idx = flat.replace(/\s+/g, ' ').indexOf(exact.replace(/\s+/g, ' '));
      const sel = idx >= 0 ? makeSelector(flat, idx, idx + exact.length) : null;
      const t = validTime(h.createdAt) || now;
      highlights.push({ id: newId(now) + highlights.length, itemId: item.id, ...(sel || { exact, prefix: '', suffix: '', start: 0 }), color: h.color || 'yellow', note: String(h.note || ''), createdAt: t, updatedAt: t });
    }
    item.highlights = highlights.length;
  }
  return { item, content, terms: termsOf({ ...item, text }), highlights: highlights.length ? highlights : null };
}
