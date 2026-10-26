// Helpers for scripts/store-images.mjs: render Chrome Web Store screenshots (1280×800) and promo
// tiles from the REAL extension UI, using local fixture pages only. One browser, closed at the end.
// Fonts of the brand site (Unbounded, Golos Text, JetBrains Mono) come from Google Fonts, like on the site.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EXE =
  process.env.CHROMIUM_PATH ||
  join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');

const FONTS =
  'https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&family=Unbounded:wght@600;700;900&display=block';

/** Brand palette of the site (site/assets/css/site.css). */
export const BRAND = {
  paper: '#f3eee4',
  paper2: '#e8e1d2',
  card: '#fbf8f2',
  ink: '#1a1712',
  ink2: '#4a4339',
  ink3: '#6b6252',
  accent: '#c2341a',
  hl: '#ffd84d',
};

/**
 * Tiny static server. `route(path, host)` returns {body, type} or null (→ 404).
 * @param {(path: string, host: string) => Promise<{ body: string | Buffer, type?: string } | null>} route
 */
export async function startServer(route) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent((req.url || '/').split('?')[0]);
      const r = path.includes('..') ? null : await route(path, String(req.headers.host || ''));
      if (!r) throw new Error('404');
      res.writeHead(200, { 'content-type': r.type || 'text/html; charset=utf-8' });
      res.end(r.body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: /** @type {any} */ (server.address()).port };
}

/**
 * Copy the extension to a temp dir; point lib/brand.js BASE at the local server so the welcome tab
 * never leaves the machine; let `patchManifest` add test-only host permissions (never in the real one).
 * @param {string} srcExt
 * @param {{ base: string, patchManifest?: (m: any) => void }} opts
 */
export async function prepareExtension(srcExt, { base, patchManifest }) {
  const work = await mkdtemp(join(tmpdir(), 'store-images-'));
  const extDir = join(work, 'extension');
  await cp(srcExt, extDir, { recursive: true });
  const brandFile = join(extDir, 'lib', 'brand.js');
  const brand = await readFile(brandFile, 'utf8');
  await writeFile(brandFile, brand.replace(/export const BASE = '[^']*';/, `export const BASE = '${base}';`));
  if (patchManifest) {
    const m = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
    patchManifest(m);
    await writeFile(join(extDir, 'manifest.json'), JSON.stringify(m, null, 2));
  }
  return { work, extDir, profile: join(work, 'profile'), cleanup: () => rm(work, { recursive: true, force: true }).catch(() => {}) };
}

/**
 * @param {string} extDir
 * @param {string} profile
 * @param {{ args?: string[], colorScheme?: 'light' | 'dark' }} [opts]
 */
export async function launch(extDir, profile, opts = {}) {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: EXE,
    headless: false,
    colorScheme: opts.colorScheme || 'light',
    locale: 'ru-RU',
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 800 },
    args: [
      '--headless=new',
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--renderer-process-limit=2',
      '--lang=ru',
      ...(opts.args || []),
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  return { context, sw, extId };
}

/** Hide page scrollbars before a screenshot (they are not part of the UI being shown). */
export async function hideScrollbars(page) {
  await page.addStyleTag({ content: 'html::-webkit-scrollbar{display:none} html{scrollbar-width:none}' });
}

/** @param {{ screenshot: (o?: any) => Promise<Buffer> }} target */
export async function dataUrl(target, opts = {}) {
  return 'data:image/png;base64,' + (await target.screenshot({ animations: 'disabled', ...opts })).toString('base64');
}

export async function fileDataUrl(path) {
  return 'data:image/png;base64,' + (await readFile(path)).toString('base64');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A minimal, unbranded browser window around a page screenshot, with the extension popup
 * dropped from its toolbar icon.
 * @param {{ tab: string | string[], address?: string, page: string, icon: string, popup?: string, popupWidth?: number, width?: number, height?: number }} o
 */
export function browserWindow(o) {
  const w = o.width || 1168;
  const h = o.height || 670;
  return `
  <div class="win" style="width:${w}px;height:${h}px">
    <div class="tabs">${[].concat(o.tab).map((t, i) => `<div class="tab${i ? ' bg' : ''}"><span class="fav"></span>${esc(t)}</div>`).join('')}<div class="newtab">+</div></div>
    <div class="bar">
      <span class="nav">&#8592;</span><span class="nav">&#8594;</span><span class="nav">&#8635;</span>
      <div class="omni">${o.address ? `<span class="lock"></span>${esc(o.address)}` : ''}</div>
      <img class="exticon ${o.popup ? 'on' : ''}" src="${o.icon}" alt="">
      <span class="dots">&#8942;</span>
    </div>
    <div class="viewport"><img src="${o.page}" alt=""></div>
    ${o.popup ? `<img class="popup" src="${o.popup}" style="width:${o.popupWidth || 440}px" alt="">` : ''}
  </div>`;
}

/**
 * 1280×800 store screenshot: caption bar in the brand style + body.
 * @param {{ eyebrow: string, caption: string, body: string, extraCss?: string }} o
 */
export function stage(o) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<link rel="stylesheet" href="${FONTS}">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;width:1280px;height:800px;overflow:hidden;background:${BRAND.paper};color:${BRAND.ink};font-family:"Golos Text","Segoe UI",sans-serif}
  .cap{height:118px;padding:20px 56px 0;display:flex;flex-direction:column;justify-content:flex-start}
  .eyebrow{font:600 14px/1 "JetBrains Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.accent};margin:0 0 11px}
  .caption{font:700 31px/1.12 "Unbounded","Arial Black",sans-serif;letter-spacing:-.02em;margin:0;max-width:1170px}
  .caption mark{background:${BRAND.hl};color:${BRAND.ink};padding:0 .12em}
  .body{position:absolute;left:0;right:0;top:118px;bottom:0;display:flex;justify-content:center;align-items:flex-start;padding-top:12px}
  .win{position:relative;background:#fff;border:2px solid ${BRAND.ink};border-radius:10px 10px 0 0;border-bottom:0;overflow:hidden;box-shadow:10px 10px 0 ${BRAND.ink}}
  .tabs{height:36px;background:#dee1e6;display:flex;align-items:flex-end;padding:0 10px;gap:6px}
  .tab{height:30px;background:#fff;border-radius:8px 8px 0 0;padding:0 14px;display:flex;align-items:center;gap:8px;font:13px "Segoe UI",sans-serif;color:#202124;max-width:300px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tab.bg{background:transparent;color:#3c4043;max-width:190px;flex:0 1 190px}
  .fav{width:14px;height:14px;border-radius:50%;background:#9aa0a6;flex:none}
  .newtab{font:18px "Segoe UI";color:#5f6368;padding:0 6px 6px}
  .bar{height:40px;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid #dadce0}
  .nav{width:28px;text-align:center;color:#5f6368;font:16px "Segoe UI",sans-serif}
  .omni{flex:1;height:28px;border-radius:14px;background:#f1f3f4;display:flex;align-items:center;gap:8px;padding:0 14px;font:14px "Segoe UI",sans-serif;color:#202124}
  .lock{width:10px;height:10px;border:2px solid #5f6368;border-radius:2px;display:inline-block}
  .exticon{width:20px;height:20px;margin:0 6px;padding:2px;border-radius:50%;box-sizing:content-box}
  .exticon.on{background:#e8eaed}
  .dots{color:#5f6368;font:18px "Segoe UI";padding:0 4px}
  .viewport{position:absolute;top:77px;left:0;right:0;bottom:0;overflow:hidden;background:#fff}
  .viewport img{display:block;width:100%}
  .popup{position:absolute;top:70px;right:36px;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.12)}
  ${o.extraCss || ''}
</style></head><body>
<div class="cap"><p class="eyebrow">${esc(o.eyebrow)}</p><h1 class="caption">${o.caption}</h1></div>
<div class="body">${o.body}</div>
</body></html>`;
}

/**
 * Render HTML at an exact size into a PNG file.
 * @param {import('playwright-core').BrowserContext} context
 */
export async function render(context, html, out, width = 1280, height = 800) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  if (html.includes('dataset.fit')) await page.waitForSelector('body[data-fit]');
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
  await page.close();
}

/**
 * Promo tile in the brand style ("label" card): small 440×280 or marquee 1400×560.
 * @param {{ size: 'small' | 'marquee', icon: string, name: string, tagline: string, facts: Array<[string, string]>, eyebrow: string }} o
 */
export function promo(o) {
  const small = o.size === 'small';
  const W = small ? 440 : 1400;
  const H = small ? 280 : 560;
  const facts = o.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<link rel="stylesheet" href="${FONTS}">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${BRAND.paper};color:${BRAND.ink};font-family:"Golos Text",sans-serif}
  .frame{position:absolute;inset:0;border:${small ? 8 : 14}px solid ${BRAND.ink};display:grid;grid-template-columns:${small ? '1fr' : '1.35fr 1fr'};align-items:center;gap:${small ? 0 : 56}px;padding:${small ? '26px 28px' : '56px 72px'}}
  .eyebrow{font:600 ${small ? 11 : 16}px/1 "JetBrains Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.accent};margin:0 0 ${small ? 12 : 22}px}
  .head{display:flex;align-items:center;gap:${small ? 14 : 26}px}
  .head img{width:${small ? 64 : 120}px;height:${small ? 64 : 120}px;flex:none}
  .head{min-width:0}
  .frame > div{min-width:0}
  h1{white-space:nowrap;min-width:0;overflow:hidden;font:900 ${small ? 34 : 72}px/1.1 "Unbounded","Arial Black",sans-serif;letter-spacing:-.03em;margin:0}
  .tag{font:600 ${small ? 17 : 30}px/1.3 "Golos Text",sans-serif;margin:${small ? 16 : 30}px 0 0;max-width:${small ? 380 : 700}px}
  .tag mark{background:${BRAND.hl};color:${BRAND.ink};padding:0 .15em}
  .label{background:${BRAND.card};border:2px solid ${BRAND.ink};box-shadow:8px 8px 0 ${BRAND.ink};padding:26px 30px;transform:rotate(1.5deg)}
  .label h2{font:900 40px/1 "Unbounded",sans-serif;margin:0 0 6px;letter-spacing:-.03em}
  .label .sub{font:500 14px "JetBrains Mono",monospace;color:${BRAND.ink3};margin:0 0 14px;border-bottom:6px solid ${BRAND.ink};padding-bottom:12px}
  dl{margin:0}
  dl div{display:flex;justify-content:space-between;gap:24px;padding:11px 0;border-bottom:1px solid ${BRAND.ink}}
  dl div:last-child{border-bottom:6px solid ${BRAND.ink}}
  dt{font:600 19px "Golos Text",sans-serif}
  dd{margin:0;font:600 18px "JetBrains Mono",monospace}
</style></head><body><div class="frame">
<div>
  <p class="eyebrow">${esc(o.eyebrow)}</p>
  <div class="head"><img src="${o.icon}" alt=""><h1>${esc(o.name)}</h1></div>
  <p class="tag">${o.tagline}</p>
</div>
${small ? '' : `<div class="label"><h2>Состав</h2><p class="sub">что внутри расширения</p><dl>${facts}</dl></div>`}
</div>
<script>
  // shrink the name until it fits on one line
  document.fonts.ready.then(() => {
    const h = document.querySelector('h1');
    let size = parseFloat(getComputedStyle(h).fontSize);
    while (h.scrollWidth > h.clientWidth && size > 12) h.style.fontSize = (size -= 1) + 'px';
    document.body.dataset.fit = '1';
  });
</script></body></html>`;
}
