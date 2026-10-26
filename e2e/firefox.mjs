// E2E in real Firefox: the Firefox build (scripts/firefox.mjs) as a temporary add-on in a fresh
// profile, LOCAL fixture pages only (127.0.0.1). Same flows as e2e/smoke.mjs: save a page from the
// popup → read it offline with saved images → highlight + note → reading position → typography →
// library search / archive / trash / undo → import a Pocket export → load text for imported links →
// save several tabs → export JSON and Markdown → restore.
//
// Automation limits and how they are handled:
// - activeTab cannot be granted programmatically: the test copy's manifest declares
//   http://127.0.0.1/* as a host permission (test-only change; the real manifest has none);
// - "load text" / "save several tabs" ask for the optional host permission at that moment: the
//   pref extensions.webextOptionalPermissionPrompts=false makes Firefox grant it without its prompt,
//   so the real request → work → release flow runs;
// - the popup is opened as a tab (popup.html?tabId=…); file inputs and downloads of extension pages
//   are driven through the page (DataTransfer) and the downloads folder of the temporary profile.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readZip } from '../extension/lib/zip.js';
import { writeUnpacked, SLUG } from '../scripts/firefox.mjs';
import { startFirefox } from './firefox-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'e2e', 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const server = createServer(async (req, res) => {
  try {
    const path = (req.url || '/').split('?')[0];
    if (path.includes('..')) throw new Error('bad path');
    if (path.startsWith('/brand/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>brand ${path}</title>`);
      return;
    }
    if (path === '/img/cover.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(await readFile(join(FIXTURES, 'cover.png')));
      return;
    }
    const name = path.replace(/^\/+/, '') || 'article.html';
    const body = await readFile(join(FIXTURES, name));
    res.writeHead(200, { 'content-type': name === 'cp1251.html' ? 'text/html' : 'text/html; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = /** @type {any} */ (server.address()).port;
const origin = `http://127.0.0.1:${port}`;

const work = await mkdtemp(join(tmpdir(), `${SLUG}-ff-e2e-`));
const extDir = writeUnpacked(join(work, 'extension'));
const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const brandBase = `${origin}/brand/`;
const brandFile = join(extDir, 'lib', 'brand.js');
const brandSrc = await readFile(brandFile, 'utf8');
const patched = brandSrc.replace(/export const BASE = '[^']*';/, `export const BASE = '${brandBase}';`);
assert.notEqual(patched, brandSrc, 'BASE constant found in lib/brand.js');
await writeFile(brandFile, patched);

const ff = await startFirefox({
  extDir,
  addonId: manifest.browser_specific_settings.gecko.id,
  prefs: { 'extensions.webextOptionalPermissionPrompts': false },
});

/** Helpers over puppeteer pages (extension pages are polled: their load events are not reported over BiDi). */
const ws = (page, sel, timeout) => ff.waitFor(page, (s) => !!document.querySelector(s), sel, timeout);
const wf = (page, fn, arg, timeout) => ff.waitFor(page, fn, arg, timeout);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent);
const attr = (page, sel, name) => page.$eval(sel, (el, n) => el.getAttribute(n), name);
const visible = (page, sel) => page.$eval(sel, (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden').catch(() => false);
async function fill(page, sel, value) {
  await page.$eval(sel, (el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (value) await page.type(sel, value);
}
/** Give a file to <input type=file> of an extension page (input.setFiles is not available there over BiDi). */
async function setFile(page, sel, name, content) {
  await page.$eval(
    sel,
    (input, name, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    name,
    Buffer.from(content).toString('base64'),
  );
}
/** Click and wait for a new file in the profile's downloads folder; resolves to { name, path }. */
async function download(page, sel) {
  const before = new Set(await readdir(ff.downloads));
  await page.click(sel);
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const f = (await readdir(ff.downloads)).find((x) => !before.has(x) && !x.endsWith('.part'));
    if (f) {
      await sleep(300); // let Firefox finish writing it
      return { name: f, path: join(ff.downloads, f) };
    }
    await sleep(100);
  }
  throw new Error(`no download after clicking ${sel}`);
}

let exitCode = 0;
try {
  await step('background starts; fresh install opens the welcome page of the brand site', async () => {
    const found = await ff.findPage((u) => u === `${brandBase}welcome/read-later.html`, 15000);
    assert.ok(found, 'welcome tab opened');
    await found.close();
  });

  const article = await ff.open(`${origin}/article.html`);
  const helper = await ff.open('src/options/options.html');
  await ws(helper, 'body[data-ready="1"]');
  const tabIdOf = (url) => helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  /** Call a function of src/shared/db.js inside an extension page. */
  const db = (method, ...args) => helper.evaluate(async (m, a) => (await import('/src/shared/db.js'))[m](...a), method, args);

  const popup = await ff.browser.newPage();
  let articleId = '';
  await step('popup saves the current page (Readability text, images saved offline)', async () => {
    const tabId = await tabIdOf(`${origin}/article.html`);
    assert.ok(tabId);
    await popup.setViewport({ width: 380, height: 600 });
    await ff.navigate(popup, `${ff.base}src/popup/popup.html?tabId=${tabId}`);
    await ws(popup, 'body[data-ready="1"]');
    assert.match(await text(popup, '#pageTitle'), /Как вернуть привычку/);
    assert.equal(await popup.$eval('#saveBtn', (b) => b.disabled), false);
    await popup.click('#saveBtn');
    await ws(popup, '#status.ok:not([hidden])');
    await wf(popup, () => /Сохранено/.test(document.querySelector('#status')?.textContent || ''));
    assert.equal(await visible(popup, '#savedActions'), true);
    await ws(popup, '#recent li');
    assert.match(await text(popup, '#recent'), /Как вернуть привычку читать длинные статьи/);
    const items = await db('getAllItems');
    assert.equal(items.length, 1);
    const it = items[0];
    articleId = it.id;
    assert.equal(it.title, 'Как вернуть привычку читать длинные статьи');
    assert.equal(it.content, 'full');
    assert.equal(it.site, 'Блог о чтении');
    assert.equal(it.publishedAt, '2026-09-14');
    assert.ok(it.words > 150 && it.words < 400, `words ${it.words}`);
    assert.ok(it.imageBytes > 0, 'cover image saved');
    const c = await db('getContent', articleId);
    assert.match(c.text, /Что помогает дочитывать/);
    assert.ok(!/Популярное|cookie|Подписка|Конфиденциальность/.test(c.text), `page chrome removed: ${c.text}`);
    assert.ok(!/<script|onclick|style=/i.test(c.html));
    assert.equal(await article.evaluate(() => document.querySelectorAll('[id^="read-later"]').length <= 1), true, 'host page intact');
  });

  await step('saving the same page again updates it instead of duplicating', async () => {
    await ff.navigate(popup, await popup.evaluate(() => location.href));
    await ws(popup, 'body[data-ready="1"]');
    assert.match(await text(popup, '#status'), /уже в списке/i);
    await popup.click('#saveBtn');
    await wf(popup, () => /обновл/i.test(document.querySelector('#status')?.textContent || ''));
    assert.equal((await db('getAllItems')).length, 1);
  });

  const reader = await ff.browser.newPage();
  await reader.setViewport({ width: 1100, height: 800 });
  const openReader = async () => {
    await ff.navigate(reader, `${ff.base}src/reader/reader.html?id=${articleId}`);
    await ws(reader, 'body[data-ready="1"]');
  };
  await step('reader shows the clean article with the offline image', async () => {
    await openReader();
    assert.equal(await text(reader, '#aTitle'), 'Как вернуть привычку читать длинные статьи');
    assert.match(await text(reader, '#aMeta'), /Блог о чтении/);
    assert.match(await text(reader, '#aByline'), /Мария Соколова/);
    assert.ok((await reader.$$('#content p')).length >= 6);
    assert.match(await attr(reader, '#content img', 'src'), /^blob:moz-extension:/);
    assert.ok(await reader.$eval('#content img', (i) => i.complete && i.naturalWidth > 0), 'offline image decoded');
    assert.equal(await attr(reader, '#origBtn', 'href'), `${origin}/article.html`);
    assert.equal(await reader.$$eval('#content a', (as) => as.every((a) => a.target === '_blank' && a.rel.includes('noopener'))), true);
  });

  await step('highlight with a note survives a reload', async () => {
    await reader.evaluate(() => {
      const p = [...document.querySelectorAll('#content p')].find((x) => x.textContent.includes('Второй фактор'));
      const node = /** @type {Text} */ (p.firstChild);
      const start = node.data.indexOf('Статья, которая открывается без интернета');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 'Статья, которая открывается без интернета'.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await ws(reader, '#hlPop:not([hidden])');
    await reader.click('#hlPop .dot[data-color="green"]');
    await ws(reader, 'mark.hl[data-color="green"]');
    assert.equal(await reader.$$eval('mark.hl', (ms) => ms.map((m) => m.textContent).join('')), 'Статья, которая открывается без интернета');
    await reader.click('mark.hl');
    await ws(reader, '#hlPop:not([hidden]) #popNote');
    await reader.click('#popNote');
    await fill(reader, '#noteText', 'Главная мысль про офлайн');
    await reader.click('#noteForm button[type="submit"]');
    await ws(reader, 'mark.hl.has-note');
    await openReader();
    await ws(reader, 'mark.hl[data-color="green"].has-note');
    assert.equal(await attr(reader, 'mark.hl', 'title'), 'Главная мысль про офлайн');
    await reader.click('#hlListBtn');
    assert.match(await text(reader, '#hlList'), /Главная мысль про офлайн/);
    assert.equal((await db('getItem', articleId)).highlights, 1);
  });

  await step('typography settings apply and persist; reading position is restored', async () => {
    await ff.front(reader);
    await reader.click('#typeBtn');
    await reader.click('#themeSeg button[data-theme-btn="sepia"]');
    await reader.click('#sizeUp');
    assert.equal(await attr(reader, 'html', 'data-theme'), 'sepia');
    await reader.keyboard.press('Escape');
    await ff.resize(reader, 900, 400);
    await sleep(700); // scroll events right after opening are ignored while the position is restored
    const target = await reader.evaluate(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      scrollTo(0, max * 0.5);
      dispatchEvent(new Event('scroll'));
      return max * 0.5;
    });
    assert.ok(target > 100);
    let it;
    for (let i = 0; i < 40; i++) {
      it = await db('getItem', articleId);
      if (it.progress > 0) break;
      await sleep(250);
    }
    assert.ok(it.progress > 0.4 && it.progress < 0.6, `progress ${it.progress}`);
    await openReader();
    await sleep(300);
    const y = await reader.evaluate(() => scrollY / (document.documentElement.scrollHeight - innerHeight));
    assert.ok(y > 0.4 && y < 0.6, `restored ${y}`);
    assert.equal(await attr(reader, 'html', 'data-theme'), 'sepia');
    const s = await helper.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.equal(s.theme, 'sepia');
    assert.equal(s.fontSize, 20);
  });

  const library = await ff.browser.newPage();
  await library.setViewport({ width: 1100, height: 800 });
  const openLibrary = async (hash = '') => {
    await ff.navigate(library, `${ff.base}src/library/library.html${hash}`);
    await ws(library, 'body[data-ready="1"]');
  };
  await step('import a Pocket HTML export (tags, archive, duplicates)', async () => {
    const pocket = `<!DOCTYPE html><html><head><title>Pocket Export</title></head><body>
<h1>Unread</h1><ul>
<li><a href="${origin}/article2.html" time_added="1700000000" tags="english,offline">Why offline reading matters</a></li>
<li><a href="${origin}/cp1251.html" time_added="1700000100" tags="">Old encoding</a></li>
<li><a href="${origin}/article.html?utm_source=pocket" time_added="1700000200" tags="reading">dupe of the saved one</a></li>
</ul><h1>Read Archive</h1><ul>
<li><a href="${origin}/missing.html" time_added="1600000000" tags="old">Gone page</a></li>
</ul></body></html>`;
    await ff.navigate(helper, `${ff.base}src/options/options.html#import`);
    await ws(helper, 'body[data-ready="1"]');
    await setFile(helper, '#file', 'ril_export.html', pocket);
    await ws(helper, '#importGo');
    const prev = await text(helper, '#preview');
    assert.match(prev, /Pocket \(HTML\)/);
    assert.match(prev, /Найдено ссылок: 4/);
    assert.match(prev, /Новых для библиотеки: 3/);
    assert.match(prev, /Попадут в архив \(были прочитаны\): 1/);
    await helper.click('#importGo');
    await wf(helper, () => /Добавлено статей: 3/.test(document.querySelector('#preview')?.textContent || ''));
    const items = await db('getAllItems');
    assert.equal(items.length, 4);
    assert.deepEqual(items.find((i) => i.id === articleId).tags, ['reading'], 'tag from the export merged into the existing item');
    assert.equal(items.find((i) => i.url.endsWith('missing.html')).status, 'archived');
  });

  await step('library: views, counts, link-only filter, load text for imported links (host access requested, then released)', async () => {
    await openLibrary('#view=all&content=link');
    assert.equal(await library.$$eval('#list .row', (r) => r.length), 3);
    assert.equal(await text(library, '#c-unread'), '3');
    assert.equal(await text(library, '#c-archive'), '1');
    await library.click('#selectAll');
    await ws(library, '#bulk:not([hidden])');
    await library.click('#bulkActions button::-p-text(Загрузить текст)');
    await wf(library, () => /Тексты загружены/.test(document.querySelector('.toast')?.textContent || ''), undefined, 30000);
    assert.match(await text(library, '.toast'), /Тексты загружены: 2, не удалось: 1/);
    const items = await db('getAllItems');
    const en = items.find((i) => i.url.endsWith('article2.html'));
    assert.equal(en.content, 'full');
    assert.equal(en.title, 'Why offline reading matters');
    assert.deepEqual(en.tags, ['english', 'offline']);
    const cp = items.find((i) => i.url.endsWith('cp1251.html'));
    assert.equal(cp.content, 'full');
    assert.match((await db('getContent', cp.id)).text, /Привычка читать длинные тексты/, 'windows-1251 decoded');
    assert.equal(items.find((i) => i.url.endsWith('missing.html')).content, 'failed');
    // the optional access is given back after the job (Firefox lets the extension remove it)
    const origins = await helper.evaluate(async () => (await chrome.permissions.getAll()).origins);
    assert.ok(!origins.includes('http://*/*') && !origins.includes('https://*/*'), `no broad access left: ${origins}`);
  });

  await step('library: full-text search, keyboard archive + undo, trash + restore', async () => {
    await openLibrary('#view=all');
    await fill(library, '#q', 'метро самолёт');
    // both articles mention the metro and the plane (the cp1251 one got its text in the previous step)
    await wf(library, () => [...document.querySelectorAll('#list .row .title')].map((x) => x.textContent).sort().join('|') === 'Заметки в старой кодировке|Как вернуть привычку читать длинные статьи');
    await fill(library, '#q', 'checklist');
    await wf(library, () => document.querySelector('#list .row .title')?.textContent === 'Why offline reading matters');
    await fill(library, '#q', '');
    await openLibrary();
    const before = await library.$$eval('#list .row', (r) => r.length);
    await ff.front(library);
    await library.keyboard.press('j');
    await library.keyboard.press('Escape');
    await library.keyboard.press('e');
    await wf(library, (n) => document.querySelectorAll('#list .row').length === n - 1, before);
    await library.click('.toast button');
    await wf(library, (n) => document.querySelectorAll('#list .row').length === n, before);
    const firstTitle = await text(library, '#list .row .title');
    await library.click('#list .row:first-child .acts button[aria-label="В корзину"]');
    await wf(library, (n) => document.querySelectorAll('#list .row').length === n - 1, before);
    await library.click('#views button[data-view="trash"]');
    await ws(library, '#list .row');
    assert.equal(await text(library, '#list .row .title'), firstTitle);
    assert.match(await text(library, '#list .row .meta'), /удалится через 30 дн/);
    await library.click('#list .row .acts button[aria-label="Восстановить"]');
    await ws(library, '#empty:not([hidden])');
  });

  await step('save several selected tabs (host access requested at that moment)', async () => {
    const t1 = await ff.open(`${origin}/article2.html?from=tabs`);
    const t2 = await ff.open(`${origin}/cp1251.html?from=tabs`);
    // the earlier job gave the host access back, so tab URLs are hidden again: find the tabs by activating them
    const activeId = async (p) => {
      await ff.front(p);
      return helper.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
    };
    const ids = [await activeId(t1), await activeId(t2)];
    assert.ok(ids.every(Boolean), `tab ids ${ids}`);
    await ff.navigate(library, `${ff.base}src/library/library.html?saveTabs=${ids.join(',')}`);
    await ws(library, '#saveTabsGo');
    await ff.front(library); // input goes to the foreground tab
    await library.click('#saveTabsGo');
    await wf(library, () => /Сохранено с текстом: 2/.test(document.querySelector('.toast')?.textContent || ''), undefined, 20000).catch(async (e) => {
      throw new Error(`${e.message}; toast: ${await library.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' / '))}; perms: ${JSON.stringify(await helper.evaluate(() => chrome.permissions.getAll()))}`);
    });
    const items = await db('getAllItems');
    assert.equal(items.filter((i) => i.url.includes('from=tabs')).length, 2);
    await t1.close();
    await t2.close();
  });

  await step('export: JSON backup is complete, Markdown ZIP has articles and highlights', async () => {
    await ff.navigate(helper, `${ff.base}src/options/options.html#export`);
    await ws(helper, 'body[data-ready="1"]');
    const dl = await download(helper, '#exJson');
    assert.match(dl.name, /^read-later-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const backup = JSON.parse(await readFile(dl.path, 'utf8'));
    assert.equal(backup.format, 'read-later-backup');
    assert.equal(backup.items.length, 6);
    const a = backup.items.find((i) => i.id === articleId);
    assert.match(a.html, /Что помогает дочитывать/);
    assert.equal(a.highlightList[0].note, 'Главная мысль про офлайн');
    const md = await download(helper, '#exMd');
    const files = readZip(new Uint8Array(await readFile(md.path)));
    const art = files.find((f) => f.name.startsWith('unread/Как вернуть'));
    assert.ok(art, files.map((f) => f.name).join(', '));
    const body = new TextDecoder().decode(art.data);
    assert.match(body, /^---\ntitle: "Как вернуть привычку читать длинные статьи"/);
    assert.match(body, /## Что помогает дочитывать/);
    assert.match(body, /> Статья, которая открывается без интернета\n\nГлавная мысль про офлайн/);
    const html = await download(helper, '#exHtml');
    assert.match(await readFile(html.path, 'utf8'), /<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
    assert.match(await text(helper, '#lastBackup'), /Последняя копия/);
  });

  await step('restore from the JSON backup after deleting everything', async () => {
    const dl = await download(helper, '#exJson');
    const backup = await readFile(dl.path);
    await db('clearAll');
    assert.equal((await db('getAllItems')).length, 0);
    await ff.navigate(helper, await helper.evaluate(() => location.href));
    await ws(helper, 'body[data-ready="1"]');
    await setFile(helper, '#file', 'backup.json', backup);
    await ws(helper, '#importGo');
    assert.match(await text(helper, '#preview'), /Нет в этой библиотеке: 6/);
    await helper.click('#importGo');
    await wf(helper, () => /Добавлено статей: 6/.test(document.querySelector('#preview')?.textContent || ''));
    assert.equal((await db('getAllHighlights')).length, 1);
    await openReader();
    await ws(reader, 'mark.hl.has-note');
    assert.match(await attr(reader, '#content img', 'src'), /^(blob:|http)/);
  });

  await step('options: "Change" shortcut opens the Firefox shortcut manager (about:addons)', async () => {
    await helper.click('#shortcutBtn');
    const addons = await ff.findPage((u) => u.startsWith('about:addons'), 5000);
    assert.ok(addons, 'about:addons opened');
    await addons.close();
  });

  await step('dark theme renders; no errors in the background, extension pages and content scripts', async () => {
    await ff.setColorScheme('dark');
    const dark = await ff.open('src/library/library.html#view=all');
    await ws(dark, 'body[data-ready="1"]');
    assert.equal(await dark.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(21, 19, 15)');
    await dark.close();
    await ff.setColorScheme('light');
    assert.deepEqual(await ff.errors(), []);
  });

  console.log(`\n${passed} e2e checks passed`);
} catch (e) {
  exitCode = 1;
  console.error('E2E FAILED:', e);
  console.error('collected errors:', await ff.errors().catch(() => []));
} finally {
  await ff.close();
  server.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
