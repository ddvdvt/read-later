// Popup: save the current page, save several selected tabs, recent items, open the library.
import { applyI18n, t } from '../shared/i18n.js';
import { wireBrandLinks } from '../shared/brand-link.js';
import { $, el, applyIcons, formatMinutes, getSettings } from '../shared/ui.js';
import { getAllItems, findByUrl, actOn } from '../shared/db.js';
import { isSavableUrl, normalizeUrl, displayHost } from '../../lib/url.js';
import { viewCounts, itemMinutes, sortItems } from '../../lib/model.js';

applyI18n();
applyIcons();
wireBrandLinks();

const params = new URLSearchParams(location.search);
const readerUrl = (id) => chrome.runtime.getURL(`src/reader/reader.html?id=${encodeURIComponent(id)}`);

/** @type {chrome.tabs.Tab | null} */
let tab = null;
/** @type {string | null} */
let savedId = null;

function status(text, kind = 'ok', busy = false) {
  const s = $('#status');
  s.hidden = !text;
  s.className = `status ${kind}`;
  s.replaceChildren(...(busy ? [el('span', { class: 'spinner' })] : []), el('span', null, text));
}

function showSaved(id) {
  savedId = id;
  $('#savedActions').hidden = false;
  $('#readNow').href = readerUrl(id);
  $('#saveLabel').textContent = t('saveAgain');
}

async function renderRecent() {
  const items = await getAllItems();
  const counts = viewCounts(items);
  $('#libraryLabel').textContent = counts.unread ? t('openLibraryCount', [String(counts.unread)]) : t('openLibrary');
  const recent = sortItems(items.filter((i) => !i.deletedAt && i.status === 'unread'), 'newest').slice(0, 5);
  const settings = await getSettings();
  $('#recent').replaceChildren(
    ...recent.map((i) =>
      el('li', null,
        el('a', { href: readerUrl(i.id), target: '_blank' },
          el('span', { class: 't' }, i.title),
          el('span', { class: 'm' }, [i.site, i.content === 'full' ? formatMinutes(itemMinutes(i, settings.wpm)) : t('linkOnly')].filter(Boolean).join(' · ')),
        ),
      ),
    ),
  );
  $('#recentEmpty').hidden = recent.length > 0;
}

async function init() {
  const tabId = Number(params.get('tabId')) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  try {
    tab = tabId ? await chrome.tabs.get(tabId) : null;
  } catch {
    tab = null;
  }
  const url = (tab && tab.url) || '';
  $('#pageTitle').textContent = (tab && tab.title) || t('noPage');
  $('#pageHost').textContent = displayHost(url);
  if (!isSavableUrl(url)) {
    status(t('errNotSavableHint'), 'warn');
  } else {
    $('#saveBtn').disabled = false;
    const existing = await findByUrl(normalizeUrl(url));
    if (existing && !existing.deletedAt) {
      showSaved(existing.id);
      status(existing.status === 'archived' ? t('alreadyArchived') : t('alreadySaved'), 'ok');
    }
  }
  // several tabs selected (Ctrl/Shift+click on tabs) → offer to save them all
  try {
    const selected = await chrome.tabs.query({ highlighted: true, currentWindow: true });
    if (selected.length > 1) {
      const b = $('#saveTabs');
      b.hidden = false;
      $('#saveTabsLabel').textContent = t('saveSelectedTabs', [String(selected.length)]);
      b.addEventListener('click', () => {
        const ids = selected.map((s) => s.id).join(',');
        chrome.tabs.create({ url: chrome.runtime.getURL(`src/library/library.html?saveTabs=${ids}`) });
        window.close();
      });
    }
  } catch {
    /* ignore */
  }
  await renderRecent();
  document.body.dataset.ready = '1';
}

$('#saveBtn').addEventListener('click', async () => {
  if (!tab || tab.id == null) return;
  const btn = $('#saveBtn');
  btn.disabled = true;
  status(t('saving'), 'ok', true);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'save-tab', tabId: tab.id });
    if (!r || !r.ok) throw new Error((r && r.error) || 'save failed');
    showSaved(r.id);
    status(!r.created ? t('toastUpdated') : r.hasText ? t('toastSaved') : t('toastSavedLink'), r.hasText ? 'ok' : 'warn');
    await renderRecent();
    const settings = await getSettings();
    if (settings.openAfterSave && r.hasText) {
      chrome.tabs.create({ url: readerUrl(r.id) });
      window.close();
    }
  } catch (e) {
    status(`${t('errSave')}: ${String((e && /** @type {any} */ (e).message) || e)}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#archiveNow').addEventListener('click', async () => {
  if (!savedId) return;
  await actOn([savedId], 'archive');
  status(t('movedToArchive'), 'ok');
  await renderRecent();
});

// Links with target=_blank in a popup: open in a tab and close the popup.
document.addEventListener('click', (e) => {
  const a = /** @type {HTMLElement} */ (e.target).closest('a[target="_blank"]');
  if (!a || !(/** @type {HTMLAnchorElement} */ (a).href) || /** @type {HTMLAnchorElement} */ (a).getAttribute('href') === '#') return;
  e.preventDefault();
  chrome.tabs.create({ url: /** @type {HTMLAnchorElement} */ (a).href });
  window.close();
});

init().catch((e) => {
  status(`${t('errLoad')}: ${String((e && e.message) || e)}`, 'error');
  document.body.dataset.ready = '0';
});
