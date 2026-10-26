// E2E smoke test: loads the unpacked extension into the locally installed Chromium and walks
// through the main flows on LOCAL fixture pages only (127.0.0.1):
// save a page from the popup → read it offline with saved images → highlight + note → reading
// position → typography → library search / archive / trash / undo → import a Pocket export →
// load text for imported links → save several tabs → export JSON and Markdown.
//
// activeTab cannot be granted programmatically, and Chrome's permission prompt cannot be clicked
// in automation, so the test runs a temporary COPY of the extension whose manifest additionally
// declares http(s)://*/* as host permissions (test-only change; the real manifest has none).
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readZip } from '../extension/lib/zip.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'e2e', 'fixtures');
const exe = process.env.CHROMIUM_PATH || join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
if (!existsSync(exe)) {
  console.error(`Chromium not found at ${exe}. Set CHROMIUM_PATH.`);
  process.exit(1);
}

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
    // cp1251.html is served without a charset header: the <meta charset> must be honoured
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

const work = await mkdtemp(join(tmpdir(), 'read-later-e2e-'));
const extDir = join(work, 'extension');
const profile = join(work, 'profile');
const downloads = join(work, 'downloads');
await cp(join(ROOT, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://*/*', 'https://*/*'];
await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const brandBase = `${origin}/brand/`;
const brandFile = join(extDir, 'lib', 'brand.js');
const brandSrc = await readFile(brandFile, 'utf8');
const patched = brandSrc.replace(/export const BASE = '[^']*';/, `export const BASE = '${brandBase}';`);
assert.notEqual(patched, brandSrc, 'BASE constant found in lib/brand.js');
await writeFile(brandFile, patched);

const context = await chromium.launchPersistentContext(profile, {
  executablePath: exe,
  headless: false,
  acceptDownloads: true,
  downloadsPath: downloads,
  locale: 'ru-RU',
  viewport: { width: 1100, height: 800 },
  args: [
    '--headless=new',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--renderer-process-limit=3',
    '--lang=ru',
  ],
});

/** console errors / uncaught exceptions of extension pages */
const errors = [];
function watch(page) {
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => {
    // the 404 of the deliberately missing fixture page (load-text step) is expected
    if (m.type() === 'error' && page.url().startsWith('chrome-extension://') && !/status of 404/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`);
  });
  return page;
}

let exitCode = 0;
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const ext = (p) => `chrome-extension://${extId}/${p}`;

  await step('service worker starts; fresh install opens the welcome page of the brand site', async () => {
    const welcome = `${brandBase}welcome/read-later.html`;
    let found = null;
    for (let i = 0; i < 50 && !found; i++) {
      found = context.pages().find((p) => p.url() === welcome);
      if (!found) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(found, 'welcome tab opened');
    await found.close();
  });

  const article = await context.newPage();
  await article.goto(`${origin}/article.html`);
  const helper = watch(await context.newPage());
  await helper.goto(ext('src/options/options.html'));
  const tabIdOf = (url) => helper.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url);
  /** Call a function of src/shared/db.js inside an extension page. */
  const db = (method, ...args) => helper.evaluate(async ([m, a]) => (await import('/src/shared/db.js'))[m](...a), [method, args]);

  const popup = watch(await context.newPage());
  let articleId = '';
  await step('popup saves the current page (Readability text, images saved offline)', async () => {
    const tabId = await tabIdOf(`${origin}/article.html`);
    assert.ok(tabId);
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.goto(ext(`src/popup/popup.html?tabId=${tabId}`));
    await popup.waitForSelector('body[data-ready="1"]');
    assert.match(await popup.textContent('#pageTitle'), /Как вернуть привычку/);
    assert.equal(await popup.isDisabled('#saveBtn'), false);
    await popup.click('#saveBtn');
    await popup.waitForSelector('#status.ok:not([hidden])');
    await popup.waitForFunction(() => /Сохранено/.test(document.querySelector('#status')?.textContent || ''));
    assert.equal(await popup.isVisible('#savedActions'), true);
    await popup.waitForSelector('#recent li');
    assert.match(await popup.textContent('#recent'), /Как вернуть привычку читать длинные статьи/);
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
    await popup.reload();
    await popup.waitForSelector('body[data-ready="1"]');
    assert.match(await popup.textContent('#status'), /уже в списке/i);
    await popup.click('#saveBtn');
    await popup.waitForFunction(() => /обновл/i.test(document.querySelector('#status')?.textContent || ''));
    assert.equal((await db('getAllItems')).length, 1);
  });

  const reader = watch(await context.newPage());
  await step('reader shows the clean article with the offline image', async () => {
    await reader.goto(ext(`src/reader/reader.html?id=${articleId}`));
    await reader.waitForSelector('body[data-ready="1"]');
    assert.equal(await reader.textContent('#aTitle'), 'Как вернуть привычку читать длинные статьи');
    assert.match(await reader.textContent('#aMeta'), /Блог о чтении/);
    assert.match(await reader.textContent('#aByline'), /Мария Соколова/);
    assert.ok((await reader.$$('#content p')).length >= 6);
    assert.match(await reader.getAttribute('#content img', 'src'), /^blob:chrome-extension:/);
    assert.equal(await reader.getAttribute('#origBtn', 'href'), `${origin}/article.html`);
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
    await reader.waitForSelector('#hlPop:not([hidden])');
    await reader.click('#hlPop .dot[data-color="green"]');
    await reader.waitForSelector('mark.hl[data-color="green"]');
    assert.equal(await reader.$$eval('mark.hl', (ms) => ms.map((m) => m.textContent).join('')), 'Статья, которая открывается без интернета');
    await reader.click('mark.hl');
    await reader.waitForSelector('#hlPop:not([hidden]) #popNote');
    await reader.click('#popNote');
    await reader.fill('#noteText', 'Главная мысль про офлайн');
    await reader.click('#noteForm button[type="submit"]');
    await reader.waitForSelector('mark.hl.has-note');
    await reader.reload();
    await reader.waitForSelector('body[data-ready="1"]');
    await reader.waitForSelector('mark.hl[data-color="green"].has-note');
    assert.equal(await reader.getAttribute('mark.hl', 'title'), 'Главная мысль про офлайн');
    await reader.click('#hlListBtn');
    assert.match(await reader.textContent('#hlList'), /Главная мысль про офлайн/);
    const it = await db('getItem', articleId);
    assert.equal(it.highlights, 1);
  });

  await step('typography settings apply and persist; reading position is restored', async () => {
    await reader.bringToFront();
    await reader.click('#typeBtn');
    await reader.click('#themeSeg button[data-theme-btn="sepia"]');
    await reader.click('#sizeUp');
    assert.equal(await reader.getAttribute('html', 'data-theme'), 'sepia');
    await reader.keyboard.press('Escape');
    await reader.setViewportSize({ width: 900, height: 400 });
    await reader.waitForTimeout(700); // scroll events right after opening are ignored while the position is restored
    const target = await reader.evaluate(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      scrollTo(0, max * 0.5);
      // headless background pages skip rendering steps, where scroll events are fired
      dispatchEvent(new Event('scroll'));
      return max * 0.5;
    });
    assert.ok(target > 100);
    let it;
    for (let i = 0; i < 40; i++) {
      it = await db('getItem', articleId);
      if (it.progress > 0) break;
      await reader.waitForTimeout(250);
    }
    assert.ok(it.progress > 0.4 && it.progress < 0.6, `progress ${it.progress}`);
    await reader.reload();
    await reader.waitForSelector('body[data-ready="1"]');
    await reader.waitForTimeout(300);
    const y = await reader.evaluate(() => scrollY / (document.documentElement.scrollHeight - innerHeight));
    assert.ok(y > 0.4 && y < 0.6, `restored ${y}`);
    assert.equal(await reader.getAttribute('html', 'data-theme'), 'sepia');
    const s = await helper.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.equal(s.theme, 'sepia');
    assert.equal(s.fontSize, 20);
  });

  const library = watch(await context.newPage());
  await step('import a Pocket HTML export (tags, archive, duplicates)', async () => {
    const pocket = `<!DOCTYPE html><html><head><title>Pocket Export</title></head><body>
<h1>Unread</h1><ul>
<li><a href="${origin}/article2.html" time_added="1700000000" tags="english,offline">Why offline reading matters</a></li>
<li><a href="${origin}/cp1251.html" time_added="1700000100" tags="">Old encoding</a></li>
<li><a href="${origin}/article.html?utm_source=pocket" time_added="1700000200" tags="reading">dupe of the saved one</a></li>
</ul><h1>Read Archive</h1><ul>
<li><a href="${origin}/missing.html" time_added="1600000000" tags="old">Gone page</a></li>
</ul></body></html>`;
    const file = join(work, 'ril_export.html');
    await writeFile(file, pocket);
    await helper.goto(ext('src/options/options.html#import'));
    await helper.waitForSelector('body[data-ready="1"]');
    await helper.setInputFiles('#file', file);
    await helper.waitForSelector('#importGo');
    const prev = await helper.textContent('#preview');
    assert.match(prev, /Pocket \(HTML\)/);
    assert.match(prev, /Найдено ссылок: 4/);
    assert.match(prev, /Новых для библиотеки: 3/);
    assert.match(prev, /Попадут в архив \(были прочитаны\): 1/);
    await helper.click('#importGo');
    await helper.waitForFunction(() => /Добавлено статей: 3/.test(document.querySelector('#preview')?.textContent || ''));
    const items = await db('getAllItems');
    assert.equal(items.length, 4);
    const saved = items.find((i) => i.id === articleId);
    assert.deepEqual(saved.tags, ['reading'], 'tag from the export merged into the existing item');
    assert.equal(items.find((i) => i.url.endsWith('missing.html')).status, 'archived');
  });

  await step('library: views, counts, link-only filter, load text for imported links', async () => {
    await library.goto(ext('src/library/library.html#view=all&content=link'));
    await library.waitForSelector('body[data-ready="1"]');
    assert.equal(await library.$$eval('#list .row', (r) => r.length), 3);
    assert.equal(await library.textContent('#c-unread'), '3');
    assert.equal(await library.textContent('#c-archive'), '1');
    await library.click('#selectAll');
    await library.waitForSelector('#bulk:not([hidden])');
    await library.click('#bulkActions button:has-text("Загрузить текст")');
    await library.waitForFunction(() => /Тексты загружены/.test(document.querySelector('.toast')?.textContent || ''), null, { timeout: 30000 });
    assert.match(await library.textContent('.toast'), /Тексты загружены: 2, не удалось: 1/);
    const items = await db('getAllItems');
    const en = items.find((i) => i.url.endsWith('article2.html'));
    assert.equal(en.content, 'full');
    assert.equal(en.title, 'Why offline reading matters');
    assert.deepEqual(en.tags, ['english', 'offline']);
    const cp = items.find((i) => i.url.endsWith('cp1251.html'));
    assert.equal(cp.content, 'full');
    const cpText = await db('getContent', cp.id);
    assert.match(cpText.text, /Привычка читать длинные тексты/, 'windows-1251 decoded');
    assert.equal(items.find((i) => i.url.endsWith('missing.html')).content, 'failed');
  });

  await step('library: full-text search, keyboard archive + undo, trash + restore', async () => {
    await library.goto(ext('src/library/library.html#view=all'));
    await library.waitForSelector('body[data-ready="1"]');
    await library.fill('#q', 'метро самолёт');
    await library.waitForFunction(() => document.querySelectorAll('#list .row').length === 1);
    assert.match(await library.textContent('#list .row .title'), /Как вернуть привычку/);
    await library.fill('#q', 'checklist');
    await library.waitForFunction(() => document.querySelector('#list .row .title')?.textContent === 'Why offline reading matters');
    await library.fill('#q', '');
    await library.goto(ext('src/library/library.html'));
    await library.waitForSelector('body[data-ready="1"]');
    const before = await library.$$eval('#list .row', (r) => r.length);
    await library.keyboard.press('j');
    await library.keyboard.press('Escape');
    await library.locator('body').press('e');
    await library.waitForFunction((n) => document.querySelectorAll('#list .row').length === n - 1, before);
    await library.click('.toast button');
    await library.waitForFunction((n) => document.querySelectorAll('#list .row').length === n, before);
    const firstTitle = await library.textContent('#list .row .title');
    await library.click('#list .row:first-child .acts button[aria-label="В корзину"]');
    await library.waitForFunction((n) => document.querySelectorAll('#list .row').length === n - 1, before);
    await library.click('#views button[data-view="trash"]');
    await library.waitForSelector('#list .row');
    assert.equal(await library.textContent('#list .row .title'), firstTitle);
    assert.match(await library.textContent('#list .row .meta'), /удалится через 30 дн/);
    await library.click('#list .row .acts button[aria-label="Восстановить"]');
    await library.waitForSelector('#empty:not([hidden])');
  });

  await step('save several selected tabs (host access requested at that moment)', async () => {
    const t1 = await context.newPage();
    await t1.goto(`${origin}/article2.html?from=tabs`);
    const t2 = await context.newPage();
    await t2.goto(`${origin}/cp1251.html?from=tabs`);
    const ids = [await tabIdOf(`${origin}/article2.html?from=tabs`), await tabIdOf(`${origin}/cp1251.html?from=tabs`)];
    await library.goto(ext(`src/library/library.html?saveTabs=${ids.join(',')}`));
    await library.waitForSelector('#saveTabsGo');
    await library.click('#saveTabsGo');
    await library.waitForFunction(() => /Сохранено с текстом: 2/.test(document.querySelector('.toast')?.textContent || ''), null, { timeout: 20000 });
    const items = await db('getAllItems');
    assert.equal(items.filter((i) => i.url.includes('from=tabs')).length, 2);
    await t1.close();
    await t2.close();
  });

  await step('export: JSON backup is complete, Markdown ZIP has articles and highlights', async () => {
    await helper.goto(ext('src/options/options.html#export'));
    await helper.waitForSelector('body[data-ready="1"]');
    const [dl] = await Promise.all([helper.waitForEvent('download'), helper.click('#exJson')]);
    assert.match(dl.suggestedFilename(), /^read-later-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const backup = JSON.parse(await readFile(await dl.path(), 'utf8'));
    assert.equal(backup.format, 'read-later-backup');
    assert.equal(backup.items.length, 6);
    const a = backup.items.find((i) => i.id === articleId);
    assert.match(a.html, /Что помогает дочитывать/);
    assert.equal(a.highlightList[0].note, 'Главная мысль про офлайн');
    const [md] = await Promise.all([helper.waitForEvent('download'), helper.click('#exMd')]);
    const files = readZip(new Uint8Array(await readFile(await md.path())));
    const art = files.find((f) => f.name.startsWith('unread/Как вернуть'));
    assert.ok(art, files.map((f) => f.name).join(', '));
    const text = new TextDecoder().decode(art.data);
    assert.match(text, /^---\ntitle: "Как вернуть привычку читать длинные статьи"/);
    assert.match(text, /## Что помогает дочитывать/);
    assert.match(text, /> Статья, которая открывается без интернета\n\nГлавная мысль про офлайн/);
    const [html] = await Promise.all([helper.waitForEvent('download'), helper.click('#exHtml')]);
    assert.match(await readFile(await html.path(), 'utf8'), /<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
    assert.match(await helper.textContent('#lastBackup'), /Последняя копия/);
  });

  await step('restore from the JSON backup after deleting everything', async () => {
    const [dl] = await Promise.all([helper.waitForEvent('download'), helper.click('#exJson')]);
    const file = join(work, 'backup.json');
    await writeFile(file, await readFile(await dl.path()));
    await db('clearAll');
    assert.equal((await db('getAllItems')).length, 0);
    await helper.reload();
    await helper.waitForSelector('body[data-ready="1"]');
    await helper.setInputFiles('#file', file);
    await helper.waitForSelector('#importGo');
    assert.match(await helper.textContent('#preview'), /Нет в этой библиотеке: 6/);
    await helper.click('#importGo');
    await helper.waitForFunction(() => /Добавлено статей: 6/.test(document.querySelector('#preview')?.textContent || ''));
    const hl = await db('getAllHighlights');
    assert.equal(hl.length, 1);
    await reader.goto(ext(`src/reader/reader.html?id=${articleId}`));
    await reader.waitForSelector('mark.hl.has-note');
    assert.match(await reader.getAttribute('#content img', 'src'), /^(blob:|http)/);
  });

  await step('no console errors in extension pages; dark theme renders', async () => {
    const dark = watch(await context.newPage());
    await dark.emulateMedia({ colorScheme: 'dark' });
    await dark.goto(ext('src/library/library.html#view=all'));
    await dark.waitForSelector('body[data-ready="1"]');
    const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(21, 19, 15)');
    if (process.env.E2E_SCREENSHOTS) await dark.screenshot({ path: join(process.env.E2E_SCREENSHOTS, 'library-dark.png') });
    await dark.close();
    assert.deepEqual(errors, []);
  });

  console.log(`\n${passed} e2e checks passed`);
} catch (e) {
  exitCode = 1;
  console.error('E2E FAILED:', e);
  if (errors.length) console.error('page errors:', errors);
} finally {
  await context.close();
  server.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
}
