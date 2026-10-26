// Tiny i18n helper over chrome.i18n. HTML keeps Russian defaults, so a missing key never blanks the UI.

/** @param {string} key @param {string|string[]} [subs] */
export function t(key, subs) {
  try {
    return (globalThis.chrome && chrome.i18n && chrome.i18n.getMessage(key, subs)) || key;
  } catch {
    return key;
  }
}

/** Apply translations to [data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria]. */
export function applyI18n(root = document) {
  const get = (k) => {
    try {
      return chrome.i18n.getMessage(k);
    } catch {
      return '';
    }
  };
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = get(el.getAttribute('data-i18n'));
    if (v) el.textContent = v;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const v = get(el.getAttribute('data-i18n-placeholder'));
    if (v) el.setAttribute('placeholder', v);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const v = get(el.getAttribute('data-i18n-title'));
    if (v) el.setAttribute('title', v);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const v = get(el.getAttribute('data-i18n-aria'));
    if (v) el.setAttribute('aria-label', v);
  });
  try {
    document.documentElement.lang = chrome.i18n.getMessage('@@ui_locale').slice(0, 2) || 'ru';
  } catch {
    /* ignore */
  }
}
