// Export / backup helpers used by the library (reminder banner) and the settings page.
import { makeBackup, bookmarksHtml, markdownFiles } from '../../lib/exporters.js';
import { createZip } from '../../lib/zip.js';
import { getAllItems, getAllHighlights, getAllImages, getContents, getMeta, setMeta } from './db.js';
import { downloadFile, stamp, getSettings } from './ui.js';
import { t } from './i18n.js';

/** @param {Blob} blob @returns {Promise<string>} base64 without the data: prefix */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Full JSON backup → file download. Marks the backup time for the reminder.
 * @param {{ images?: boolean }} [opts]
 */
export async function exportJson(opts = {}) {
  const items = await getAllItems();
  const contents = await getContents(items.map((i) => i.id));
  const highlights = await getAllHighlights();
  const images = [];
  if (opts.images) {
    for (const im of await getAllImages()) images.push({ itemId: im.itemId, url: im.url, type: im.blob.type, data: await blobToBase64(im.blob) });
  }
  const backup = makeBackup({ items, contents, highlights, settings: /** @type {any} */ (await getSettings()), images, appVersion: chrome.runtime.getManifest().version });
  downloadFile(JSON.stringify(backup), `read-later-backup-${stamp()}.json`, 'application/json');
  await setMeta('backup', { lastBackupAt: Date.now() });
  return items.length;
}

/** Netscape bookmarks HTML → file download. */
export async function exportBookmarks() {
  const items = await getAllItems();
  const html = bookmarksHtml(items, { title: t('appName'), unread: t('viewUnread'), archive: t('viewArchive') });
  downloadFile(html, `read-later-bookmarks-${stamp()}.html`, 'text/html;charset=utf-8');
  return items.filter((i) => !i.deletedAt).length;
}

/** Markdown per article in a ZIP → file download. */
export async function exportMarkdown() {
  const items = (await getAllItems()).filter((i) => !i.deletedAt);
  const contents = await getContents(items.map((i) => i.id));
  const highlights = await getAllHighlights();
  const files = markdownFiles(items, contents, highlights, { highlights: t('highlightsTitle'), savedAsLink: t('savedAsLink'), index: t('appName') });
  downloadFile(new Blob([createZip(files)], { type: 'application/zip' }), `read-later-markdown-${stamp()}.zip`, 'application/zip');
  return items.length;
}

/** State for the backup reminder. */
export async function backupState() {
  const changes = (await getMeta('changes')) || {};
  const backup = (await getMeta('backup')) || {};
  return {
    lastBackupAt: /** @type {number | null} */ (backup.lastBackupAt || null),
    snoozedUntil: /** @type {number | null} */ (backup.snoozedUntil || null),
    firstChangeAt: /** @type {number | null} */ (changes.firstChangeAt || null),
    lastChangeAt: /** @type {number | null} */ (changes.lastChangeAt || null),
  };
}

/** Hide the reminder for a few days. @param {number} days */
export async function snoozeBackup(days) {
  const backup = (await getMeta('backup')) || {};
  await setMeta('backup', { ...backup, snoozedUntil: Date.now() + days * 24 * 60 * 60 * 1000 });
}
