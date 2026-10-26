// Packs extension/ into dist/read-later-<version>.zip for the Chrome Web Store (no dependencies)
// and verifies the archive: it opens, manifest.json is at the root, every locale is present,
// paths use forward slashes, there are no dotfiles, tests or node_modules, CRCs match.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, readZip, crc32 } from '../extension/lib/zip.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'Thumbs.db' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ name: relative(ext, p).split(sep).join('/'), data: new Uint8Array(readFileSync(p)) });
  }
})(ext);
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `read-later-${manifest.version}.zip`);
const zip = createZip(files);
writeFileSync(out, zip);

// verify what was written
const entries = readZip(new Uint8Array(readFileSync(out)));
const names = entries.map((e) => e.name);
const fail = (m) => {
  console.error(`zip check failed: ${m}`);
  process.exit(1);
};
if (!names.includes('manifest.json')) fail('manifest.json is not at the root');
for (const l of readdirSync(join(ext, '_locales'))) if (!names.includes(`_locales/${l}/messages.json`)) fail(`locale ${l} missing`);
for (const n of names) {
  if (n.includes('\')) fail(`backslash in ${n}`);
  if (n.split('/').some((p) => p.startsWith('.'))) fail(`dotfile ${n}`);
  if (/(^|\/)(node_modules|test|e2e)\//.test(n)) fail(`dev file ${n}`);
}
for (const e of entries) if (crc32(e.data) !== e.crc) fail(`crc mismatch in ${e.name}`);
const referenced = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, ...Object.values(manifest.icons)];
for (const r of referenced) if (!names.includes(r)) fail(`${r} referenced by the manifest is missing`);
console.log(`${files.length} files, ${(zip.length / 1024).toFixed(1)} KB -> ${out} (verified)`);
