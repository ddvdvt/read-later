// Renders the Chrome Web Store images into store/:
//   screenshot-1..5.png (1280×800), promo-small.png (440×280), promo-marquee.png (1400×560).
// The extension UI is real (loaded unpacked into the installed Chromium); pages are local fictional
// fixtures from store/fixtures/ served on 127.0.0.1 under *.example host names. The library is
// seeded with fictional articles through the extension's own import code.
// Run: node scripts/store-images.mjs      (REVIEW_DIR=<dir> also saves raw light/dark UI shots)
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, prepareExtension, launch, hideScrollbars, dataUrl, fileDataUrl, browserWindow, stage, render, promo } from './store-kit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store');
const FIX = join(OUT, 'fixtures');
const REVIEW = process.env.REVIEW_DIR;

const { server, port } = await startServer(async (path) => {
  if (path.startsWith('/brand/')) return { body: '<!doctype html><title>brand</title>' };
  if (path === '/img/cover.png') return { body: await readFile(join(FIX, 'cover.png')), type: 'image/png' };
  if (path === '/2026/09/kak-vernut-privychku-chitat') return { body: await readFile(join(FIX, 'article.html')) };
  return null;
});
const ARTICLE = 'http://chtenie.example/2026/09/kak-vernut-privychku-chitat';

const ext = await prepareExtension(join(ROOT, 'extension'), {
  base: `http://127.0.0.1:${port}/brand/`,
  // activeTab cannot be granted in automation: the temporary copy may read the fixture host.
  patchManifest: (m) => (m.host_permissions = ['http://chtenie.example/*']),
});
const { context, extId } = await launch(ext.extDir, ext.profile, {
  args: [`--host-resolver-rules=MAP chtenie.example 127.0.0.1:${port}`],
});
const icon = await fileDataUrl(join(ROOT, 'extension', 'icons', 'icon128.png'));
const extUrl = (p) => `chrome-extension://${extId}/${p}`;

const P = (...xs) => xs.map((x) => `<p>${x}</p>`).join('');
const LOREM_RU = [
  'Короткие заметки помогают вернуться к главному через неделю после чтения.',
  'Автор разбирает, почему длинные тексты проще дочитывать в спокойной обстановке и без рекламы.',
  'В конце — список практических шагов, которые можно попробовать уже сегодня.',
];
/** Fictional articles for the library (all hosts are *.example). */
const SEED = [
  { url: 'https://kod.example/rust-vladenie', title: 'Владение и заимствование в Rust на пальцах', tags: ['программирование', 'rust'], words: 2600, favorite: true, progress: 0.35 },
  { url: 'https://nauka.example/son-i-pamyat', title: 'Как сон влияет на память: что говорят исследования', tags: ['наука', 'здоровье'], words: 1800 },
  { url: 'https://dengi.example/byudzhet-bez-tablic', title: 'Семейный бюджет без таблиц: метод трёх конвертов', tags: ['деньги'], words: 1200 },
  { url: 'https://design.example/tipografika-ekrana', title: 'Типографика для экрана: размер, интервал, ширина строки', tags: ['дизайн', 'чтение'], words: 3100, hl: true },
  { url: 'https://travel.example/baikal-zimoi', title: 'Байкал зимой: маршрут на пять дней', tags: ['путешествия'], words: 2200 },
  { url: 'https://history.example/pismo-i-pechat', title: 'От рукописи к печатному станку: как менялось чтение', tags: ['история', 'чтение'], words: 4200, status: 'archived' },
  { url: 'https://kod.example/sqlite-v-brauzere', title: 'SQLite в браузере: когда IndexedDB уже мало', tags: ['программирование'], words: 2900 },
  { url: 'https://psy.example/fokus', title: 'Фокус в эпоху уведомлений: семь привычек', tags: ['продуктивность'], words: 1500 },
  { url: 'https://eda.example/hleb-na-zakvaske', title: 'Хлеб на закваске: подробная инструкция для начинающих', tags: ['еда'], words: 3400 },
];

async function seed(page) {
  await page.evaluate(
    async ({ seedRows, para }) => {
      const imp = await import('/lib/importers.js');
      const db = await import('/src/shared/db.js');
      const now = Date.now();
      const recs = seedRows.map((r, i) => {
        const html = `<h2>${r.title}</h2>${para}${para}`.repeat(Math.max(1, Math.round(r.words / 120)));
        const rec = imp.buildImportRecord({ ...r, addedAt: now - (i + 1) * 3600 * 1000 * 7, source: 'page', html, excerpt: '' }, now);
        rec.item.words = r.words;
        rec.item.favorite = !!r.favorite;
        rec.item.progress = r.progress || 0;
        rec.item.site = new URL(r.url).hostname;
        if (r.hl) rec.item.highlights = 2;
        return rec;
      });
      await db.putRecords(recs);
    },
    { seedRows: SEED, para: P(...LOREM_RU) },
  );
}

async function openPage(url, w = 1164, h = 591) {
  const page = await context.newPage();
  await page.setViewportSize({ width: w, height: h });
  await page.goto(url);
  await hideScrollbars(page);
  return page;
}

async function tabIdOf(url) {
  const helper = await context.newPage();
  await helper.goto(extUrl('src/options/options.html'));
  const id = await helper.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url);
  await helper.close();
  return id;
}

try {
  await mkdir(OUT, { recursive: true });
  for (const p of context.pages()) if (p.url().includes('/brand/')) await p.close();

  // 1 — article + popup right after saving
  const article = await openPage(ARTICLE);
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 380, height: 600 });
  await pop.goto(extUrl(`src/popup/popup.html?tabId=${await tabIdOf(ARTICLE)}`));
  await pop.waitForSelector('body[data-ready="1"]');
  await seed(pop);
  await pop.click('#saveBtn');
  await pop.waitForFunction(() => /Сохранено/.test(document.querySelector('#status')?.textContent || ''));
  await pop.waitForTimeout(300);
  // a real popup grows with its content up to 600 px
  await pop.setViewportSize({ width: 380, height: Math.min(600, await pop.evaluate(() => document.documentElement.scrollHeight)) });
  const s1 = stage({
    eyebrow: 'Прочитать позже · сохранение',
    caption: 'Сохраните статью в один клик — <mark>текст останется у вас</mark>, даже без интернета',
    body: browserWindow({ tab: 'Как вернуть привычку читать…', address: 'chtenie.example/2026/09/kak-vernut-privychku-chitat', page: await dataUrl(article), icon, popup: await dataUrl(pop), popupWidth: 380 }),
  });
  await render(context, s1, join(OUT, 'screenshot-1.png'));
  if (REVIEW) await pop.screenshot({ path: join(REVIEW, 'rl-popup-light.png') });
  const savedId = await pop.evaluate(async () => (await (await import('/src/shared/db.js')).getAllItems()).find((i) => i.url.includes('chtenie'))?.id);
  await pop.close();

  // 2 — library
  const lib = await openPage(extUrl('src/library/library.html'), 1164, 591);
  await lib.waitForSelector('body[data-ready="1"]');
  await lib.evaluate(() => document.querySelector('#list .row:nth-child(2) input[type="checkbox"]')?.click());
  await lib.waitForTimeout(150);
  await lib.evaluate(() => document.querySelector('#list .row:nth-child(4) input[type="checkbox"]')?.click());
  await lib.waitForTimeout(200);
  const s2 = stage({
    eyebrow: 'Прочитать позже · библиотека',
    caption: 'Теги, избранное, архив и <mark>поиск по тексту статей</mark> — всё работает офлайн',
    body: browserWindow({ tab: 'Непрочитанное — Прочитать позже', page: await dataUrl(lib), icon }),
  });
  await render(context, s2, join(OUT, 'screenshot-2.png'));
  if (REVIEW) await lib.screenshot({ path: join(REVIEW, 'rl-library-light.png'), fullPage: true });

  // 3 — reader with highlights (sepia)
  const reader = await openPage(extUrl(`src/reader/reader.html?id=${savedId}`), 1164, 591);
  await reader.waitForSelector('body[data-ready="1"]');
  const mk = async (needle, color, note) => {
    await reader.evaluate(
      ([n]) => {
        const p = [...document.querySelectorAll('#content p')].find((x) => x.textContent.includes(n));
        const node = /** @type {Text} */ ([...p.childNodes].find((c) => c.nodeType === 3 && c.data.includes(n)));
        const start = node.data.indexOf(n);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + n.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      },
      [needle],
    );
    await reader.waitForSelector('#hlPop:not([hidden])');
    await reader.click(`#hlPop .dot[data-color="${color}"]`);
    await reader.waitForSelector(`mark.hl[data-color="${color}"]`);
    if (note) {
      await reader.evaluate((c) => document.querySelector(`mark.hl[data-color="${c}"]`).click(), color);
      await reader.click('#popNote');
      await reader.fill('#noteText', note);
      await reader.click('#noteForm button[type="submit"]');
      await reader.waitForSelector('mark.hl.has-note');
    }
  };
  await mk('Крупный шрифт, спокойный фон, отсутствие рекламы', 'yellow', 'Проверить на себе: тема «сепия», 20 px');
  await mk('Статья, которая открывается без интернета', 'green');
  await reader.evaluate(async () => {
    const ui = await import('/src/shared/ui.js');
    await ui.saveSettings({ theme: 'sepia', fontSize: 20 });
  });
  await reader.waitForTimeout(200);
  await reader.evaluate(() => scrollTo(0, 0));
  await reader.click('#typeBtn');
  await reader.waitForTimeout(250);
  const s3 = stage({
    eyebrow: 'Прочитать позже · читалка',
    caption: 'Шрифт, размер, ширина и тема. <mark>Выделения с заметками</mark> и позиция чтения сохраняются',
    body: browserWindow({ tab: 'Как вернуть привычку читать…', page: await dataUrl(reader), icon }),
  });
  await render(context, s3, join(OUT, 'screenshot-3.png'));
  await reader.evaluate(async () => (await import('/src/shared/ui.js')).saveSettings({ theme: 'auto', fontSize: 19 }));
  await reader.close();

  // 4 — import preview of a Pocket export
  const pocket = `<!DOCTYPE html><html><head><title>Pocket Export</title></head><body><h1>Unread</h1><ul>
${Array.from({ length: 214 }, (_, i) => `<li><a href="https://site${i % 37}.example/post-${i}" time_added="${1600000000 + i * 86400}" tags="${['чтение', 'работа', 'идеи', ''][i % 4]}">Статья ${i}</a></li>`).join('\n')}
</ul><h1>Read Archive</h1><ul>
${Array.from({ length: 87 }, (_, i) => `<li><a href="https://old${i % 11}.example/a-${i}" time_added="${1500000000 + i * 86400}" tags="архив">Старая ${i}</a></li>`).join('\n')}
</ul></body></html>`;
  const pocketFile = join(ext.work, 'ril_export.html');
  await writeFile(pocketFile, pocket);
  const opt = await openPage(extUrl('src/options/options.html#import'), 1164, 591);
  await opt.waitForSelector('body[data-ready="1"]');
  await opt.setInputFiles('#file', pocketFile);
  await opt.waitForSelector('#importGo');
  await opt.evaluate(() => document.querySelector('#import').scrollIntoView());
  await opt.evaluate(() => scrollBy(0, -12));
  await opt.waitForTimeout(200);
  const s4 = stage({
    eyebrow: 'Прочитать позже · переезд',
    caption: 'Импорт из других сервисов и закладок: <mark>забирайте библиотеку с собой</mark>',
    body: browserWindow({ tab: 'Настройки — Прочитать позже', page: await dataUrl(opt), icon }),
  });
  await render(context, s4, join(OUT, 'screenshot-4.png'));
  if (REVIEW) await opt.screenshot({ path: join(REVIEW, 'rl-options-light.png'), fullPage: true });

  // 5 — export and backups
  await opt.click('#preview button:not(.primary)');
  await opt.evaluate(() => document.querySelector('#export').scrollIntoView());
  await opt.evaluate(() => scrollBy(0, -12));
  await opt.waitForTimeout(200);
  const s5 = stage({
    eyebrow: 'Прочитать позже · без привязки',
    caption: 'Экспорт в JSON, HTML и Markdown. <mark>Без аккаунта</mark>, без серверов, без рекламы',
    body: browserWindow({ tab: 'Настройки — Прочитать позже', page: await dataUrl(opt), icon }),
  });
  await render(context, s5, join(OUT, 'screenshot-5.png'));
  await opt.close();

  // promo tiles
  const tile = {
    icon,
    name: 'Прочитать позже',
    eyebrow: 'Честные расширения',
    tagline: 'Статьи <mark>офлайн и без аккаунта</mark>. Импорт и экспорт без привязки',
    facts: [['Цена', '0 ₽'], ['Аккаунт', 'не нужен'], ['Реклама', '0'], ['Трекеры', '0'], ['Статьи', 'на устройстве']],
  };
  await render(context, promo({ ...tile, size: 'small' }), join(OUT, 'promo-small.png'), 440, 280);
  await render(context, promo({ ...tile, size: 'marquee' }), join(OUT, 'promo-marquee.png'), 1400, 560);

  if (REVIEW) {
    // dark theme + empty states for the UX review (not store assets)
    const dark = await context.newPage();
    await dark.emulateMedia({ colorScheme: 'dark' });
    await dark.setViewportSize({ width: 1100, height: 760 });
    await dark.goto(extUrl('src/library/library.html'));
    await dark.waitForSelector('body[data-ready="1"]');
    await dark.screenshot({ path: join(REVIEW, 'rl-library-dark.png') });
    await dark.click('#layoutGrid');
    await dark.waitForTimeout(200);
    await dark.screenshot({ path: join(REVIEW, 'rl-library-grid-dark.png') });
    await dark.click('#layoutList');
    await dark.goto(extUrl(`src/reader/reader.html?id=${savedId}`));
    await dark.waitForSelector('body[data-ready="1"]');
    await dark.screenshot({ path: join(REVIEW, 'rl-reader-dark.png') });
    await dark.goto(extUrl('src/options/options.html'));
    await dark.waitForSelector('body[data-ready="1"]');
    await dark.screenshot({ path: join(REVIEW, 'rl-options-dark.png'), fullPage: true });
    await dark.setViewportSize({ width: 380, height: 560 });
    await dark.goto(extUrl(`src/popup/popup.html?tabId=${await tabIdOf(ARTICLE)}`));
    await dark.waitForSelector('body[data-ready]');
    await dark.screenshot({ path: join(REVIEW, 'rl-popup-dark.png') });
    await dark.goto(extUrl('src/popup/popup.html?tabId=999999'));
    await dark.waitForSelector('body[data-ready]');
    await dark.screenshot({ path: join(REVIEW, 'rl-popup-restricted-dark.png') });
    await dark.evaluate(async () => (await import('/src/shared/db.js')).clearAll());
    await dark.setViewportSize({ width: 1000, height: 640 });
    await dark.goto(extUrl('src/library/library.html'));
    await dark.waitForSelector('body[data-ready]');
    await dark.screenshot({ path: join(REVIEW, 'rl-library-empty-dark.png') });
    await dark.close();
  }
  console.log('store images written to', OUT);
} finally {
  await context.close();
  server.close();
  await ext.cleanup();
}
