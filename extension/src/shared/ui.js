// Small DOM helpers shared by the popup, library, reader and settings pages.
import { ensureSettings } from '../../lib/settings.js';
import { t } from './i18n.js';

/** @param {string} sel @param {ParentNode} [root] @returns {any} */
export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Element builder: el('a', { href, class: 'x', onclick }, 'text', child).
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...any} children
 * @returns {any}
 */
export function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'html') e.innerHTML = v; // only for trusted, extension-generated markup (icons)
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

const ICONS = {
  save: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  archive: '<path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4"/>',
  unarchive: '<path d="M3 4h18v4H3zM5 8v12h14V8M12 18v-7M9 14l3-3 3 3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM8 8h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  settings: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  type: '<path d="M4 20 9 6l5 14M5.8 15h6.4M15 20l3-8 3 8M15.8 18h4.4"/>',
  highlight: '<path d="m9 11 6-6 4 4-6 6M9 11l-4 4v4h4l4-4M9 11l4 4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  note: '<path d="M4 4h16v12l-4 4H4zM16 20v-4h4M8 9h8M8 13h5"/>',
  copy: '<path d="M9 9h11v11H9zM5 15H4V4h11v1"/>',
  tabs: '<path d="M3 7h18v13H3zM3 7l2-3h6l2 3"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
};

/**
 * Inline SVG icon (stroke style).
 * @param {keyof typeof ICONS} name
 * @param {boolean} [filled]
 */
export function icon(name, filled = false) {
  return `<svg viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/** Replace [data-icon] placeholders with SVG icons. @param {ParentNode} [root] */
export function applyIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((e) => {
    if (e.querySelector('svg')) return;
    e.insertAdjacentHTML('afterbegin', icon(/** @type {any} */ (e.getAttribute('data-icon'))));
  });
}

let toastTimer = 0;
/**
 * Bottom toast with an optional action button.
 * @param {string} text
 * @param {{ action?: string, onAction?: () => void, ms?: number }} [opts]
 */
export function toast(text, opts = {}) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const box = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, el('span', null, text));
  if (opts.action && opts.onAction) {
    box.append(
      el('button', {
        type: 'button',
        onclick: () => {
          box.remove();
          opts.onAction && opts.onAction();
        },
      }, opts.action),
    );
  }
  document.body.append(box);
  toastTimer = setTimeout(() => box.remove(), opts.ms || (opts.action ? 7000 : 3000));
}

/** UI locale ("ru", "en"). */
export function uiLocale() {
  try {
    return chrome.i18n.getUILanguage().slice(0, 2) === 'ru' ? 'ru' : 'en';
  } catch {
    return 'ru';
  }
}

/** @param {number} ts */
export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const opts = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleDateString(uiLocale(), /** @type {any} */ (opts));
}

/** "5 мин" @param {number} minutes */
export function formatMinutes(minutes) {
  return minutes ? t('minutesShort', [String(minutes)]) : '';
}

/** @returns {Promise<import('../../lib/settings.js').Settings>} */
export async function getSettings() {
  const r = await chrome.storage.local.get('settings');
  return ensureSettings(r.settings);
}

/** @param {Partial<import('../../lib/settings.js').Settings>} patch */
export async function saveSettings(patch) {
  const next = ensureSettings({ ...(await getSettings()), ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** @param {(s: import('../../lib/settings.js').Settings) => void} cb */
export function onSettingsChange(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) cb(ensureSettings(changes.settings.newValue));
  });
}

/**
 * Save bytes/text as a file from an extension page (no "downloads" permission needed).
 * @param {BlobPart} data
 * @param {string} filename
 * @param {string} mime
 */
export function downloadFile(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** YYYY-MM-DD of today, for file names. */
export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Copy text to the clipboard. @param {string} text */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Promise-based confirm dialog (keyboard accessible, uses <dialog>).
 * @param {string} text
 * @param {{ ok?: string, cancel?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(text, opts = {}) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'confirm' },
      el('p', { style: 'margin:0 0 4px;white-space:pre-line' }, text),
      el('div', { class: 'actions' },
        el('button', { type: 'button', value: 'cancel', onclick: () => dlg.close('cancel') }, opts.cancel || t('cancel')),
        el('button', { type: 'button', class: opts.danger ? 'primary danger-fill' : 'primary', onclick: () => dlg.close('ok') }, opts.ok || 'OK'),
      ),
    );
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
    /** @type {HTMLButtonElement} */ (dlg.querySelector('button.primary')).focus();
  });
}
