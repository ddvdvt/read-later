// Firefox build: the same extension/ sources, a Firefox manifest (no duplicated source tree).
//
//   node scripts/firefox.mjs            → dist/firefox/ (unpacked, for web-ext lint / about:debugging)
//                                         + dist/<slug>-<version>-firefox.zip (for AMO), verified
//   node scripts/firefox.mjs --out DIR  → unpacked build in DIR only (used by the Firefox e2e test)
//
// The manifest transform is a pure function (firefoxManifest) and is unit-tested.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, dirname, sep, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createZip, readZip } from '../extension/lib/zip.js';

// ---------- per-extension settings ----------
export const SLUG = 'read-later';
/**
 * Firefox 140 (ESR) is the first version with browser_specific_settings.gecko.data_collection_permissions
 * (required for new AMO listings since 2025-11-03); everything else used here is older:
 * MV3 event pages with ES modules (128), optional_host_permissions (128), menus "action" context (109),
 * scripting.executeScript with files/func (102), optional "bookmarks" (≥ 74), unlimitedStorage.
 */
export const MIN_FIREFOX = '140.0';
export const MIN_ANDROID = '142.0';
/** AMO data collection: nothing is collected or transmitted. */
export const DATA_COLLECTION = { required: ['none'] };
/** Chrome-only permissions that Firefox rejects or ignores, and Firefox-only additions. */
const DROP_PERMISSIONS = [];
const ADD_PERMISSIONS = [];
/**
 * Extension-page CSP. Firefox's MV3 default adds upgrade-insecure-requests: the library's
 * "load text" fetch of an http:// article (and http:// images of saved articles in the reader)
 * would be turned into https:// and fail on http-only sites. Chrome's default has no such
 * directive. Same script policy as the default, without the upgrade.
 */
const CSP = { extension_pages: "script-src 'self'" };
/** Files that only the Chrome build uses. */
const EXCLUDE = [];

// ---------- transform ----------

/**
 * Chrome MV3 manifest → Firefox MV3 manifest.
 * @param {any} chrome
 * @param {{ slug?: string, minVersion?: string, dataCollection?: object, drop?: string[], add?: string[], csp?: object | null }} [o]
 */
export function firefoxManifest(chrome, o = {}) {
  const m = structuredClone(chrome);
  const slug = o.slug || SLUG;
  delete m.minimum_chrome_version;
  delete m.key;
  delete m.update_url;
  if (m.background?.service_worker) {
    const { service_worker, type } = m.background;
    m.background = { scripts: [service_worker], ...(type === 'module' ? { type: 'module' } : {}) };
  }
  const drop = new Set(o.drop || DROP_PERMISSIONS);
  if (m.permissions) m.permissions = [...m.permissions.filter((p) => !drop.has(p)), ...(o.add || ADD_PERMISSIONS).filter((p) => !m.permissions.includes(p))];
  if (m.optional_permissions) {
    m.optional_permissions = m.optional_permissions.filter((p) => !drop.has(p));
    if (!m.optional_permissions.length) delete m.optional_permissions;
  }
  const csp = o.csp === undefined ? CSP : o.csp;
  if (csp && !m.content_security_policy) m.content_security_policy = csp;
  m.browser_specific_settings = {
    gecko: {
      id: `${slug}@ddvdvt.github.io`,
      strict_min_version: o.minVersion || MIN_FIREFOX,
      data_collection_permissions: o.dataCollection || DATA_COLLECTION,
    },
    // Firefox for Android got data_collection_permissions in 142 (the add-on may be installed there)
    gecko_android: { strict_min_version: MIN_ANDROID },
  };
  return m;
}

// ---------- build ----------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');

/** @returns {{ name: string, data: Uint8Array }[]} files of the Firefox package */
export function firefoxFiles() {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || name === 'Thumbs.db') continue;
      const p = join(dir, name);
      const rel = relative(ext, p).split(sep).join('/');
      if (EXCLUDE.includes(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ name: rel, data: new Uint8Array(readFileSync(p)) });
    }
  })(ext);
  const manifest = firefoxManifest(JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')));
  const i = files.findIndex((f) => f.name === 'manifest.json');
  files[i] = { name: 'manifest.json', data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) };
  return files;
}

/** Write the unpacked Firefox build into `dir` (emptied first). @param {string} dir */
export function writeUnpacked(dir) {
  rmSync(dir, { recursive: true, force: true });
  for (const f of firefoxFiles()) {
    const p = join(dir, ...f.name.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.data);
  }
  return dir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outIdx = process.argv.indexOf('--out');
  if (outIdx > 0) {
    console.log(`Firefox build -> ${writeUnpacked(resolve(process.argv[outIdx + 1]))}`);
  } else {
    const files = firefoxFiles();
    const manifest = JSON.parse(new TextDecoder().decode(files.find((f) => f.name === 'manifest.json').data));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeUnpacked(join(root, 'dist', 'firefox'));
    const out = join(root, 'dist', `${SLUG}-${manifest.version}-firefox.zip`);
    writeFileSync(out, createZip(files));

    // verify what was written
    const entries = readZip(new Uint8Array(readFileSync(out)));
    const names = entries.map((e) => e.name);
    const packed = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json').data));
    assert.equal(packed.browser_specific_settings.gecko.id, `${SLUG}@ddvdvt.github.io`);
    assert.ok(!packed.background.service_worker && packed.background.scripts.length, 'event page');
    for (const l of readdirSync(join(ext, '_locales'))) assert.ok(names.includes(`_locales/${l}/messages.json`), `locale ${l}`);
    for (const p of [...packed.background.scripts, packed.options_ui?.page, packed.action?.default_popup, ...Object.values(packed.icons)].filter(Boolean)) {
      assert.ok(names.includes(p), `${p} packed`);
    }
    for (const n of names) {
      assert.ok(!n.includes('\\') && !/(^|\/)\./.test(n), `${n}: bad name`);
      assert.ok(!/(^|\/)(node_modules|test|e2e|scripts|store|dist|__e2e__)\//.test(n), `${n}: not part of the extension`);
      assert.ok(!EXCLUDE.includes(n), `${n}: Chrome-only file`);
    }
    for (const e of entries) assert.deepEqual(Buffer.from(e.data), Buffer.from(files.find((f) => f.name === e.name).data), `${e.name}: content`);
    console.log(`${files.length} files, ${statSync(out).size} bytes -> ${out} (verified)`);
  }
}
