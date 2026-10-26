// Service worker: context menus, the keyboard shortcut, saving requested by the popup,
// trash clean-up, welcome / uninstall pages of the brand site.
import { brandUrls, welcomeUrlFor } from '../lib/brand.js';
import { isSavableUrl } from '../lib/url.js';
import { captureTab, storeCapture, saveLink, loadSettings, imageBudget } from './shared/save.js';
import { purgeTrash } from './shared/db.js';

const MENU_PAGE = 'rl-save-page';
const MENU_LINK = 'rl-save-link';
const MENU_LIBRARY = 'rl-open-library';

/** @param {string} key @param {string} fallback @param {string[]} [subs] */
const msg = (key, fallback, subs) => {
  try {
    return chrome.i18n.getMessage(key, subs) || fallback;
  } catch {
    return fallback;
  }
};

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_PAGE, title: msg('menuSavePage', 'Сохранить страницу для чтения'), contexts: ['page', 'selection', 'image'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
    chrome.contextMenus.create({ id: MENU_LINK, title: msg('menuSaveLink', 'Сохранить ссылку для чтения'), contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] });
    chrome.contextMenus.create({ id: MENU_LIBRARY, title: msg('menuOpenLibrary', 'Открыть библиотеку'), contexts: ['action'] });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  purgeTrash().catch(() => {});
  const url = welcomeUrlFor(details && details.reason);
  if (url) chrome.tabs.create({ url }).catch(() => {});
});

// Page shown after the extension is removed (no data is sent: it is a plain static page).
try {
  chrome.runtime.setUninstallURL(brandUrls().bye).catch(() => {});
} catch {
  /* not available in this context */
}

chrome.runtime.onStartup.addListener(() => {
  createMenus();
  purgeTrash().catch(() => {});
});

/**
 * Small confirmation inside the page (injected function; must be self-contained).
 * @param {string} text
 * @param {string} kind ok | warn | error
 */
function pageToast(text, kind) {
  try {
    const id = 'read-later-toast-host';
    document.getElementById(id)?.remove();
    const host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:0;bottom:0;';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    const bg = kind === 'error' ? '#8a1c0d' : kind === 'warn' ? '#6b4e00' : '#1a1712';
    box.style.cssText = `position:fixed;right:20px;bottom:20px;max-width:360px;padding:12px 16px;border-radius:8px;background:${bg};color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);transition:opacity .3s;opacity:0`;
    box.setAttribute('role', 'status');
    box.textContent = text;
    root.appendChild(box);
    document.documentElement.appendChild(host);
    requestAnimationFrame(() => (box.style.opacity = '1'));
    setTimeout(() => {
      box.style.opacity = '0';
      setTimeout(() => host.remove(), 400);
    }, 2600);
  } catch {
    /* never break the page */
  }
}

/** @param {number | undefined} tabId @param {string} text @param {'ok' | 'warn' | 'error'} kind */
async function feedback(tabId, text, kind) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: kind === 'error' ? '#c2341a' : '#1a7f37' });
    await chrome.action.setBadgeText({ text: kind === 'error' ? '!' : '✓', tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 3000);
  } catch {
    /* tab closed */
  }
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pageToast, args: [text, kind] });
  } catch {
    /* page not scriptable: the badge is enough */
  }
}

/**
 * Save the page in a tab the user acted on (activeTab is granted by the click / shortcut).
 * @param {chrome.tabs.Tab} tab
 */
async function savePage(tab) {
  if (!tab || tab.id == null) return { ok: false, error: 'no-tab' };
  if (!isSavableUrl(tab.url || '')) {
    await feedback(tab.id, msg('errNotSavable', 'Эту страницу нельзя сохранить'), 'error');
    return { ok: false, error: 'not-savable' };
  }
  try {
    const settings = await loadSettings();
    const cap = await captureTab(tab.id, imageBudget(settings));
    const r = await storeCapture({ ...cap, url: cap.url || tab.url, title: cap.title || tab.title }, { source: 'page' });
    const text = !r.created ? msg('toastUpdated', 'Уже было в списке — текст обновлён') : r.hasText ? msg('toastSaved', 'Сохранено для чтения') : msg('toastSavedLink', 'Сохранено как ссылка: текст статьи не найден');
    await feedback(tab.id, text, r.hasText ? 'ok' : 'warn');
    return { ok: true, id: r.item.id, created: r.created, hasText: r.hasText };
  } catch (e) {
    // The page could not be read (e.g. the PDF viewer): keep at least the link.
    try {
      const r = await saveLink(tab.url || '', tab.title);
      if (r) {
        await feedback(tab.id, msg('toastSavedLink', 'Сохранено как ссылка: текст статьи не найден'), 'warn');
        return { ok: true, id: r.item.id, created: r.created, hasText: false };
      }
    } catch {
      /* storage error, reported below */
    }
    await feedback(tab.id, msg('errSave', 'Не удалось сохранить'), 'error');
    return { ok: false, error: String((e && /** @type {any} */ (e).message) || e) };
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_LIBRARY) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/library/library.html') }).catch(() => {});
    return;
  }
  if (info.menuItemId === MENU_PAGE && tab) {
    await savePage(tab);
    return;
  }
  if (info.menuItemId === MENU_LINK && info.linkUrl) {
    try {
      const title = (info.selectionText || '').trim();
      const r = await saveLink(info.linkUrl, title.length > 3 ? title : '');
      await feedback(tab && tab.id, r ? (r.created ? msg('toastLinkSaved', 'Ссылка сохранена. Текст можно загрузить в библиотеке') : msg('toastAlready', 'Эта ссылка уже в списке')) : msg('errNotSavable', 'Эту страницу нельзя сохранить'), r ? 'ok' : 'error');
    } catch {
      await feedback(tab && tab.id, msg('errSave', 'Не удалось сохранить'), 'error');
    }
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'save-page') {
    const t = tab && tab.id != null ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (t) await savePage(t);
  } else if (command === 'open-library') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/library/library.html') }).catch(() => {});
  }
});

// The popup asks the worker to save, so the save finishes even if the popup closes.
chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m || sender.id !== chrome.runtime.id) return false;
  if (m.type === 'save-tab' && typeof m.tabId === 'number') {
    chrome.tabs
      .get(m.tabId)
      .then((tab) => savePage(tab))
      .then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});
