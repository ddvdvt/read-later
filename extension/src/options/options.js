// Settings page: import (files, URL list, browser bookmarks), export and backups, reading and
// saving preferences, storage usage, site access, deleting everything.
import { applyI18n, t } from '../shared/i18n.js';
import { wireBrandLinks } from '../shared/brand-link.js';
import { $, el, applyIcons, toast, getSettings, saveSettings, confirmDialog, uiLocale } from '../shared/ui.js';
import { getAllItems, putRecords, deleteForever, clearAll, getAllImages, updateItems } from '../shared/db.js';
import { exportJson, exportBookmarks, exportMarkdown, backupState } from '../shared/backup.js';
import { dataUrlToBlob } from '../shared/save.js';
import { parseBookmarkHtml, parseCsvExport, parseUrlList, parseOmnivore, bookmarksToRows, bookmarkFolders, detectFormat, planImport, buildImportRecord } from '../../lib/importers.js';
import { readBackup } from '../../lib/exporters.js';
import { unzip } from '../../lib/zip.js';
import { termsOf } from '../../lib/search.js';
import { viewCounts } from '../../lib/model.js';
import { formatBytes, plural } from '../../lib/settings.js';

applyI18n();
applyIcons();
wireBrandLinks();

const locale = uiLocale();
const MAX_FILE = 512 * 1024 * 1024;
$('#version').textContent = `v${chrome.runtime.getManifest().version}`;

// ------------------------------------------------------------------ settings

async function loadSettingsUi() {
  const s = /** @type {Record<string, any>} */ (await getSettings());
  document.querySelectorAll('[data-setting]').forEach((node) => {
    const input = /** @type {HTMLInputElement} */ (node);
    const key = input.getAttribute('data-setting') || '';
    if (input.type === 'checkbox') input.checked = !!s[key];
    else input.value = String(s[key]);
  });
  $('#imageCapMb').disabled = !s.saveImages;
}

document.querySelectorAll('[data-setting]').forEach((node) => {
  node.addEventListener('change', async () => {
    const input = /** @type {HTMLInputElement} */ (node);
    const key = input.getAttribute('data-setting') || '';
    const value = input.type === 'checkbox' ? input.checked : input.type === 'number' || /^(imageCapMb|backupDays)$/.test(key) ? Number(input.value) : input.value;
    await saveSettings({ [key]: value });
    await loadSettingsUi();
    toast(t('settingsSaved'));
  });
});

// ------------------------------------------------------------------ import

/** @type {null | { kind: 'rows', rows: import('../../lib/importers.js').ImportRow[], label: string } | { kind: 'backup', data: ReturnType<typeof readBackup>, label: string }} */
let pending = null;
let importing = false;

/** @param {...any} children */
function preview(...children) {
  const box = $('#preview');
  box.hidden = false;
  box.replaceChildren(...children);
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** @param {string} text */
function previewError(text) {
  preview(el('div', { class: 'banner error' }, text));
}

/**
 * Parse an import file into rows or a backup.
 * @param {File} file
 */
async function readImportFile(file) {
  if (file.size > MAX_FILE) throw new Error(t('fileTooLarge'));
  const buf = new Uint8Array(await file.arrayBuffer());
  const fmt = detectFormat(file.name, buf.subarray(0, 1024));
  if (fmt === 'zip') {
    const entries = await unzip(buf);
    const rows = parseOmnivore(entries);
    if (rows.length) return { kind: 'rows', rows, label: 'Omnivore' };
    // a ZIP with a single CSV/HTML inside (e.g. a zipped Pocket export)
    for (const e of entries) {
      const name = e.name.toLowerCase();
      const text = new TextDecoder().decode(e.data);
      if (name.endsWith('.csv')) return { kind: 'rows', rows: parseCsvExport(text), label: 'CSV' };
      if (name.endsWith('.html') || name.endsWith('.htm')) return { kind: 'rows', rows: parseBookmarkHtml(text), label: 'HTML' };
      if (name.endsWith('.json')) {
        try {
          return { kind: 'backup', data: readBackup(JSON.parse(text)), label: 'JSON' };
        } catch {
          /* try the next file */
        }
      }
    }
    return { kind: 'rows', rows: [], label: 'ZIP' };
  }
  const text = new TextDecoder().decode(buf);
  if (fmt === 'json') {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error(t('importBadJson'));
    }
    if (Array.isArray(obj)) {
      // an Omnivore metadata file on its own, or a plain list of {url,title}
      const rows = parseOmnivore([{ name: 'metadata_0.json', data: buf }]);
      return { kind: 'rows', rows: rows.length ? rows : parseUrlList(text), label: 'JSON' };
    }
    return { kind: 'backup', data: readBackup(obj), label: t('backupLabel') };
  }
  if (fmt === 'html') {
    const rows = parseBookmarkHtml(text);
    return { kind: 'rows', rows, label: rows.some((r) => r.source === 'pocket') ? 'Pocket (HTML)' : 'HTML' };
  }
  if (fmt === 'csv') {
    const rows = parseCsvExport(text);
    return { kind: 'rows', rows, label: rows.some((r) => r.source === 'pocket') ? 'Pocket (CSV)' : rows.some((r) => r.source === 'instapaper') ? 'Instapaper (CSV)' : 'CSV' };
  }
  return { kind: 'rows', rows: parseUrlList(text), label: t('urlList') };
}

/** @param {File} file */
async function handleFile(file) {
  if (importing) return;
  preview(el('p', null, el('span', { class: 'spinner' }), ' ', t('reading')));
  try {
    pending = /** @type {any} */ (await readImportFile(file));
    await showPlan();
  } catch (e) {
    pending = null;
    previewError(`${t('importFailed')}: ${String((e && /** @type {any} */ (e).message) || e)}`);
  }
}

async function showPlan() {
  if (!pending) return;
  const existing = await getAllItems();
  if (pending.kind === 'backup') {
    const d = pending.data;
    const ids = new Set(existing.map((i) => i.id));
    const fresh = d.items.filter((i) => !ids.has(i.id));
    preview(
      el('h3', null, t('previewBackupTitle')),
      el('ul', null,
        el('li', null, t('previewArticles', [String(d.items.length)])),
        el('li', null, t('previewWithText', [String(d.contents.length)])),
        el('li', null, t('previewHighlights', [String(d.highlights.length)])),
        el('li', null, t('previewBackupNew', [String(fresh.length)])),
      ),
      el('p', { class: 'muted' }, t('previewBackupNote')),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'primary', id: 'importGo', onclick: runImport }, t('restoreGo')),
        el('button', { type: 'button', onclick: cancelPlan }, t('cancel')),
      ),
    );
    return;
  }
  const rows = pending.rows;
  if (!rows.length) {
    previewError(t('importNothing'));
    pending = null;
    return;
  }
  const plan = planImport(existing, rows);
  const withText = plan.creates.filter((r) => r.html).length;
  const archived = plan.creates.filter((r) => r.status === 'archived').length;
  const tags = new Set(plan.creates.flatMap((r) => r.tags || []));
  preview(
    el('h3', null, t('previewTitle', [pending.label])),
    el('ul', null,
      el('li', null, t('previewFound', [String(rows.length)])),
      el('li', null, t('previewNew', [String(plan.creates.length)])),
      withText ? el('li', null, t('previewWithText', [String(withText)])) : null,
      archived ? el('li', null, t('previewArchived', [String(archived)])) : null,
      tags.size ? el('li', null, t('previewTags', [String(tags.size)])) : null,
      plan.duplicates ? el('li', null, t('previewDuplicates', [String(plan.duplicates)])) : null,
    ),
    plan.creates.length - withText > 0 ? el('p', { class: 'muted' }, t('previewLinksNote')) : null,
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'primary', id: 'importGo', onclick: runImport, disabled: !plan.creates.length && !plan.updates.length }, t('importGo', [String(plan.creates.length)])),
      el('button', { type: 'button', onclick: cancelPlan }, t('cancel')),
    ),
  );
}

function cancelPlan() {
  pending = null;
  $('#preview').hidden = true;
  $('#file').value = '';
}

async function runImport() {
  if (!pending || importing) return;
  importing = true;
  const bar = el('i');
  const label = el('span', null, t('importing'));
  preview(el('p', null, el('span', { class: 'spinner' }), ' ', label), el('div', { class: 'progress' }, bar));
  try {
    const result = pending.kind === 'backup' ? await restoreBackup(pending.data, (d, n) => progress(d, n)) : await importRows(pending.rows, (d, n) => progress(d, n));
    pending = null;
    $('#file').value = '';
    const links = result.links;
    preview(
      el('h3', null, '✓ ', t('importDone', [String(result.added)])),
      result.updated ? el('p', null, t('importUpdated', [String(result.updated)])) : null,
      links ? el('p', null, t('importLinksDone', [String(links)])) : null,
      el('div', { class: 'actions' },
        el('a', { class: 'btn primary', href: '../library/library.html#view=all' }, t('openLibrary')),
        links ? el('a', { class: 'btn', href: '../library/library.html#view=all&content=link' }, t('showLinks')) : null,
      ),
    );
    refreshStats();
  } catch (e) {
    previewError(`${t('importFailed')}: ${String((e && /** @type {any} */ (e).message) || e)}`);
  } finally {
    importing = false;
  }
  /** @param {number} done @param {number} total */
  function progress(done, total) {
    bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    label.textContent = t('importingProgress', [String(done), String(total)]);
  }
}

/**
 * @param {import('../../lib/importers.js').ImportRow[]} rows
 * @param {(done: number, total: number) => void} onProgress
 */
async function importRows(rows, onProgress) {
  const existing = await getAllItems();
  const plan = planImport(existing, rows);
  const total = plan.creates.length + plan.updates.length;
  let done = 0;
  let links = 0;
  const now = Date.now();
  for (let i = 0; i < plan.creates.length; i += 200) {
    const chunk = plan.creates.slice(i, i + 200).map((r, k) => buildImportRecord(r, now + i + k));
    links += chunk.filter((r) => !r.content).length;
    await putRecords(chunk);
    done += chunk.length;
    onProgress(done, total);
    await new Promise((r) => setTimeout(r, 0));
  }
  // URLs already in the library: add tags / favorite, or text when the export had it
  const byId = new Map(existing.map((i) => [i.id, i]));
  let updated = 0;
  for (const u of plan.updates) {
    const ex = byId.get(u.id);
    if (!ex) continue;
    if (u.row.html && ex.content !== 'full') {
      const rec = buildImportRecord(u.row, now);
      const item = { ...ex, content: rec.item.content, words: rec.item.words, tags: [...new Set([...ex.tags, ...(u.row.tags || [])])], favorite: ex.favorite || !!u.row.favorite, updatedAt: now };
      await putRecords([{ item, content: rec.content ? { ...rec.content, id: ex.id } : null, terms: termsOf({ ...item, text: rec.content ? rec.content.text : '' }), highlights: rec.highlights ? rec.highlights.map((h) => ({ ...h, itemId: ex.id })) : null }]);
    } else {
      await updateItems([ex.id], (it) => ({ ...it, tags: [...new Set([...it.tags, ...(u.row.tags || [])])], favorite: it.favorite || !!u.row.favorite, updatedAt: now }));
    }
    updated++;
    done++;
    onProgress(done, total);
  }
  return { added: plan.creates.length, updated, links };
}

/**
 * Restore a JSON backup: items missing here are added; items present here are replaced only
 * when the copy in the backup is newer.
 * @param {ReturnType<typeof readBackup>} d
 * @param {(done: number, total: number) => void} onProgress
 */
async function restoreBackup(d, onProgress) {
  const existing = new Map((await getAllItems()).map((i) => [i.id, i]));
  const contents = new Map(d.contents.map((c) => [c.id, c]));
  /** @type {Map<string, any[]>} */
  const hl = new Map();
  for (const h of d.highlights) hl.set(h.itemId, [...(hl.get(h.itemId) || []), h]);
  /** @type {Map<string, Array<{ url: string, blob: Blob }>>} */
  const imgs = new Map();
  for (const im of d.images) {
    const blob = dataUrlToBlob(`data:${im.type};base64,${im.data}`);
    if (blob) imgs.set(im.itemId, [...(imgs.get(im.itemId) || []), { url: im.url, blob }]);
  }
  const todo = d.items.filter((it) => {
    const ex = existing.get(it.id);
    return !ex || it.updatedAt > ex.updatedAt;
  });
  let done = 0;
  let added = 0;
  let updated = 0;
  let links = 0;
  for (let i = 0; i < todo.length; i += 100) {
    const recs = todo.slice(i, i + 100).map((item) => {
      if (existing.has(item.id)) updated++;
      else added++;
      const c = contents.get(item.id);
      if (!c) links++;
      return { item, content: c || null, terms: termsOf({ ...item, text: c ? c.text : '' }), highlights: hl.get(item.id) || null, images: imgs.get(item.id) || null };
    });
    await putRecords(recs);
    done += recs.length;
    onProgress(done, todo.length);
  }
  if (d.settings) await saveSettings(/** @type {any} */ (d.settings));
  await loadSettingsUi();
  return { added, updated, links };
}

const drop = $('#drop');
drop.addEventListener('click', () => $('#file').click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    $('#file').click();
  }
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
$('#file').addEventListener('change', () => {
  const f = $('#file').files?.[0];
  if (f) handleFile(f);
});
$('#urlsGo').addEventListener('click', async () => {
  pending = { kind: 'rows', rows: parseUrlList($('#urls').value), label: t('urlList') };
  await showPlan();
});

// bookmarks (optional permission, requested here and released after the import)
/** @type {any[] | null} */
let bmTree = null;
$('#bmLoad').addEventListener('click', async () => {
  let ok = false;
  try {
    ok = await chrome.permissions.request({ permissions: ['bookmarks'] });
  } catch {
    ok = false;
  }
  if (!ok) {
    toast(t('permissionDenied'));
    return;
  }
  bmTree = await chrome.bookmarks.getTree();
  const folders = bookmarkFolders(bmTree);
  $('#bmFolder').replaceChildren(...folders.map((f) => el('option', { value: f.id }, `${'— '.repeat(f.depth)}${f.title || '…'} (${f.count})`)));
  $('#bmPick').hidden = false;
  $('#bmLoad').hidden = true;
});
$('#bmGo').addEventListener('click', async () => {
  const id = $('#bmFolder').value;
  if (!id) return;
  const sub = await chrome.bookmarks.getSubTree(id);
  pending = { kind: 'rows', rows: bookmarksToRows(sub, { folderTags: $('#bmTags').checked }), label: t('bookmarksLabel') };
  await showPlan();
  // the folder is read: give the permission back
  try {
    await chrome.permissions.remove({ permissions: ['bookmarks'] });
  } catch {
    /* ignore */
  }
  bmTree = null;
  $('#bmPick').hidden = true;
  $('#bmLoad').hidden = false;
});

// ------------------------------------------------------------------ export

/** @param {string} sel @param {() => Promise<number>} fn */
function exportButton(sel, fn) {
  $(sel).addEventListener('click', async () => {
    const b = $(sel);
    b.disabled = true;
    try {
      const n = await fn();
      toast(t('exportDone', [String(n)]));
      refreshBackupInfo();
    } catch (e) {
      toast(`${t('exportFailed')}: ${String((e && /** @type {any} */ (e).message) || e)}`);
    } finally {
      b.disabled = false;
    }
  });
}
exportButton('#exJson', () => exportJson({ images: $('#withImages').checked }));
exportButton('#exHtml', exportBookmarks);
exportButton('#exMd', exportMarkdown);

async function refreshBackupInfo() {
  const s = await backupState();
  $('#lastBackup').textContent = s.lastBackupAt ? t('lastBackup', [new Date(s.lastBackupAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })]) : t('noBackupYet');
}

// ------------------------------------------------------------------ storage and access

async function refreshStats() {
  const items = await getAllItems();
  const c = viewCounts(items);
  const images = await getAllImages();
  const imgBytes = images.reduce((s, i) => s + (i.size || 0), 0);
  /** @type {StorageEstimate} */
  let est = {};
  let persisted = false;
  try {
    est = await navigator.storage.estimate();
    persisted = await navigator.storage.persisted();
  } catch {
    /* unavailable */
  }
  const row = (k, v) => [el('dt', null, k), el('dd', null, v)];
  $('#stats').replaceChildren(
    ...row(t('statArticles'), `${c.all} (${t('statUnread', [String(c.unread)])}, ${t('statArchive', [String(c.archive)])})`),
    ...row(t('statLinks'), String(c.links)),
    ...row(t('statImages'), `${images.length} · ${formatBytes(imgBytes, locale)}`),
    ...row(t('statTrash'), String(c.trash)),
    ...row(t('statUsage'), est.usage !== undefined ? `${formatBytes(est.usage || 0, locale)}${est.quota ? ` / ${formatBytes(est.quota, locale)}` : ''}` : '—'),
    ...row(t('statPersistent'), persisted ? t('yes') : t('statPersistentNo')),
  );
  $('#emptyTrash').disabled = !c.trash;
}

$('#emptyTrash').addEventListener('click', async () => {
  const ids = (await getAllItems()).filter((i) => i.deletedAt).map((i) => i.id);
  if (!ids.length) return;
  if (!(await confirmDialog(t('confirmDeleteForever', [String(ids.length)]), { ok: t('deleteForever'), danger: true }))) return;
  await deleteForever(ids);
  toast(t('doneDeleted', [String(ids.length)]));
  refreshStats();
});

async function refreshAccess() {
  const all = await chrome.permissions.getAll();
  const origins = (all.origins || []).filter((o) => /^https?:/.test(o) || o === '<all_urls>');
  const hasBookmarks = (all.permissions || []).includes('bookmarks');
  const parts = [];
  if (origins.length) parts.push(t('hostAccessSome', [origins.slice(0, 5).join(', ') + (origins.length > 5 ? '…' : '')]));
  if (hasBookmarks) parts.push(t('bookmarksAccess'));
  $('#hostAccess').textContent = parts.length ? parts.join(' ') : t('hostAccessNone');
  $('#revokeHosts').hidden = !parts.length;
}
$('#revokeHosts').addEventListener('click', async () => {
  const all = await chrome.permissions.getAll();
  try {
    await chrome.permissions.remove({ origins: all.origins || [], permissions: (all.permissions || []).filter((p) => p === 'bookmarks') });
  } catch {
    /* declared permissions cannot be removed */
  }
  refreshAccess();
});
chrome.permissions.onAdded.addListener(refreshAccess);
chrome.permissions.onRemoved.addListener(refreshAccess);

$('#wipe').addEventListener('click', async () => {
  const items = await getAllItems();
  const n = items.length;
  if (!(await confirmDialog(t('confirmWipe', [plural(n, t('articlesPlural'), locale)]), { ok: t('wipeAll'), danger: true }))) return;
  await clearAll();
  await chrome.storage.local.clear();
  await loadSettingsUi();
  refreshStats();
  refreshBackupInfo();
  toast(t('wiped'));
});

// ------------------------------------------------------------------ shortcut

async function refreshShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === 'save-page');
    $('#shortcut').textContent = (c && c.shortcut) || t('shortcutNone');
  } catch {
    /* ignore */
  }
}
$('#shortcutBtn').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

loadSettingsUi();
refreshBackupInfo();
refreshStats();
refreshAccess();
refreshShortcut();
document.body.dataset.ready = '1';
