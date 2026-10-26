import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBookmarkHtml, parseCsv, parseCsvExport, parseUrlList, parseHighlightsMd, parseOmnivore, bookmarksToRows,
  bookmarkFolders, detectFormat, planImport, buildImportRecord, splitTags,
} from '../extension/lib/importers.js';
import { makeBackup, readBackup, bookmarksHtml, markdownFiles, fileName, articleMarkdown, BACKUP_FORMAT } from '../extension/lib/exporters.js';
import { createZip, readZip, unzip } from '../extension/lib/zip.js';
import { makeItem } from '../extension/lib/model.js';
import { locate } from '../extension/lib/highlights.js';
import { flatText } from '../extension/lib/tree.js';
import { parseHtml } from '../extension/lib/html.js';
import { deflateZip } from './helpers/deflate-zip.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (n) => readFileSync(join(FIX, n), 'utf8');
const enc = new TextEncoder();

test('Pocket HTML export: sections, tags, times, bad links skipped', () => {
  const rows = parseBookmarkHtml(fixture('pocket-export.html'));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    url: 'https://blog.example/how-to-read',
    title: 'How to read more',
    addedAt: 1700000000000,
    tags: ['reading', 'habits'],
    status: 'unread',
    favorite: false,
    folder: undefined,
    source: 'pocket',
  });
  assert.equal(rows[1].url, 'https://news.example/item?id=42&utm_source=pocket');
  assert.equal(rows[1].title, 'Item & story');
  assert.equal(rows[3].status, 'archived');
  assert.deepEqual(rows[3].tags, ['longread']);
});

test('Netscape bookmarks file: folders, ADD_DATE', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
    <DT><H3>Bookmarks bar</H3>
    <DL><p>
      <DT><A HREF="https://a.example/1" ADD_DATE="1650000000">One</A>
      <DT><H3>Reading</H3>
      <DL><p><DT><A HREF="https://a.example/2" ADD_DATE="1650000001" TAGS="x,y">Two</A></DL><p>
    </DL><p>
    <DT><A HREF="chrome://settings">Settings</A>
  </DL>`;
  const rows = parseBookmarkHtml(html);
  assert.deepEqual(rows.map((r) => [r.url, r.folder, r.source]), [
    ['https://a.example/1', 'Bookmarks bar', 'html'],
    ['https://a.example/2', 'Bookmarks bar / Reading', 'html'],
  ]);
  assert.deepEqual(rows[1].tags, ['x', 'y']);
  assert.equal(rows[0].addedAt, 1650000000000);
});

test('CSV parser: quotes, escaped quotes, CRLF, newline in quotes, BOM, semicolons', () => {
  assert.deepEqual(parseCsv('\ufeffa,b\r\n"x, ""y""","line1\nline2"\r\n'), [['a', 'b'], ['x, "y"', 'line1\nline2']]);
  assert.deepEqual(parseCsv('url;title\nhttps://a.b;T'), [['url', 'title'], ['https://a.b', 'T']]);
});

test('Pocket CSV export', () => {
  const rows = parseCsvExport(fixture('pocket-export.csv'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].tags, ['reading', 'habits']);
  assert.equal(rows[0].addedAt, 1700000000000);
  assert.equal(rows[0].source, 'pocket');
  assert.equal(rows[1].title, 'Comma, quote "inside"');
  assert.equal(rows[1].status, 'archived');
});

test('Instapaper CSV export', () => {
  const rows = parseCsvExport(fixture('instapaper-export.csv'));
  assert.deepEqual(rows.map((r) => [r.title, r.status, r.favorite, r.source]), [
    ['Article A', 'unread', false, 'instapaper'],
    ['Article B', 'archived', false, 'instapaper'],
    ['Article C', 'unread', true, 'instapaper'],
  ]);
  assert.deepEqual(rows[0].tags, ['tech']);
  assert.equal(rows[0].excerpt, 'Some selected text');
});

test('CSV without a header: the URL column is detected', () => {
  const rows = parseCsvExport('Some title,https://x.example/a\nOther,https://x.example/b\n');
  assert.deepEqual(rows.map((r) => r.url), ['https://x.example/a', 'https://x.example/b']);
  assert.deepEqual(splitTags('["a","b"]'), ['a', 'b']);
});

test('plain URL list', () => {
  const rows = parseUrlList('https://a.example/1\n\nnot a link\nhttps://a.example/1/\n  http://b.example/x?y=1  \nftp://c');
  assert.deepEqual(rows.map((r) => r.url), ['https://a.example/1', 'http://b.example/x?y=1']);
  assert.equal(rows[0].source, 'urls');
});

test('Omnivore highlights Markdown', () => {
  const md = '# Title\n\n## Highlights\n\n> First quote [⤴️](https://omnivore.app/me/x#1)\n\nMy note here\n\n> Second\n> continues\n\n> Third';
  assert.deepEqual(parseHighlightsMd(md), [
    { exact: 'First quote', note: 'My note here' },
    { exact: 'Second continues', note: '' },
    { exact: 'Third', note: '' },
  ]);
});

const OMNI_META = [
  {
    id: 'u1', slug: 'first-article', title: 'First article', description: 'About things', author: 'Ann', url: 'https://omni.example/first',
    state: 'Succeeded', readingProgress: 40, thumbnail: 'https://omni.example/t.png', labels: [{ name: 'Tech' }, 'later'], savedAt: '2023-05-01T10:00:00.000Z', publishedAt: '2023-04-30T00:00:00.000Z',
  },
  { id: 'u2', slug: 'second', title: 'Second', url: 'https://omni.example/second', state: 'Archived', labels: [], savedAt: '2023-05-02T10:00:00.000Z' },
  { id: 'u3', slug: 'md-one', title: 'Markdown one', url: 'https://omni.example/md', state: 'Succeeded', savedAt: '2023-05-03T10:00:00.000Z' },
  { id: 'bad', url: 'not-a-url' },
];

function omnivoreZip() {
  return deflateZip([
    { name: 'metadata_0_to_20.json', data: JSON.stringify(OMNI_META) },
    { name: 'content/first-article.html', data: '<div><p>The body of the <b>first</b> article with an important sentence here.</p><script>x()</script></div>' },
    { name: 'content/md-one.md', data: '# Heading\n\nSome **markdown** text.' },
    { name: 'highlights/first-article.md', data: '# First article\n\n## Highlights\n\n> an important sentence\n\nwhy it matters' },
  ]);
}

test('unzip reads DEFLATE archives and stored ones', async () => {
  const entries = await unzip(omnivoreZip());
  assert.equal(entries.length, 4);
  assert.equal(new TextDecoder().decode(entries[2].data), '# Heading\n\nSome **markdown** text.');
  const stored = createZip([{ name: 'a/б.txt', data: 'привет' }]);
  const back = await unzip(stored);
  assert.deepEqual(back.map((e) => [e.name, new TextDecoder().decode(e.data)]), [['a/б.txt', 'привет']]);
  await assert.rejects(unzip(new Uint8Array([1, 2, 3])), /not a zip/);
});

test('Omnivore export: metadata, labels, state, content (HTML and Markdown), highlights', async () => {
  const rows = parseOmnivore(await unzip(omnivoreZip()));
  assert.equal(rows.length, 3);
  const [a, b, c] = rows;
  assert.equal(a.title, 'First article');
  assert.deepEqual(a.tags, ['tech', 'later']);
  assert.equal(a.status, 'unread');
  assert.equal(a.progress, 0.4);
  assert.equal(a.byline, 'Ann');
  assert.equal(a.publishedAt, '2023-04-30');
  assert.equal(a.addedAt, Date.parse('2023-05-01T10:00:00.000Z'));
  assert.match(a.html || '', /important sentence/);
  assert.deepEqual(a.highlights, [{ exact: 'an important sentence', note: 'why it matters' }]);
  assert.equal(b.status, 'archived');
  assert.equal(b.html, undefined);
  assert.match(c.html || '', /<h1>Heading<\/h1><p>Some <strong>markdown<\/strong> text.<\/p>/);
});

test('buildImportRecord: text, terms and anchored highlights', async () => {
  const [a, b] = parseOmnivore(await unzip(omnivoreZip()));
  const rec = buildImportRecord(a, 1700000000000);
  assert.equal(rec.item.content, 'full');
  assert.ok(rec.content && !rec.content.html.includes('script'));
  assert.ok(rec.item.words > 5);
  assert.ok(rec.terms.includes('important'));
  assert.equal(rec.item.highlights, 1);
  assert.ok(rec.highlights);
  const h = rec.highlights[0];
  assert.equal(h.itemId, rec.item.id);
  assert.equal(h.note, 'why it matters');
  const text = flatText(parseHtml(/** @type {any} */ (rec.content).html));
  const r = locate(text, h);
  assert.ok(r);
  assert.equal(text.slice(r.start, r.end), 'an important sentence');
  const link = buildImportRecord(b);
  assert.equal(link.item.content, 'link');
  assert.equal(link.content, null);
  assert.equal(link.item.status, 'archived');
});

test('browser bookmark tree → rows and folders', () => {
  const tree = [
    {
      id: '0', title: '', children: [
        { id: '1', title: 'Bookmarks bar', children: [
          { id: '10', title: 'Read', children: [
            { id: '11', title: 'A', url: 'https://a.example/', dateAdded: 1650000000000 },
            { id: '12', title: 'Deep', children: [{ id: '13', title: 'B', url: 'https://b.example/' }] },
            { id: '14', title: 'JS', url: 'javascript:void(0)' },
          ] },
        ] },
      ],
    },
  ];
  assert.deepEqual(bookmarkFolders(tree), [
    { id: '1', title: 'Bookmarks bar', depth: 0, count: 3 },
    { id: '10', title: 'Read', depth: 1, count: 3 },
    { id: '12', title: 'Deep', depth: 2, count: 1 },
  ]);
  const sub = [tree[0].children[0].children[0]];
  const rows = bookmarksToRows(sub, { folderTags: true });
  assert.deepEqual(rows.map((r) => [r.url, r.tags]), [['https://a.example/', []], ['https://b.example/', ['deep']]]);
  assert.equal(rows[0].addedAt, 1650000000000);
});

test('detectFormat', () => {
  assert.equal(detectFormat('x.zip', new Uint8Array([0x50, 0x4b, 3, 4])), 'zip');
  assert.equal(detectFormat('backup', enc.encode(' {"format":1}')), 'json');
  assert.equal(detectFormat('ril_export.html', enc.encode('<!DOCTYPE html>')), 'html');
  assert.equal(detectFormat('export', enc.encode('<!DOCTYPE NETSCAPE-Bookmark-file-1>')), 'html');
  assert.equal(detectFormat('part_000000.csv', enc.encode('title,url')), 'csv');
  assert.equal(detectFormat('list', enc.encode('title,url,time_added')), 'csv');
  assert.equal(detectFormat('links.txt', enc.encode('https://a.b')), 'text');
});

test('planImport: duplicates in the library and inside the file', () => {
  const existing = [{ ...makeItem({ url: 'https://a.example/1', tags: ['x'] }) }, { ...makeItem({ url: 'https://a.example/trashed' }), deletedAt: 5 }];
  const plan = planImport(existing, [
    { url: 'https://www.a.example/1/?utm_source=rss', tags: ['new'], source: 'urls' },
    { url: 'https://a.example/1', tags: ['x'], source: 'urls' },
    { url: 'https://a.example/2', tags: ['a'], source: 'urls' },
    { url: 'https://a.example/2#frag', tags: ['b'], source: 'urls' },
    { url: 'https://a.example/trashed', source: 'urls' },
  ]);
  assert.equal(plan.creates.length, 2);
  assert.deepEqual(plan.creates[0].tags, ['a', 'b']);
  assert.equal(plan.creates[1].url, 'https://a.example/trashed');
  assert.equal(plan.updates.length, 1, 'only the row that brings a new tag');
  assert.equal(plan.duplicates, 3);
});

test('JSON backup round trip is lossless', () => {
  const it = makeItem({ url: 'https://a.example/p', title: 'P', tags: ['t'], favorite: true, status: 'archived', progress: 0.3, words: 1200, content: 'full', highlights: 1 });
  const link = makeItem({ url: 'https://a.example/q', title: 'Q' });
  const contents = new Map([[it.id, { id: it.id, html: '<p>Hello world</p>', text: 'Hello world' }]]);
  const h = { id: 'h1', itemId: it.id, exact: 'world', prefix: 'Hello ', suffix: '', start: 6, color: 'green', note: 'n', createdAt: 1, updatedAt: 2 };
  const backup = makeBackup({ items: [it, link], contents, highlights: [h], settings: { theme: 'sepia' }, images: [{ itemId: it.id, url: 'https://a.example/i.png', type: 'image/png', data: 'AAAA' }], now: new Date(0) });
  assert.equal(backup.format, BACKUP_FORMAT);
  const back = readBackup(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(back.items[0], it);
  assert.deepEqual(back.items[1], link);
  assert.deepEqual(back.contents, [{ id: it.id, html: '<p>Hello world</p>', text: 'Hello world' }]);
  assert.deepEqual(back.highlights, [h]);
  assert.equal(back.images.length, 1);
  assert.deepEqual(back.settings, { theme: 'sepia' });
  assert.throws(() => readBackup({ format: 'other', items: [] }), /not a backup/);
  assert.throws(() => readBackup({ format: BACKUP_FORMAT, version: 99, items: [] }), /newer/);
});

test('readBackup repairs damaged records', () => {
  const back = readBackup({ format: BACKUP_FORMAT, version: 1, items: [null, { url: 'https://a.example/x', content: 'full', status: 'bogus', tags: 'a, b', highlightList: [{ exact: '' }, { exact: 'q' }] }, { title: 'no url' }] });
  assert.equal(back.items.length, 1);
  assert.equal(back.items[0].content, 'link', 'no text in the file → link');
  assert.equal(back.items[0].status, 'unread');
  assert.deepEqual(back.items[0].tags, ['a', 'b']);
  assert.equal(back.highlights.length, 1);
});

test('bookmarks HTML export re-imports cleanly', () => {
  const items = [makeItem({ url: 'https://a.example/1?x=<1>', title: 'One & "two"', tags: ['t1', 't2'], addedAt: 1700000000000 }), makeItem({ url: 'https://a.example/2', title: 'Two', status: 'archived' }), { ...makeItem({ url: 'https://a.example/3' }), deletedAt: 1 }];
  const html = bookmarksHtml(items, { title: 'Read later', unread: 'Unread', archive: 'Archive' });
  const rows = parseBookmarkHtml(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'One & "two"');
  assert.equal(rows[0].url, 'https://a.example/1?x=<1>');
  assert.deepEqual(rows[0].tags, ['t1', 't2']);
  assert.equal(rows[0].addedAt, 1700000000000);
  assert.equal(rows[1].status, 'archived');
});

test('Markdown export: front matter, body, highlights, safe unique file names', () => {
  const a = makeItem({ url: 'https://a.example/1', title: 'Same: title?', tags: ['x y'], byline: 'Ann', publishedAt: '2024-01-02', addedAt: 1700000000000 });
  const b = makeItem({ url: 'https://a.example/2', title: 'Same: title?', status: 'archived' });
  const contents = new Map([[a.id, { id: a.id, html: '<h2>Sub</h2><p>Body <em>text</em></p>', text: 'Sub\n\nBody text' }]]);
  const hs = [{ id: 'h', itemId: a.id, exact: 'Body', prefix: '', suffix: '', start: 3, color: 'yellow', note: 'note', createdAt: 1, updatedAt: 1 }];
  const files = markdownFiles([a, b], contents, hs, { highlights: 'Highlights', savedAsLink: 'Link only', index: 'Library' });
  assert.deepEqual(files.map((f) => f.name), ['index.md', 'unread/Same title.md', 'archive/Same title (2).md']);
  const md = files[1].data;
  assert.match(md, /^---\ntitle: "Same: title\?"\nurl: "https:\/\/a.example\/1"\nauthor: "Ann"\nsite: "a.example"\npublished: 2024-01-02\nsaved: 2023-11-14T22:13:20.000Z\nstatus: unread\ntags: \["x y"\]\n---/);
  assert.match(md, /## Sub\n\nBody _text_/);
  assert.match(md, /## Highlights\n\n> Body\n\nnote\n$/);
  assert.match(files[2].data, /_Link only_ <https:\/\/a.example\/2>/);
  assert.match(files[0].data, /- \[Same: title\?\]\(unread\/Same%20title.md\) — #x-y/);
  const zip = readZip(createZip(files));
  assert.equal(zip.length, 3);
  assert.equal(fileName('con', new Set()), 'article.md');
  assert.equal(articleMarkdown(b, undefined, [], { highlights: 'H', savedAsLink: 'L' }).includes('status: archived'), true);
});
