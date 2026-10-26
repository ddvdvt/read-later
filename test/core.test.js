import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, isSavableUrl, extractUrls, titleFromUrl, originPattern, stripTracking, displayHost } from '../extension/lib/url.js';
import { buildArticle, countWords, readingMinutes, makeExcerpt, isoDate, clean, cleanTitle } from '../extension/lib/article.js';
import { makeItem, normalizeTags, validTime, mergeCapture, applyAction, expiredTrash, trashDaysLeft, filterItems, sortItems, tagCounts, viewCounts, newId } from '../extension/lib/model.js';
import { ensureSettings, DEFAULTS, needsBackupReminder, formatBytes, plural, quotaLevel, detectCharset } from '../extension/lib/settings.js';

const DAY = 86400000;

test('normalizeUrl: tracking params, www, fragments, trailing slash, protocol', () => {
  assert.equal(normalizeUrl('https://www.Example.com/post/?utm_source=x&b=2&a=1#top'), 'example.com/post?a=1&b=2');
  assert.equal(normalizeUrl('http://example.com/post'), normalizeUrl('https://example.com/post/'));
  assert.equal(normalizeUrl('https://example.com/'), 'example.com');
  assert.equal(normalizeUrl('https://example.com:443/a/index.html'), 'example.com/a');
  assert.equal(normalizeUrl('https://example.com:8080/a?fbclid=1'), 'example.com:8080/a');
  assert.notEqual(normalizeUrl('https://example.com/a?id=1'), normalizeUrl('https://example.com/a?id=2'));
});

test('isSavableUrl', () => {
  assert.ok(isSavableUrl('https://habr.com/ru/articles/1/'));
  assert.ok(isSavableUrl('http://127.0.0.1:8080/x'));
  for (const u of ['chrome://extensions', 'file:///C:/a.html', 'about:blank', 'javascript:alert(1)', 'https://chromewebstore.google.com/detail/x', 'not a url']) assert.ok(!isSavableUrl(u), u);
});

test('extractUrls: finds URLs in text, strips punctuation, dedupes', () => {
  const text = 'Read https://a.com/x, and (https://b.org/y). Also https://en.wikipedia.org/wiki/Foo_(bar) and https://a.com/x#frag!\nhttp://c.net/z?utm_source=t';
  assert.deepEqual(extractUrls(text), ['https://a.com/x', 'https://b.org/y', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'http://c.net/z?utm_source=t']);
});

test('url helpers', () => {
  assert.equal(titleFromUrl('https://www.site.ru/blog/how-to-read-more.html'), 'site.ru — how to read more');
  assert.equal(titleFromUrl('https://site.ru/123'), 'site.ru');
  assert.equal(originPattern('https://sub.site.ru:8443/a?b'), 'https://sub.site.ru/*');
  assert.equal(originPattern('ftp://x'), null);
  assert.equal(stripTracking('https://a.com/x?utm_medium=y&id=3'), 'https://a.com/x?id=3');
  assert.equal(displayHost('https://www.a.com/x'), 'a.com');
});

test('countWords / readingMinutes / excerpt / isoDate / clean', () => {
  assert.equal(countWords('Привет, мир! Hello world — it’s 2024.'), 6);
  assert.equal(countWords(''), 0);
  assert.equal(readingMinutes(0), 0);
  assert.equal(readingMinutes(50), 1);
  assert.equal(readingMinutes(1000, 200), 5);
  assert.equal(makeExcerpt('short text'), 'short text');
  const ex = makeExcerpt('word '.repeat(100), 50);
  assert.ok(ex.length <= 51 && ex.endsWith('…'));
  assert.equal(isoDate('2024-03-05T10:00:00Z'), '2024-03-05');
  assert.equal(isoDate('March 5, 2024'), '2024-03-05');
  assert.equal(isoDate('nonsense'), '');
  assert.equal(clean('  a \n\t b  '), 'a b');
});

test('buildArticle: sanitizes content and fills metadata', () => {
  const b = buildArticle({
    url: 'https://blog.example/post',
    title: '  My   post ',
    siteName: '',
    byline: 'Ann',
    publishedTime: '2023-01-02T00:00:00Z',
    lang: 'ru',
    leadImage: '/lead.jpg',
    content: '<div><p>' + 'слово '.repeat(400) + '</p><script>x</script><img src="/a.png"></div>',
  });
  assert.equal(b.title, 'My post');
  assert.equal(b.site, 'blog.example');
  assert.equal(b.publishedAt, '2023-01-02');
  assert.equal(b.leadImage, 'https://blog.example/lead.jpg');
  assert.equal(b.words, 400);
  assert.ok(!b.html.includes('script'));
  assert.deepEqual(b.images, ['https://blog.example/a.png']);
  assert.ok(b.excerpt.startsWith('слово слово'));
});

test('buildArticle: empty content → link only, title from URL', () => {
  const b = buildArticle({ url: 'https://x.org/some-page', content: '<p> </p>' });
  assert.equal(b.html, '');
  assert.equal(b.words, 0);
  assert.equal(b.title, 'x.org — some page');
});

test('normalizeTags / validTime / newId', () => {
  assert.deepEqual(normalizeTags('Work, #read; work |Long Read'), ['work', 'read', 'long read']);
  assert.deepEqual(normalizeTags(['_untagged_', '']), []);
  assert.equal(validTime(1600000000), 1600000000000);
  assert.equal(validTime('1600000000'), 1600000000000);
  assert.equal(validTime('2024-01-01T00:00:00Z'), Date.UTC(2024, 0, 1));
  assert.equal(validTime('x'), 0);
  assert.equal(validTime(5), 0);
  const a = newId(1000);
  assert.match(a, /^[0-9a-z]{17}$/);
  assert.notEqual(newId(), newId());
});

test('makeItem fills defaults and validates', () => {
  const it = makeItem({ url: 'https://www.a.com/p?utm_source=x', status: /** @type {any} */ ('weird'), tags: ['A', 'a'], progress: 7 }, 1700000000000);
  assert.equal(it.status, 'unread');
  assert.equal(it.normUrl, 'a.com/p');
  assert.deepEqual(it.tags, ['a']);
  assert.equal(it.progress, 1);
  assert.equal(it.content, 'link');
  assert.equal(it.addedAt, 1700000000000);
  assert.equal(it.site, 'a.com');
  const ar = makeItem({ url: 'https://a.com', status: 'archived', addedAt: 1600000000 });
  assert.equal(ar.archivedAt, 1600000000000);
});

test('mergeCapture keeps user state, refreshes text and restores from trash', () => {
  const old = { ...makeItem({ url: 'https://a.com/p', title: 'Old', tags: ['x'], favorite: true, status: 'archived', progress: 0.5 }), deletedAt: 5 };
  const m = mergeCapture(old, { title: 'New', words: 900, content: 'full', tags: ['y'] }, 123);
  assert.equal(m.title, 'New');
  assert.equal(m.words, 900);
  assert.equal(m.content, 'full');
  assert.deepEqual(m.tags, ['x', 'y']);
  assert.equal(m.favorite, true);
  assert.equal(m.status, 'archived');
  assert.equal(m.progress, 0.5);
  assert.equal(m.deletedAt, null);
  const keep = mergeCapture({ ...m, words: 900 }, { words: 0, content: 'link' }, 124);
  assert.equal(keep.content, 'full');
  assert.equal(keep.words, 900);
});

test('applyAction / trash retention', () => {
  const it = makeItem({ url: 'https://a.com' });
  assert.equal(applyAction(it, 'archive', 10).status, 'archived');
  assert.equal(applyAction(applyAction(it, 'archive', 10), 'unarchive', 11).archivedAt, null);
  assert.equal(applyAction(it, 'favorite').favorite, true);
  const t = applyAction(it, 'trash', 1000);
  assert.equal(t.deletedAt, 1000);
  assert.equal(applyAction(t, 'restore').deletedAt, null);
  assert.deepEqual(expiredTrash([t], 1000 + 29 * DAY), []);
  assert.equal(expiredTrash([t], 1000 + 30 * DAY).length, 1);
  assert.equal(trashDaysLeft(t, 1000 + 10.5 * DAY), 20);
});

test('filterItems / sortItems / counts', () => {
  const mk = (o) => makeItem({ url: `https://a.com/${o.title}`, ...o });
  const items = [
    mk({ title: 'b', addedAt: 3000000000000, words: 100, tags: ['x'] }),
    mk({ title: 'a', addedAt: 2000000000000, words: 3000, favorite: true, status: 'archived' }),
    mk({ title: 'c', addedAt: 2500000000000, words: 0, highlights: 2 }),
    { ...mk({ title: 'd', addedAt: 1000000000000 }), deletedAt: 5 },
  ];
  assert.deepEqual(filterItems(items, { view: 'unread' }).map((i) => i.title), ['b', 'c']);
  assert.deepEqual(filterItems(items, { view: 'archive' }).map((i) => i.title), ['a']);
  assert.deepEqual(filterItems(items, { view: 'favorites' }).map((i) => i.title), ['a']);
  assert.deepEqual(filterItems(items, { view: 'highlights' }).map((i) => i.title), ['c']);
  assert.deepEqual(filterItems(items, { view: 'trash' }).map((i) => i.title), ['d']);
  assert.deepEqual(filterItems(items, { view: 'all', tag: 'x' }).map((i) => i.title), ['b']);
  assert.deepEqual(filterItems(items, { view: 'all', tag: '\u0000untagged', sort: 'title' }).map((i) => i.title), ['a', 'c']);
  assert.deepEqual(filterItems(items, { view: 'all', ids: new Set([items[2].id]) }).map((i) => i.title), ['c']);
  assert.deepEqual(filterItems(items, { view: 'all', content: 'link' }).length, 3);
  assert.deepEqual(sortItems(items.slice(0, 3), 'oldest').map((i) => i.title), ['a', 'c', 'b']);
  assert.deepEqual(sortItems(items.slice(0, 3), 'shortest').map((i) => i.title), ['b', 'a', 'c']);
  assert.deepEqual(sortItems(items.slice(0, 3), 'longest').map((i) => i.title), ['a', 'b', 'c']);
  assert.deepEqual(sortItems([mk({ title: 'Ёж' }), mk({ title: 'ель' }), mk({ title: 'Ангел' })], 'title').map((i) => i.title), ['Ангел', 'Ёж', 'ель']);
  assert.deepEqual(tagCounts(items), [['x', 1]]);
  assert.deepEqual(viewCounts(items), { unread: 2, favorites: 1, archive: 1, all: 3, trash: 1, highlights: 1, links: 3 });
});

test('settings: defaults and validation', () => {
  assert.deepEqual(ensureSettings(null), DEFAULTS);
  const s = ensureSettings({ font: 'comic', fontSize: 99, lineHeight: 1.234, theme: 'sepia', imageCapMb: 3, backupDays: 30, saveImages: false, wpm: 'x' });
  assert.equal(s.font, 'serif');
  assert.equal(s.fontSize, 28);
  assert.equal(s.lineHeight, 1.3);
  assert.equal(s.theme, 'sepia');
  assert.equal(s.imageCapMb, 5);
  assert.equal(s.backupDays, 30);
  assert.equal(s.saveImages, false);
  assert.equal(s.wpm, 200);
});

test('backup reminder', () => {
  const now = 100 * DAY;
  assert.equal(needsBackupReminder({ lastBackupAt: null, firstChangeAt: null, lastChangeAt: null }, 14, now), false);
  assert.equal(needsBackupReminder({ lastBackupAt: null, firstChangeAt: now - 15 * DAY, lastChangeAt: now - DAY }, 14, now), true);
  assert.equal(needsBackupReminder({ lastBackupAt: null, firstChangeAt: now - 3 * DAY, lastChangeAt: now - DAY }, 14, now), false);
  assert.equal(needsBackupReminder({ lastBackupAt: now - 20 * DAY, firstChangeAt: 1, lastChangeAt: now - 25 * DAY }, 14, now), false, 'nothing changed since the backup');
  assert.equal(needsBackupReminder({ lastBackupAt: now - 20 * DAY, firstChangeAt: 1, lastChangeAt: now - DAY }, 14, now), true);
  assert.equal(needsBackupReminder({ lastBackupAt: now - 20 * DAY, firstChangeAt: 1, lastChangeAt: now - DAY, snoozedUntil: now + 1 }, 14, now), false);
  assert.equal(needsBackupReminder({ lastBackupAt: null, firstChangeAt: 1, lastChangeAt: 2 }, 0, now), false);
});

test('formatting helpers', () => {
  assert.equal(formatBytes(0, 'en'), '0 B');
  assert.equal(formatBytes(1536, 'en'), '1.5 KB');
  assert.equal(formatBytes(50 * 1024 * 1024, 'ru'), '50 МБ');
  assert.equal(plural(1, '# статья|# статьи|# статей'), '1 статья');
  assert.equal(plural(3, '# статья|# статьи|# статей'), '3 статьи');
  assert.equal(plural(11, '# статья|# статьи|# статей'), '11 статей');
  assert.equal(plural(21, '# статья|# статьи|# статей'), '21 статья');
  assert.equal(plural(2, '# article|# articles', 'en'), '2 articles');
  assert.equal(quotaLevel({ usage: 85, quota: 100 }), 'warn');
  assert.equal(quotaLevel({ usage: 99, quota: 100 }), 'critical');
  assert.equal(quotaLevel({}), 'ok');
  assert.equal(detectCharset('text/html; charset=windows-1251', ''), 'windows-1251');
  assert.equal(detectCharset('text/html', '<meta charset="koi8-r">'), 'koi8-r');
  assert.equal(detectCharset(null, '<meta http-equiv="Content-Type" content="text/html; charset=bogus-x">'), 'utf-8');
});

test('cleanTitle drops the site name', () => {
  assert.equal(cleanTitle('Как читать — Блог о чтении', 'Блог о чтении'), 'Как читать');
  assert.equal(cleanTitle('Field Notes | Why offline', 'Field Notes'), 'Why offline');
  assert.equal(cleanTitle('Why offline reading matters | Field Notes', '', 'Why offline reading matters'), 'Why offline reading matters');
  assert.equal(cleanTitle('A - B - C', 'nope'), 'A - B - C');
  assert.equal(cleanTitle('Short', '', 'Sh'), 'Short');
});
