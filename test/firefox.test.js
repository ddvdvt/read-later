// Firefox build: manifest transform, package contents, Firefox shortcut conflicts (scripts/firefox.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefoxManifest, firefoxFiles, MIN_FIREFOX, SLUG } from '../scripts/firefox.mjs';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const chrome = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const ff = firefoxManifest(chrome);

test('Firefox manifest: event page instead of the service worker, same module', () => {
  assert.deepEqual(ff.background, { scripts: [chrome.background.service_worker], type: 'module' });
});

test('Firefox manifest: gecko id, minimum version, AMO data collection = none', () => {
  assert.deepEqual(ff.browser_specific_settings, {
    gecko: { id: `${SLUG}@ddvdvt.github.io`, strict_min_version: MIN_FIREFOX, data_collection_permissions: { required: ['none'] } },
    gecko_android: { strict_min_version: '142.0' },
  });
  assert.ok(Number.parseFloat(MIN_FIREFOX) >= 140, 'data_collection_permissions needs Firefox 140+');
});

test('Firefox manifest: only Chrome-only keys change; CSP without upgrade-insecure-requests', () => {
  assert.equal(ff.minimum_chrome_version, undefined);
  assert.deepEqual(ff.content_security_policy, { extension_pages: "script-src 'self'" });
  assert.equal(chrome.content_security_policy, undefined, 'Chrome keeps its default CSP');
  for (const k of ['name', 'version', 'default_locale', 'icons', 'action', 'options_ui', 'homepage_url', 'permissions', 'optional_permissions', 'optional_host_permissions', 'commands']) assert.deepEqual(ff[k], chrome[k], k);
  const copy = structuredClone(chrome);
  firefoxManifest(copy);
  assert.deepEqual(copy, chrome, 'the Chrome manifest object is not modified');
});

test('keyboard shortcuts do not clash with Firefox', () => {
  // Firefox's own shortcuts (support.mozilla.org/kb/keyboard-shortcuts-perform-firefox-tasks-quickly)
  const reserved = [
    'Ctrl+Shift+A', 'Ctrl+Shift+B', 'Ctrl+Shift+C', 'Ctrl+Shift+D', 'Ctrl+Shift+E', 'Ctrl+Shift+H', 'Ctrl+Shift+I', 'Ctrl+Shift+J',
    'Ctrl+Shift+K', 'Ctrl+Shift+M', 'Ctrl+Shift+N', 'Ctrl+Shift+O', 'Ctrl+Shift+P', 'Ctrl+Shift+Q', 'Ctrl+Shift+R', 'Ctrl+Shift+S',
    'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Shift+X', 'Ctrl+Shift+Y', 'Ctrl+Shift+Z', 'Ctrl+Shift+Delete', 'Alt+Shift+R',
  ];
  for (const k of Object.values(ff.commands).flatMap((c) => Object.values(c.suggested_key || {}))) assert.ok(!reserved.includes(k), `${k} is used by Firefox`);
});

test('Firefox package: the same files, with the Firefox manifest', () => {
  const files = firefoxFiles();
  const packed = JSON.parse(new TextDecoder().decode(files.find((f) => f.name === 'manifest.json').data));
  assert.deepEqual(packed, ff);
  for (const f of files.filter((x) => x.name !== 'manifest.json')) {
    assert.deepEqual(Buffer.from(f.data), readFileSync(join(EXT, ...f.name.split('/'))), f.name);
  }
});
