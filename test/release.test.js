// Release checks: brand-site links, manifest fields required by the Chrome Web Store,
// locales, permissions actually used by the code, no remote code, vendored library + license.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, SLUG, brandUrls, welcomeUrlFor } from '../extension/lib/brand.js';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (p) => readFileSync(join(EXT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const LOCALES = readdirSync(join(EXT, '_locales'));

/** @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(EXT);
const own = files.filter((f) => !/[\\/]vendor[\\/]/.test(f));
const code = own.filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');

/** Which code proves that a permission is used. */
const USAGE = {
  activeTab: /chrome\.scripting\.executeScript/,
  scripting: /chrome\.scripting\./,
  storage: /chrome\.storage\./,
  contextMenus: /chrome\.contextMenus\./,
  unlimitedStorage: /indexedDB\.open/,
};

test('brand URLs are built from one BASE', () => {
  assert.equal(SLUG, 'read-later');
  assert.match(BASE, /^https:\/\/.+\/$/);
  const u = brandUrls();
  assert.equal(u.welcome, `${BASE}welcome/read-later.html`);
  assert.equal(u.bye, `${BASE}bye/read-later.html`);
  assert.equal(u.privacy, `${BASE}privacy/read-later.html`);
  assert.equal(u.other, `${BASE}#read-later`);
});

test('welcome page opens only on a fresh install', () => {
  assert.equal(welcomeUrlFor('install'), `${BASE}welcome/read-later.html`);
  for (const r of ['update', 'chrome_update', 'shared_module_update', undefined]) assert.equal(welcomeUrlFor(r), null);
});

test('service worker wires the welcome and uninstall pages', () => {
  const sw = read(manifest.background.service_worker);
  assert.match(sw, /from '\.\.\/lib\/brand\.js'/);
  assert.match(sw, /welcomeUrlFor\(details/);
  assert.match(sw, /setUninstallURL\(brandUrls\(\)\.bye\)/);
});

test('"other extensions" links go to the brand site, no placeholders left', () => {
  const pages = own.filter((x) => x.endsWith('.html'));
  assert.ok(pages.length >= 4);
  for (const f of pages) {
    const html = readFileSync(f, 'utf8');
    assert.ok(!html.includes('https://github.com/'), `${f} still links to the github.com placeholder`);
    for (const m of html.matchAll(/<a [^>]*data-i18n="otherExtensions"[^>]*>/g)) assert.match(m[0], /data-brand-link="other"/, f);
  }
  for (const page of ['src/popup/popup.html', 'src/library/library.html', 'src/options/options.html']) assert.match(read(page), /data-brand-link="other"/, page);
});

test('manifest: CWS fields', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.homepage_url, BASE, 'homepage_url must equal BASE from lib/brand.js');
  assert.equal(manifest.default_locale, 'ru');
  assert.equal(manifest.content_security_policy, undefined, 'default CSP');
  for (const size of ['16', '32', '48', '128']) {
    const png = readFileSync(join(EXT, manifest.icons[size]));
    assert.equal(png.readUInt32BE(16), Number(size), `icon ${size} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `icon ${size} height`);
  }
  const keys = Object.values(manifest.commands).map((c) => c.suggested_key && c.suggested_key.default).filter(Boolean);
  assert.deepEqual(keys, ['Alt+Shift+S']);
});

test('manifest: every permission is used by the code, host access only optional', () => {
  assert.deepEqual([...manifest.permissions].sort(), Object.keys(USAGE).sort());
  for (const p of manifest.permissions) assert.match(code, USAGE[p], `permission ${p} unused`);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_permissions, ['bookmarks']);
  assert.match(code, /chrome\.bookmarks\.getTree/);
  assert.match(code, /chrome\.permissions\.request\(\{ permissions: \['bookmarks'\] \}\)/);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.match(code, /chrome\.permissions\.request\(\{ origins \}\)/);
  assert.match(code, /chrome\.permissions\.remove\(\{ origins \}\)/, 'host access is given back after use');
});

test('locales: ru and en complete, CWS length limits', () => {
  assert.deepEqual(LOCALES.sort(), ['en', 'ru']);
  const all = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
  const keys = Object.keys(all.ru).sort();
  const used = new Set([...code.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z0-9_]+)"/g), ...code.matchAll(/\b(?:t|msg)\('([A-Za-z0-9_]+)'[,)]/g)].map((m) => m[1]));
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
  // keys picked dynamically
  for (const k of ['viewUnread', 'viewFavorites', 'viewArchive', 'viewAll', 'viewTrash', 'viewHighlights', 'doneArchived', 'doneUnarchived', 'doneFavorite', 'doneUnfavorite', 'doneTrashed', 'doneRestored', 'quotaWarn', 'quotaCritical']) used.add(k);
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(all[l]).sort(), keys, `${l} keys`);
    for (const k of used) assert.ok(all[l][k], `${l}: missing ${k}`);
    assert.ok([...all[l].extName.message].length <= 75, `${l} name too long`);
    assert.ok([...all[l].extShortName.message].length <= 12, `${l} short_name too long`);
    assert.ok([...all[l].extDescription.message].length <= 132, `${l} description too long`);
  }
});

test('no remote code, eval or debug leftovers in our code', () => {
  for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/<script[^>]+src="https?:/.test(src), `${f}: remote script`);
    assert.ok(!/\beval\(|new Function\(|debugger;/.test(src), `${f}: eval/debugger`);
  }
  for (const f of own.filter((x) => /\.(js|html)$/.test(x))) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/console\.log\(/.test(src), `${f}: console.log`);
    assert.ok(!/\b(TODO|FIXME)\b/.test(src) || f.endsWith('brand.js'), `${f}: TODO left`);
  }
});

test('vendored Readability is unmodified upstream code with its license', () => {
  const src = read('vendor/Readability.js');
  assert.match(src, /^\/\*\n \* Copyright \(c\) 2010 Arc90 Inc\n \*\n \* Licensed under the Apache License, Version 2\.0/);
  assert.match(src, /function Readability\(doc, options\)/);
  assert.ok(existsSync(join(EXT, 'vendor', 'LICENSE-Readability.md')));
  assert.match(read('vendor/LICENSE-Readability.md'), /Apache License/);
  const save = read('src/shared/save.js');
  for (const m of save.matchAll(/'((?:vendor|src)\/[^']+\.js)'/g)) assert.ok(existsSync(join(EXT, m[1])), `${m[1]} injected but missing`);
});
