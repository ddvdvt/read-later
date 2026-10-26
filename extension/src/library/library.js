// Library: views (unread / favorites / highlights / archive / all / trash), tags, local full-text
// search, sorting, list or card layout, bulk actions, keyboard navigation, backup reminder,
// loading text for links, saving several selected tabs.
import { applyI18n, t } from '../shared/i18n.js';
import { wireBrandLinks } from '../shared/brand-link.js';
import { $, el, fill, icon, applyIcons, toast, formatDate, formatMinutes, getSettings, saveSettings, confirmDialog, uiLocale } from '../shared/ui.js';
import { getAllItems, getAllTerms, actOn, editTags, deleteForever, purgeTrash, onDbChange, getContents } from '../shared/db.js';
import { exportJson, backupState, snoozeBackup } from '../shared/backup.js';
import { originsFor, requestOrigins, releaseOrigins, loadTexts, saveTabs, ALL_SITES } from '../shared/fetch-text.js';
import { filterItems, tagCounts, viewCounts, itemMinutes, trashDaysLeft, normalizeTags } from '../../lib/model.js';
import { SearchIndex, termsOf, rankByQuery, snippet } from '../../lib/search.js';
import { needsBackupReminder, quotaLevel, formatBytes, plural } from '../../lib/settings.js';

applyI18n();
applyIcons();
wireBrandLinks();

const PAGE = 60;
const locale = uiLocale();
const readerUrl = (id) => chrome.runtime.getURL(`src/reader/reader.html?id=${encodeURIComponent(id)}`);

/** @typedef {import('../../lib/model.js').Item} Item */

const state = {
  /** @type {Item[]} */ items: [],
  /** @type {Map<string, Item>} */ byId: new Map(),
  view: /** @type {import('../../lib/model.js').View} */ ('unread'),
  tag: '',
  q: '',
  sort: 'newest',
  content: /** @type {'' | 'full' | 'link'} */ (''),
  layout: 'list',
  /** @type {Set<string>} */ selected: new Set(),
  /** @type {Item[]} */ results: [],
  shown: PAGE,
  cursor: -1,
  wpm: 200,
  remoteImages: true,
  /** @type {Map<string, string>} */ snippets: new Map(),
  busy: false,
};
const index = new SearchIndex();
/** @type {Map<string, string[]>} stored text terms per id */
const textTerms = new Map();

// ------------------------------------------------------------------ data

async function loadAll() {
  const [items, terms] = await Promise.all([getAllItems(), getAllTerms()]);
  for (const r of terms) textTerms.set(r.id, r.terms);
  setItems(items);
}

/** @param {Item[]} items */
function setItems(items) {
  state.items = items;
  state.byId = new Map(items.map((i) => [i.id, i]));
  for (const id of [...state.selected]) if (!state.byId.has(id)) state.selected.delete(id);
  for (const id of index.docs.keys()) if (!state.byId.has(id)) index.remove(id);
  for (const it of items) index.add(it.id, [...new Set([...(textTerms.get(it.id) || []), ...termsOf({ title: it.title, site: it.site, byline: it.byline, tags: it.tags, url: it.url })])]);
}

let reloadTimer = 0;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const [items, terms] = await Promise.all([getAllItems(), getAllTerms()]);
    textTerms.clear();
    for (const r of terms) textTerms.set(r.id, r.terms);
    setItems(items);
    render({ keepScroll: true });
  }, 250);
}

// ------------------------------------------------------------------ URL state

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const v = p.get('view');
  state.view = /** @type {any} */ (['unread', 'favorites', 'archive', 'all', 'trash', 'highlights'].includes(v || '') ? v : 'unread');
  state.tag = p.get('tag') || '';
  state.content = /** @type {any} */ (['full', 'link'].includes(p.get('content') || '') ? p.get('content') : '');
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.view !== 'unread') p.set('view', state.view);
  if (state.tag) p.set('tag', state.tag);
  if (state.content) p.set('content', state.content);
  const h = p.toString();
  if (h !== location.hash.slice(1)) history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
}

// ------------------------------------------------------------------ rendering

const VIEW_TITLES = { unread: 'viewUnread', favorites: 'viewFavorites', archive: 'viewArchive', all: 'viewAll', trash: 'viewTrash', highlights: 'viewHighlights' };

function renderSide() {
  const c = viewCounts(state.items);
  for (const k of Object.keys(VIEW_TITLES)) {
    const n = /** @type {any} */ (c)[k];
    $(`#c-${k}`).textContent = n ? String(n) : '';
  }
  document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-current', String(b.getAttribute('data-view') === state.view && !state.tag)));
  const tags = tagCounts(state.items);
  const untagged = state.items.filter((i) => !i.deletedAt && !i.tags.length).length;
  const box = $('#tags');
  if (!tags.length) {
    fill(box, el('p', { class: 'none' }, t('noTags')));
    return;
  }
  fill(box, 
    ...tags.map(([name, n]) =>
      el('button', { type: 'button', 'aria-current': String(state.tag === name), onclick: () => setTag(state.tag === name ? '' : name) }, el('span', { class: 'tag-name' }, `#${name}`), el('span', { class: 'count' }, String(n))),
    ),
    untagged ? el('button', { type: 'button', 'aria-current': String(state.tag === '\u0000untagged'), onclick: () => setTag(state.tag === '\u0000untagged' ? '' : '\u0000untagged') }, el('span', { class: 'tag-name' }, t('untagged')), el('span', { class: 'count' }, String(untagged))) : null,
  );
}

function computeResults() {
  const ids = state.q ? index.query(state.q) : null;
  let list = filterItems(state.items, { view: state.view, tag: state.tag, ids, sort: /** @type {any} */ (state.sort), content: state.content }, locale);
  if (state.q && state.sort === 'newest') list = rankByQuery(list, state.q);
  state.results = list;
}

/** @param {{ keepScroll?: boolean, keepCursor?: boolean }} [opts] */
function render(opts = {}) {
  computeResults();
  renderSide();
  renderBanners();
  const list = $('#list');
  list.classList.toggle('grid', state.layout === 'grid');
  $('#layoutList').setAttribute('aria-pressed', String(state.layout === 'list'));
  $('#layoutGrid').setAttribute('aria-pressed', String(state.layout === 'grid'));
  const title = state.tag ? (state.tag === '\u0000untagged' ? t('untagged') : `#${state.tag}`) : t(VIEW_TITLES[state.view]);
  $('#viewTitle').textContent = title;
  document.title = `${title} — ${t('appName')}`;
  const total = state.results.length;
  const info = $('#viewInfo');
  fill(info, plural(total, t('articlesPlural'), locale));
  if (state.view === 'trash' && total) {
    info.append(' · ', t('trashInfo'), ' ');
    info.append(el('button', { type: 'button', class: 'ghost danger', onclick: emptyTrash }, t('emptyTrash')));
  }
  if (state.content === 'link' && total && state.view !== 'trash') {
    info.append(' ', el('button', { type: 'button', class: 'primary', onclick: () => fetchTexts(state.results.filter((i) => i.content !== 'full')) }, t('loadTextAll')));
  }
  const visible = state.results.slice(0, state.shown);
  fill(list, ...visible.map((it, i) => rowEl(it, i)));
  $('#moreBtn').hidden = total <= state.shown;
  renderEmpty(total);
  if (!opts.keepCursor) state.cursor = Math.min(state.cursor, visible.length - 1);
  paintCursor(false);
  renderBulk();
  writeHash();
  if (state.q) fillSnippets(visible);
}

/** @param {Item[]} visible */
async function fillSnippets(visible) {
  const need = visible.filter((i) => i.content === 'full' && !state.snippets.has(`${i.id}\n${state.q}`)).slice(0, 60);
  if (!need.length) return;
  const q = state.q;
  const contents = await getContents(need.map((i) => i.id));
  if (q !== state.q) return;
  for (const it of need) {
    const c = contents.get(it.id);
    const s = c ? snippet(c.text, q) : '';
    state.snippets.set(`${it.id}\n${q}`, s);
    const ex = document.querySelector(`.row[data-id="${CSS.escape(it.id)}"] .excerpt`);
    if (ex && s) ex.textContent = s;
  }
}

/** @param {number} total */
function renderEmpty(total) {
  const box = $('#empty');
  box.hidden = total > 0;
  if (total) return;
  if (!state.items.filter((i) => !i.deletedAt).length && state.view !== 'trash') {
    fill(box, 
      el('h2', null, t('emptyLibraryTitle')),
      el('p', null, t('emptyLibraryText')),
      el('p', { class: 'muted' }, t('emptyLibraryImport')),
      el('a', { class: 'btn primary', href: '../options/options.html#import' }, t('importShort')),
    );
  } else if (state.q) fill(box, el('h2', null, t('noResults')), el('p', null, t('noResultsHint')));
  else if (state.view === 'trash') fill(box, el('h2', null, t('trashEmpty')), el('p', null, t('trashInfoLong')));
  else if (state.view === 'unread') fill(box, el('h2', null, t('allRead')), el('p', null, t('allReadHint')));
  else fill(box, el('h2', null, t('nothingHere')));
}

/** @param {Item} it @param {number} i */
function rowEl(it, i) {
  const selected = state.selected.has(it.id);
  const trash = !!it.deletedAt;
  const minutes = it.content === 'full' ? formatMinutes(itemMinutes(it, state.wpm)) : '';
  const meta = el('div', { class: 'meta' },
    it.favorite ? el('span', { class: 'fav', title: t('favorite'), html: icon('star', true).replace('<svg', '<svg width="13" height="13"') }) : null,
    el('span', null, it.site),
    minutes ? el('span', null, minutes) : null,
    it.content !== 'full' ? el('span', { class: 'chip link', title: t('linkOnlyHint') }, it.content === 'failed' ? t('textFailed') : t('linkOnly')) : null,
    el('span', { title: new Date(it.addedAt).toLocaleString(locale) }, trash ? t('trashDaysLeft', [String(trashDaysLeft(it))]) : formatDate(it.addedAt)),
    it.status === 'archived' && state.view !== 'archive' ? el('span', { class: 'chip' }, t('archived')) : null,
    it.highlights ? el('span', { class: 'chip', title: t('viewHighlights') }, `✎ ${it.highlights}`) : null,
    ...it.tags.map((tag) => el('button', { type: 'button', class: 'chip tag', onclick: (e) => { e.stopPropagation(); setTag(tag); } }, `#${tag}`)),
  );
  const snip = state.q ? state.snippets.get(`${it.id}\n${state.q}`) : '';
  const acts = el('div', { class: 'acts' });
  const act = (name, label, fn, on = false, filled = false) =>
    el('button', { type: 'button', class: `icon ghost${on ? ' on' : ''}`, title: label, 'aria-label': label, html: icon(name, filled), onclick: (e) => { e.stopPropagation(); fn(); } });
  if (trash) {
    acts.append(act('restore', t('restore'), () => doAction([it.id], 'restore')), act('trash', t('deleteForever'), () => removeForever([it.id])));
  } else {
    acts.append(
      act('star', it.favorite ? t('unfavorite') : t('favorite'), () => doAction([it.id], it.favorite ? 'unfavorite' : 'favorite'), it.favorite, it.favorite),
      act(it.status === 'archived' ? 'unarchive' : 'archive', it.status === 'archived' ? t('unarchive') : t('archive'), () => doAction([it.id], it.status === 'archived' ? 'unarchive' : 'archive')),
      act('tag', t('editTags'), () => openTags([it.id])),
      act('trash', t('toTrash'), () => doAction([it.id], 'trash')),
    );
  }
  const thumb = it.leadImage && state.remoteImages ? el('img', { class: 'thumb', src: it.leadImage, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.replaceWith(placeholder(it)) }) : placeholder(it);
  const row = el('div', { class: `row${selected ? ' selected' : ''}`, role: 'listitem', 'data-id': it.id, 'data-index': i },
    el('input', { type: 'checkbox', checked: selected, 'aria-label': t('select'), onclick: (e) => { e.stopPropagation(); toggleSelect(it.id, e.shiftKey); } }),
    el('div', { class: 'body' },
      thumb,
      el('a', { class: 'title', href: readerUrl(it.id), dir: it.dir || 'auto' }, it.title),
      meta,
      (snip || it.excerpt) ? el('p', { class: 'excerpt', dir: 'auto' }, snip || it.excerpt) : null,
      it.progress > 0.02 && it.progress < 0.98 && !trash ? el('div', { class: 'bar', title: `${Math.round(it.progress * 100)}%` }, el('i', { style: `width:${Math.round(it.progress * 100)}%` })) : null,
    ),
    acts,
  );
  row.addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('a,button,input')) return;
    state.cursor = i;
    paintCursor(true);
  });
  return row;
}

/** @param {Item} it */
function placeholder(it) {
  return el('span', { class: 'thumb ph', 'aria-hidden': 'true' }, (it.site || it.title || '?').slice(0, 1).toUpperCase());
}

/** @param {boolean} focus */
function paintCursor(focus) {
  document.querySelectorAll('.row.cursor').forEach((r) => r.classList.remove('cursor'));
  if (state.cursor < 0) return;
  const row = document.querySelector(`.row[data-index="${state.cursor}"]`);
  if (!row) return;
  row.classList.add('cursor');
  if (focus) {
    row.scrollIntoView({ block: 'nearest' });
    /** @type {HTMLElement} */ (row.querySelector('a.title')).focus({ preventScroll: true });
  }
}

function renderBulk() {
  const n = state.selected.size;
  const bulk = $('#bulk');
  const visibleIds = state.results.map((i) => i.id);
  const all = $('#selectAll');
  all.hidden = visibleIds.length === 0;
  all.checked = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
  all.indeterminate = !all.checked && n > 0;
  bulk.hidden = n === 0;
  if (!n) return;
  $('#bulkCount').textContent = t('selectedCount', [String(n)]);
  const ids = [...state.selected];
  const items = ids.map((id) => state.byId.get(id)).filter(Boolean);
  const b = (label, fn, cls = '') => el('button', { type: 'button', class: cls, onclick: fn }, label);
  const box = $('#bulkActions');
  if (state.view === 'trash') {
    fill(box, b(t('restore'), () => doAction(ids, 'restore')), b(t('deleteForever'), () => removeForever(ids), 'danger'), b(t('clearSelection'), clearSelection, 'ghost'));
    return;
  }
  const anyUnread = items.some((i) => i && i.status === 'unread');
  const anyNotFav = items.some((i) => i && !i.favorite);
  const links = items.filter((i) => i && i.content !== 'full');
  fill(box, 
    anyUnread ? b(t('archive'), () => doAction(ids, 'archive')) : b(t('unarchive'), () => doAction(ids, 'unarchive')),
    anyNotFav ? b(t('favorite'), () => doAction(ids, 'favorite')) : b(t('unfavorite'), () => doAction(ids, 'unfavorite')),
    b(t('editTags'), () => openTags(ids)),
    links.length ? b(t('loadTextN', [String(links.length)]), () => fetchTexts(/** @type {Item[]} */ (links))) : null,
    b(t('toTrash'), () => doAction(ids, 'trash'), 'danger'),
    b(t('clearSelection'), clearSelection, 'ghost'),
  );
}

// ------------------------------------------------------------------ banners

/** @type {HTMLElement | null} */
let jobBanner = null;
let reminder = false;
let quota = /** @type {'ok' | 'warn' | 'critical'} */ ('ok');
let quotaText = '';
/** @type {number[] | null} */
let pendingTabs = null;

function renderBanners() {
  const box = $('#banners');
  const out = [];
  if (pendingTabs) {
    out.push(
      el('div', { class: 'banner info' },
        el('span', { class: 'grow' }, el('strong', null, t('saveTabsTitle', [String(pendingTabs.length)])), ' ', t('saveTabsExplain')),
        el('button', { type: 'button', class: 'primary', id: 'saveTabsGo', onclick: runSaveTabs }, t('saveTabsGo')),
        el('button', { type: 'button', class: 'ghost', onclick: () => { pendingTabs = null; history.replaceState(null, '', location.pathname + location.hash); render(); } }, t('cancel')),
      ),
    );
  }
  if (jobBanner) out.push(jobBanner);
  if (reminder) {
    out.push(
      el('div', { class: 'banner', id: 'backupBanner' },
        el('span', { class: 'grow' }, t('backupReminder')),
        el('button', { type: 'button', class: 'primary', onclick: async () => { await exportJson(); reminder = false; render({ keepScroll: true }); toast(t('backupDone')); } }, t('backupNow')),
        el('button', { type: 'button', class: 'ghost', onclick: async () => { await snoozeBackup(3); reminder = false; render({ keepScroll: true }); } }, t('later')),
      ),
    );
  }
  if (quota !== 'ok') out.push(el('div', { class: `banner ${quota === 'critical' ? 'error' : ''}` }, el('span', { class: 'grow' }, t(quota === 'critical' ? 'quotaCritical' : 'quotaWarn', [quotaText]))));
  fill(box, ...out);
}

async function checkBanners() {
  const settings = await getSettings();
  reminder = needsBackupReminder(await backupState(), settings.backupDays) && state.items.some((i) => !i.deletedAt);
  try {
    const est = await navigator.storage.estimate();
    quota = quotaLevel(est);
    quotaText = `${formatBytes(est.usage || 0, locale)} / ${formatBytes(est.quota || 0, locale)}`;
  } catch {
    quota = 'ok';
  }
  renderBanners();
}

/**
 * @param {string} title
 * @param {() => void} [onCancel]
 */
function startJob(title, onCancel) {
  const bar = el('i');
  const label = el('span', null, title);
  jobBanner = el('div', { class: 'banner info', id: 'jobBanner', role: 'status' }, el('span', { class: 'spinner' }), label, el('div', { class: 'progress' }, bar), onCancel ? el('button', { type: 'button', class: 'ghost', onclick: onCancel }, t('stop')) : null);
  renderBanners();
  return {
    /** @param {number} done @param {number} total @param {string} text */
    update(done, total, text) {
      bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
      label.textContent = text;
    },
    end() {
      jobBanner = null;
      renderBanners();
    },
  };
}

// ------------------------------------------------------------------ actions

/** @param {string[]} ids @param {'archive' | 'unarchive' | 'favorite' | 'unfavorite' | 'trash' | 'restore'} action */
async function doAction(ids, action) {
  if (!ids.length) return;
  await actOn(ids, action);
  const n = ids.length;
  const undo = { archive: 'unarchive', unarchive: 'archive', trash: 'restore', restore: 'trash' }[action];
  const msgKey = { archive: 'doneArchived', unarchive: 'doneUnarchived', favorite: 'doneFavorite', unfavorite: 'doneUnfavorite', trash: 'doneTrashed', restore: 'doneRestored' }[action];
  if (action !== 'favorite' && action !== 'unfavorite') clearSelection();
  toast(t(msgKey, [String(n)]), undo ? { action: t('undo'), onAction: () => actOn(ids, /** @type {any} */ (undo)) } : {});
}

/** @param {string[]} ids */
async function removeForever(ids) {
  if (!(await confirmDialog(t('confirmDeleteForever', [String(ids.length)]), { ok: t('deleteForever'), danger: true }))) return;
  await deleteForever(ids);
  clearSelection();
  toast(t('doneDeleted', [String(ids.length)]));
}

async function emptyTrash() {
  const ids = state.items.filter((i) => i.deletedAt).map((i) => i.id);
  if (ids.length) await removeForever(ids);
}

function clearSelection() {
  state.selected.clear();
  render({ keepScroll: true, keepCursor: true });
}

let lastClicked = -1;
/** @param {string} id @param {boolean} [range] */
function toggleSelect(id, range = false) {
  const idx = state.results.findIndex((i) => i.id === id);
  if (range && lastClicked >= 0 && idx >= 0) {
    const [a, b] = [Math.min(lastClicked, idx), Math.max(lastClicked, idx)];
    for (let k = a; k <= b; k++) state.selected.add(state.results[k].id);
  } else if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  lastClicked = idx;
  render({ keepScroll: true, keepCursor: true });
}

/** @param {string} tag */
function setTag(tag) {
  state.tag = tag;
  if (tag && state.view === 'trash') state.view = 'all';
  if (tag && state.view === 'unread') state.view = 'all';
  state.shown = PAGE;
  state.cursor = -1;
  render();
}

/** @param {string} view */
function setView(view) {
  state.view = /** @type {any} */ (view);
  state.tag = '';
  state.shown = PAGE;
  state.cursor = -1;
  state.selected.clear();
  render();
  window.scrollTo(0, 0);
}

// tags dialog
/** @type {string[]} */
let tagTargets = [];
/** @param {string[]} ids */
function openTags(ids) {
  tagTargets = ids;
  const items = ids.map((id) => state.byId.get(id)).filter(Boolean);
  const common = new Set(/** @type {Item} */ (items[0])?.tags || []);
  const any = new Set();
  for (const it of items) for (const tg of /** @type {Item} */ (it).tags) any.add(tg);
  for (const tg of [...common]) if (!items.every((it) => /** @type {Item} */ (it).tags.includes(tg))) common.delete(tg);
  fill($('#tagCurrent'), 
    ...[...any].map((tg) => el('label', { class: 'chip' }, el('input', { type: 'checkbox', checked: common.has(tg), 'data-tag': tg, 'data-partial': common.has(tg) ? '' : '1' }), `#${tg}`)),
  );
  fill($('#tagList'), ...tagCounts(state.items).map(([n]) => el('option', { value: n })));
  $('#tagInput').value = '';
  $('#tagHint').textContent = ids.length > 1 ? t('tagHintMany', [String(ids.length)]) : t('tagHint');
  $('#tagDialog').showModal();
  $('#tagInput').focus();
}

$('#tagForm').addEventListener('submit', async () => {
  const add = normalizeTags($('#tagInput').value);
  const remove = [];
  document.querySelectorAll('#tagCurrent input[data-tag]').forEach((c) => {
    const box = /** @type {HTMLInputElement} */ (c);
    const tg = box.getAttribute('data-tag') || '';
    if (!box.checked && !box.getAttribute('data-partial')) remove.push(tg);
    if (box.checked && box.getAttribute('data-partial')) add.push(tg);
  });
  if (add.length || remove.length) {
    await editTags(tagTargets, add, remove);
    toast(t('tagsSaved'));
  }
});
$('#tagCancel').addEventListener('click', () => $('#tagDialog').close());

// ------------------------------------------------------------------ long jobs

/** @param {Item[]} items */
async function fetchTexts(items) {
  if (state.busy || !items.length) return;
  const origins = originsFor(items.map((i) => i.url));
  // the permission prompt must be the first await of the click
  const granted = await requestOrigins(origins);
  if (!granted) {
    toast(t('permissionDenied'));
    return;
  }
  state.busy = true;
  const ctl = new AbortController();
  const job = startJob(t('loadingTexts', ['0', String(items.length)]), () => ctl.abort());
  try {
    const settings = await getSettings();
    const r = await loadTexts(items.map((i) => ({ id: i.id, url: i.url })), settings, {
      signal: ctl.signal,
      onProgress: (done, ok, failed) => job.update(done, items.length, t('loadingTextsProgress', [String(done), String(items.length), String(ok), String(failed)])),
    });
    toast(t('loadTextsDone', [String(r.ok), String(r.failed)]), { ms: 6000 });
  } finally {
    await releaseOrigins(origins);
    state.busy = false;
    job.end();
    clearSelection();
  }
}

async function runSaveTabs() {
  if (!pendingTabs || state.busy) return;
  const granted = await requestOrigins(ALL_SITES);
  if (!granted) {
    toast(t('permissionDenied'));
    return;
  }
  const ids = pendingTabs;
  pendingTabs = null;
  history.replaceState(null, '', location.pathname + location.hash);
  state.busy = true;
  const job = startJob(t('savingTabs', ['0', String(ids.length)]));
  try {
    const r = await saveTabs(ids, await getSettings(), (done) => job.update(done, ids.length, t('savingTabs', [String(done), String(ids.length)])));
    toast(t('saveTabsDone', [String(r.ok), String(r.failed)]), { ms: 6000 });
  } finally {
    await releaseOrigins(ALL_SITES);
    state.busy = false;
    job.end();
  }
}

// ------------------------------------------------------------------ keyboard

let gPending = false;
document.addEventListener('keydown', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (document.querySelector('dialog[open]')) return;
  if (target.matches('input[type="search"]')) {
    if (e.key === 'Escape') {
      if (target instanceof HTMLInputElement && target.value) {
        target.value = '';
        onSearch();
      } else target.blur();
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      target.blur();
      state.cursor = 0;
      paintCursor(true);
      e.preventDefault();
    }
    return;
  }
  if (target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  const visible = Math.min(state.shown, state.results.length);
  const cur = state.results[state.cursor];
  if (gPending) {
    gPending = false;
    const map = { u: 'unread', a: 'archive', f: 'favorites', t: 'trash', h: 'highlights', l: 'all' };
    if (/** @type {any} */ (map)[e.key]) {
      setView(/** @type {any} */ (map)[e.key]);
      e.preventDefault();
    }
    return;
  }
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      if (state.cursor + 1 >= visible && visible < state.results.length) {
        state.shown += PAGE;
        render({ keepCursor: true });
      }
      state.cursor = Math.min(state.cursor + 1, Math.min(state.shown, state.results.length) - 1);
      paintCursor(true);
      break;
    case 'k':
    case 'ArrowUp':
      state.cursor = Math.max(state.cursor - 1, 0);
      paintCursor(true);
      break;
    case 'Enter':
    case 'o':
      if (!cur) return;
      if (e.key === 'Enter' && target.matches('a,button')) return;
      location.href = readerUrl(cur.id);
      break;
    case 'x':
      if (cur) toggleSelect(cur.id);
      break;
    case 'A':
      for (const it of state.results.slice(0, state.shown)) state.selected.add(it.id);
      render({ keepCursor: true });
      break;
    case 'e':
      if (cur && !cur.deletedAt) doAction(state.selected.size ? [...state.selected] : [cur.id], cur.status === 'archived' ? 'unarchive' : 'archive');
      break;
    case 'f':
      if (cur && !cur.deletedAt) doAction([cur.id], cur.favorite ? 'unfavorite' : 'favorite');
      break;
    case 't':
      if (cur) openTags(state.selected.size ? [...state.selected] : [cur.id]);
      break;
    case 'Delete':
    case '#':
      if (cur) {
        const ids = state.selected.size ? [...state.selected] : [cur.id];
        if (cur.deletedAt) removeForever(ids);
        else doAction(ids, 'trash');
      }
      break;
    case '/':
      $('#q').focus();
      break;
    case '?':
      $('#helpDialog').showModal();
      break;
    case 'g':
      gPending = true;
      setTimeout(() => (gPending = false), 1200);
      return;
    case 'Escape':
      if (state.selected.size) clearSelection();
      else if (state.q) {
        $('#q').value = '';
        onSearch();
      }
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ------------------------------------------------------------------ wiring

let searchTimer = 0;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = $('#q').value.trim();
    state.shown = PAGE;
    state.cursor = -1;
    render();
  }, 120);
}
$('#q').addEventListener('input', onSearch);
$('#views').addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('button[data-view]');
  if (b) setView(b.getAttribute('data-view') || 'unread');
});
$('#sort').addEventListener('change', async () => {
  state.sort = $('#sort').value;
  await saveSettings({ sort: /** @type {any} */ (state.sort) });
  render();
});
$('#contentFilter').addEventListener('change', () => {
  state.content = $('#contentFilter').value;
  state.shown = PAGE;
  render();
});
$('#layoutList').addEventListener('click', () => setLayout('list'));
$('#layoutGrid').addEventListener('click', () => setLayout('grid'));
/** @param {'list' | 'grid'} layout */
async function setLayout(layout) {
  state.layout = layout;
  await saveSettings({ layout });
  render({ keepScroll: true, keepCursor: true });
}
$('#moreBtn').addEventListener('click', () => {
  state.shown += PAGE;
  render({ keepScroll: true, keepCursor: true });
});
$('#selectAll').addEventListener('change', () => {
  if ($('#selectAll').checked) for (const it of state.results) state.selected.add(it.id);
  else state.selected.clear();
  render({ keepScroll: true, keepCursor: true });
});
$('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
$('#helpClose').addEventListener('click', () => $('#helpDialog').close());
window.addEventListener('hashchange', () => {
  readHash();
  $('#contentFilter').value = state.content;
  render();
});
// infinite scroll
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && state.shown < state.results.length) {
    state.shown += PAGE;
    render({ keepScroll: true, keepCursor: true });
  }
}, { rootMargin: '600px' }).observe($('#moreBtn').parentElement);

onDbChange(() => scheduleReload());

async function init() {
  readHash();
  const settings = await getSettings();
  state.sort = settings.sort;
  state.layout = settings.layout;
  state.wpm = settings.wpm;
  state.remoteImages = settings.remoteImages;
  $('#sort').value = state.sort;
  $('#contentFilter').value = state.content;
  const tabsParam = new URLSearchParams(location.search).get('saveTabs');
  if (tabsParam) pendingTabs = tabsParam.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0).slice(0, 200);
  await purgeTrash().catch(() => 0);
  await loadAll();
  $('#loading').hidden = true;
  render();
  document.body.dataset.ready = '1';
  checkBanners();
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* not critical: unlimitedStorage already protects the data */
  }
}

init().catch((e) => {
  fill($('#loading'), el('span', { class: 'banner error' }, `${t('errLoad')}: ${String((e && e.message) || e)}`));
  document.body.dataset.ready = '0';
});
