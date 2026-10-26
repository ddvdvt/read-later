// Exporters: lossless JSON backup (and its validation on restore), Netscape bookmarks HTML
// (opens in any browser, Pocket-style time_added/tags attributes), Markdown files per article.
import { escapeHtml, escapeAttr, parseHtml } from './html.js';
import { treeToMarkdown } from './tree.js';
import { highlightsMarkdown } from './highlights.js';
import { makeItem } from './model.js';

export const BACKUP_FORMAT = 'read-later-backup';
export const BACKUP_VERSION = 1;

/**
 * @typedef {import('./model.js').Item} Item
 * @typedef {import('./highlights.js').Highlight} Highlight
 * @typedef {{ id: string, html: string, text: string }} Content
 * @typedef {{ itemId: string, url: string, type: string, data: string }} ImageRecord base64 data
 *
 * @typedef {object} Backup
 * @property {string} format
 * @property {number} version
 * @property {string} exportedAt
 * @property {string} app
 * @property {Record<string, unknown>} [settings]
 * @property {Array<Item & { html?: string, text?: string, highlightList?: Highlight[] }>} items
 * @property {ImageRecord[]} [images]
 */

/**
 * @param {{ items: Item[], contents: Map<string, Content>, highlights: Highlight[], settings?: Record<string, unknown>, images?: ImageRecord[], now?: Date, appVersion?: string }} d
 * @returns {Backup}
 */
export function makeBackup(d) {
  /** @type {Map<string, Highlight[]>} */
  const byItem = new Map();
  for (const h of d.highlights) {
    const list = byItem.get(h.itemId) || [];
    list.push(h);
    byItem.set(h.itemId, list);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: (d.now || new Date()).toISOString(),
    app: `read-later ${d.appVersion || ''}`.trim(),
    settings: d.settings,
    items: d.items.map((it) => {
      const c = d.contents.get(it.id);
      return { ...it, html: c ? c.html : undefined, text: c ? c.text : undefined, highlightList: byItem.get(it.id) || [] };
    }),
    images: d.images && d.images.length ? d.images : undefined,
  };
}

/**
 * Validate a backup object before restoring it. Unknown fields are ignored; items are rebuilt
 * through makeItem so a damaged file can never write malformed records.
 * @param {unknown} obj
 * @returns {{ items: Item[], contents: Content[], highlights: Highlight[], images: ImageRecord[], settings: Record<string, unknown> | null }}
 */
export function readBackup(obj) {
  const b = /** @type {any} */ (obj);
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT || !Array.isArray(b.items)) throw new Error('not a backup file');
  if (Number(b.version) > BACKUP_VERSION) throw new Error('backup from a newer version');
  /** @type {Item[]} */
  const items = [];
  /** @type {Content[]} */
  const contents = [];
  /** @type {Highlight[]} */
  const highlights = [];
  for (const raw of b.items) {
    if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string') continue;
    const it = makeItem({ ...raw, source: raw.source || 'backup' });
    if (typeof raw.html === 'string' && raw.html) contents.push({ id: it.id, html: raw.html, text: typeof raw.text === 'string' ? raw.text : '' });
    else it.content = it.content === 'full' ? 'link' : it.content;
    const hs = Array.isArray(raw.highlightList) ? raw.highlightList : [];
    for (const h of hs) {
      if (!h || typeof h.exact !== 'string' || !h.exact) continue;
      highlights.push({
        id: typeof h.id === 'string' && h.id ? h.id : `${it.id}-${highlights.length}`,
        itemId: it.id,
        exact: h.exact,
        prefix: String(h.prefix || ''),
        suffix: String(h.suffix || ''),
        start: Number(h.start) || 0,
        color: String(h.color || 'yellow'),
        note: String(h.note || ''),
        createdAt: Number(h.createdAt) || Date.now(),
        updatedAt: Number(h.updatedAt) || Number(h.createdAt) || Date.now(),
      });
    }
    it.highlights = hs.length ? highlights.filter((h) => h.itemId === it.id).length : 0;
    items.push(it);
  }
  const images = Array.isArray(b.images)
    ? b.images.filter((im) => im && typeof im.itemId === 'string' && typeof im.url === 'string' && typeof im.data === 'string' && /^image\//.test(im.type || ''))
    : [];
  const settings = b.settings && typeof b.settings === 'object' ? b.settings : null;
  return { items, contents, highlights, images, settings };
}

/**
 * Netscape bookmark file. Unread and archived items go to separate folders.
 * @param {Item[]} items
 * @param {{ unread: string, archive: string, title: string }} labels
 */
export function bookmarksHtml(items, labels) {
  const row = (it) =>
    `    <DT><A HREF="${escapeAttr(it.url)}" ADD_DATE="${Math.floor(it.addedAt / 1000)}" TIME_ADDED="${Math.floor(it.addedAt / 1000)}"` +
    (it.tags.length ? ` TAGS="${escapeAttr(it.tags.join(','))}"` : '') +
    (it.favorite ? ' FAVORITE="1"' : '') +
    (it.status === 'archived' ? ' STATUS="archived"' : '') +
    `>${escapeHtml(it.title)}</A>`;
  const live = items.filter((i) => !i.deletedAt);
  const folder = (name, list) => (list.length ? `  <DT><H3>${escapeHtml(name)}</H3>\n  <DL><p>\n${list.map(row).join('\n')}\n  </DL><p>` : '');
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${escapeHtml(labels.title)}</TITLE>`,
    `<H1>${escapeHtml(labels.title)}</H1>`,
    '<DL><p>',
    folder(labels.unread, live.filter((i) => i.status === 'unread')),
    folder(labels.archive, live.filter((i) => i.status === 'archived')),
    '</DL><p>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n') + '\n';
}

/**
 * Safe, readable file name from a title.
 * @param {string} title
 * @param {Set<string>} used lower-cased names already taken (updated)
 */
export function fileName(title, used) {
  let base = String(title || 'article')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80)
    .trim();
  if (!base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'article';
  let name = `${base}.md`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).md`;
  used.add(name.toLowerCase());
  return name;
}

/** YAML double-quoted scalar. @param {string} s */
function yaml(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/**
 * One Markdown document: YAML front matter, the article, highlights.
 * @param {Item} it
 * @param {Content | undefined} content
 * @param {Highlight[]} hs
 * @param {{ highlights: string, savedAsLink: string }} labels
 */
export function articleMarkdown(it, content, hs, labels) {
  const fm = [
    '---',
    `title: ${yaml(it.title)}`,
    `url: ${yaml(it.url)}`,
    it.byline ? `author: ${yaml(it.byline)}` : '',
    it.site ? `site: ${yaml(it.site)}` : '',
    it.publishedAt ? `published: ${it.publishedAt}` : '',
    `saved: ${new Date(it.addedAt).toISOString()}`,
    `status: ${it.status}`,
    it.favorite ? 'favorite: true' : '',
    it.tags.length ? `tags: [${it.tags.map(yaml).join(', ')}]` : '',
    '---',
  ].filter(Boolean);
  const body = content && content.html ? treeToMarkdown(parseHtml(content.html)) : `_${labels.savedAsLink}_ <${it.url}>`;
  const parts = [fm.join('\n'), `# ${it.title}`, body];
  if (hs.length) parts.push(`## ${labels.highlights}`, highlightsMarkdown(hs));
  return parts.join('\n\n') + '\n';
}

/**
 * Files for the Markdown ZIP: one .md per article plus README-style index.md.
 * @param {Item[]} items
 * @param {Map<string, Content>} contents
 * @param {Highlight[]} highlights
 * @param {{ highlights: string, savedAsLink: string, index: string }} labels
 * @returns {Array<{ name: string, data: string }>}
 */
export function markdownFiles(items, contents, highlights, labels) {
  const used = new Set(['index.md']);
  /** @type {Map<string, Highlight[]>} */
  const byItem = new Map();
  for (const h of highlights) byItem.set(h.itemId, [...(byItem.get(h.itemId) || []), h]);
  const files = [];
  const index = [`# ${labels.index}`, ''];
  for (const it of items.filter((i) => !i.deletedAt)) {
    const name = fileName(it.title, used);
    const folder = it.status === 'archived' ? 'archive' : 'unread';
    files.push({ name: `${folder}/${name}`, data: articleMarkdown(it, contents.get(it.id), byItem.get(it.id) || [], labels) });
    index.push(`- [${it.title.replace(/[[\]]/g, '')}](${encodeURI(`${folder}/${name}`)})${it.tags.length ? ' — ' + it.tags.map((t) => `#${t.replace(/\s+/g, '-')}`).join(' ') : ''}`);
  }
  files.unshift({ name: 'index.md', data: index.join('\n') + '\n' });
  return files;
}
