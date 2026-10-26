// Settings with defaults and validation, backup-reminder logic, small formatting helpers.

/**
 * @typedef {object} Settings
 * @property {'serif' | 'sans' | 'mono' | 'system'} font
 * @property {number} fontSize       px, 14..28
 * @property {number} lineHeight     1.3..2.0
 * @property {'narrow' | 'medium' | 'wide'} width
 * @property {'auto' | 'light' | 'sepia' | 'dark'} theme
 * @property {'left' | 'justify'} align
 * @property {number} wpm            reading speed, words per minute
 * @property {boolean} saveImages    keep images for offline reading
 * @property {number} imageCapMb     per-article image budget, MB
 * @property {boolean} remoteImages  show images from the original site when not saved
 * @property {boolean} autoArchive   archive an article when it is read to the end
 * @property {number} backupDays     remind to back up after N days (0 = never)
 * @property {'list' | 'grid'} layout
 * @property {string} sort
 * @property {boolean} openAfterSave open the reader right after saving from the popup
 */

/** @type {Settings} */
export const DEFAULTS = {
  font: 'serif',
  fontSize: 19,
  lineHeight: 1.6,
  width: 'medium',
  theme: 'auto',
  align: 'left',
  wpm: 200,
  saveImages: true,
  imageCapMb: 5,
  remoteImages: true,
  autoArchive: false,
  backupDays: 14,
  layout: 'list',
  sort: 'newest',
  openAfterSave: false,
};

const ENUMS = {
  font: ['serif', 'sans', 'mono', 'system'],
  width: ['narrow', 'medium', 'wide'],
  theme: ['auto', 'light', 'sepia', 'dark'],
  align: ['left', 'justify'],
  layout: ['list', 'grid'],
  sort: ['newest', 'oldest', 'title', 'site', 'shortest', 'longest', 'progress'],
};

/** @param {unknown} v @param {number} min @param {number} max @param {number} def */
function num(v, min, max, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/**
 * @param {unknown} raw
 * @returns {Settings}
 */
export function ensureSettings(raw) {
  const r = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {});
  /** @type {any} */
  const s = { ...DEFAULTS };
  for (const [k, list] of Object.entries(ENUMS)) if (list.includes(r[k])) s[k] = r[k];
  s.fontSize = Math.round(num(r.fontSize, 14, 28, DEFAULTS.fontSize));
  s.lineHeight = Math.round(num(r.lineHeight, 1.3, 2, DEFAULTS.lineHeight) * 10) / 10;
  s.wpm = Math.round(num(r.wpm, 80, 600, DEFAULTS.wpm));
  s.imageCapMb = [1, 2, 5, 10, 20].includes(Number(r.imageCapMb)) ? Number(r.imageCapMb) : DEFAULTS.imageCapMb;
  s.backupDays = [0, 7, 14, 30].includes(Number(r.backupDays)) ? Number(r.backupDays) : DEFAULTS.backupDays;
  for (const k of ['saveImages', 'remoteImages', 'autoArchive', 'openAfterSave']) if (typeof r[k] === 'boolean') s[k] = r[k];
  return s;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Should the library show "save a backup" reminder?
 * Only when something changed since the last backup and the interval has passed
 * (counted from the last backup, or from the first change when there was none).
 * @param {{ lastBackupAt: number | null, firstChangeAt: number | null, lastChangeAt: number | null, snoozedUntil?: number | null }} s
 * @param {number} days 0 → never
 * @param {number} [now]
 */
export function needsBackupReminder(s, days, now = Date.now()) {
  if (!days || !s.lastChangeAt) return false;
  if (s.snoozedUntil && now < s.snoozedUntil) return false;
  if (s.lastBackupAt && s.lastChangeAt <= s.lastBackupAt) return false;
  const from = s.lastBackupAt || s.firstChangeAt || s.lastChangeAt;
  return now - from >= days * DAY;
}

/**
 * Human-readable size.
 * @param {number} bytes
 * @param {string} [locale]
 */
export function formatBytes(bytes, locale = 'ru') {
  const ru = locale.startsWith('ru');
  const units = ru ? ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, Number(bytes) || 0);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const n = u === 0 ? Math.round(v) : v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  return `${n.toLocaleString(locale)} ${units[u]}`;
}

/**
 * Russian plural form index: 0 → "статья", 1 → "статьи", 2 → "статей".
 * @param {number} n
 */
export function ruPlural(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 2;
  if (b === 1) return 0;
  if (b >= 2 && b <= 4) return 1;
  return 2;
}

/**
 * Pick a plural form from "one|few|many" (ru) or "one|other" (en).
 * @param {number} n
 * @param {string} forms
 * @param {string} [locale]
 */
export function plural(n, forms, locale = 'ru') {
  const f = forms.split('|');
  const idx = locale.startsWith('ru') ? ruPlural(n) : n === 1 ? 0 : 1;
  return (f[Math.min(idx, f.length - 1)] || '').replace('#', String(n));
}

/**
 * Storage usage level for the quota warning.
 * @param {{ usage?: number, quota?: number }} est navigator.storage.estimate() result
 * @returns {'ok' | 'warn' | 'critical'}
 */
export function quotaLevel(est) {
  const usage = Number(est.usage) || 0;
  const quota = Number(est.quota) || 0;
  if (!quota) return 'ok';
  const r = usage / quota;
  return r >= 0.95 ? 'critical' : r >= 0.8 ? 'warn' : 'ok';
}

/**
 * Character set of a fetched page: Content-Type header first, then <meta charset> in the head.
 * @param {string | null} contentType
 * @param {string} head first bytes decoded as latin1
 */
export function detectCharset(contentType, head) {
  const fromHeader = /charset=["']?([\w.:-]+)/i.exec(contentType || '');
  const fromMeta = /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head || '');
  const cs = (fromHeader?.[1] || fromMeta?.[1] || 'utf-8').toLowerCase();
  try {
    new TextDecoder(cs);
    return cs;
  } catch {
    return 'utf-8';
  }
}
