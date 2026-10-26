// Reader: clean article view with typography settings, saved reading position, highlights with
// notes, offline images, actions (favorite, archive, tags, original, Markdown copy, re-fetch).
import { applyI18n, t } from '../shared/i18n.js';
import { $, el, applyIcons, toast, formatDate, formatMinutes, getSettings, saveSettings, onSettingsChange, copyText, uiLocale } from '../shared/ui.js';
import { getItem, getContent, getImages, getHighlights, putHighlight, deleteHighlight, updateItems, actOn, editTags, getAllItems, onDbChange } from '../shared/db.js';
import { originsFor, requestOrigins, releaseOrigins, loadTexts } from '../shared/fetch-text.js';
import { parseHtml } from '../../lib/html.js';
import { sanitizeTree, treeToHtml, treeToMarkdown } from '../../lib/tree.js';
import { makeSelector, locate, segments, highlightsMarkdown } from '../../lib/highlights.js';
import { itemMinutes, newId, normalizeTags, tagCounts } from '../../lib/model.js';
import { stripTracking } from '../../lib/url.js';

applyI18n();
applyIcons();

const id = new URLSearchParams(location.search).get('id') || '';
const locale = uiLocale();
const root = document.documentElement;
const contentEl = $('#content');

/** @type {import('../../lib/model.js').Item | undefined} */
let item;
/** @type {{ html: string, text: string } | undefined} */
let content;
/** @type {import('../../lib/highlights.js').Highlight[]} */
let highlights = [];
/** @type {Set<string>} highlight ids that could not be found in the text */
let lost = new Set();
/** @type {Map<string, string>} image url → blob: URL */
const blobUrls = new Map();
let settings = await getSettings();
let restoring = true;

// ------------------------------------------------------------------ typography

function applyTypography() {
  const theme = settings.theme === 'auto' ? '' : settings.theme;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  root.dataset.font = settings.font;
  root.dataset.width = settings.width;
  root.dataset.align = settings.align;
  root.style.setProperty('--fs', `${settings.fontSize}px`);
  root.style.setProperty('--lh', String(settings.lineHeight));
  $('#sizeOut').textContent = String(settings.fontSize);
  $('#lineHeight').value = String(settings.lineHeight);
  const press = (sel, attr, val) => document.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === val)));
  press('#fontSeg button', 'data-font', settings.font);
  press('#widthSeg button', 'data-width', settings.width);
  press('#themeSeg button', 'data-theme-btn', settings.theme);
  press('#alignSeg button', 'data-align', settings.align);
}

/** @param {Partial<import('../../lib/settings.js').Settings>} patch */
async function setPref(patch) {
  const ratio = scrollRatio();
  settings = await saveSettings(patch);
  applyTypography();
  scrollToRatio(ratio);
}

$('#fontSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-font]');
  if (b) setPref({ font: b.getAttribute('data-font') });
});
$('#widthSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-width]');
  if (b) setPref({ width: b.getAttribute('data-width') });
});
$('#themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-theme-btn]');
  if (b) setPref({ theme: b.getAttribute('data-theme-btn') });
});
$('#alignSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-align]');
  if (b) setPref({ align: b.getAttribute('data-align') });
});
$('#sizeDown').addEventListener('click', () => setPref({ fontSize: settings.fontSize - 1 }));
$('#sizeUp').addEventListener('click', () => setPref({ fontSize: settings.fontSize + 1 }));
$('#lineHeight').addEventListener('input', () => setPref({ lineHeight: Number($('#lineHeight').value) }));
onSettingsChange((s) => {
  settings = s;
  applyTypography();
});

/** Toggle a floating panel. @param {string} panelSel @param {string} btnSel @param {boolean} [force] */
function togglePanel(panelSel, btnSel, force) {
  const p = $(panelSel);
  const open = force ?? p.hidden;
  for (const [ps, bs] of [['#typePanel', '#typeBtn'], ['#moreMenu', '#moreBtn']]) {
    if (ps !== panelSel) {
      $(ps).hidden = true;
      $(bs).setAttribute('aria-expanded', 'false');
    }
  }
  p.hidden = !open;
  $(btnSel).setAttribute('aria-expanded', String(open));
  if (open) /** @type {HTMLElement | null} */ (p.querySelector('button'))?.focus();
}
$('#typeBtn').addEventListener('click', () => togglePanel('#typePanel', '#typeBtn'));
$('#moreBtn').addEventListener('click', () => togglePanel('#moreMenu', '#moreBtn'));
document.addEventListener('click', (e) => {
  const tgt = /** @type {HTMLElement} */ (e.target);
  if (!tgt.closest('#typePanel, #typeBtn')) togglePanel('#typePanel', '#typeBtn', false);
  if (!tgt.closest('#moreMenu, #moreBtn')) togglePanel('#moreMenu', '#moreBtn', false);
});

// ------------------------------------------------------------------ article

function renderHeader() {
  if (!item) return;
  document.title = item.title;
  $('#aTitle').textContent = item.title;
  $('#aTitle').dir = item.dir || 'auto';
  if (item.lang) $('#article').lang = item.lang;
  const meta = $('#aMeta');
  const minutes = item.content === 'full' ? formatMinutes(itemMinutes(item, settings.wpm)) : '';
  meta.replaceChildren(
    el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.site),
    item.publishedAt ? el('span', null, new Date(item.publishedAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })) : null,
    minutes ? el('span', null, minutes) : null,
    el('span', null, t('savedOn', [formatDate(item.addedAt)])),
    item.status === 'archived' ? el('span', { class: 'chip' }, t('archived')) : null,
  );
  $('#aByline').textContent = item.byline;
  $('#aByline').hidden = !item.byline;
  $('#aTags').replaceChildren(...item.tags.map((tg) => el('a', { class: 'chip', href: `../library/library.html#view=all&tag=${encodeURIComponent(tg)}` }, `#${tg}`)));
  $('#origBtn').href = stripTracking(item.url);
  const fav = $('#favBtn');
  fav.classList.toggle('on', item.favorite);
  fav.setAttribute('aria-pressed', String(item.favorite));
  fav.title = item.favorite ? t('unfavorite') : t('favorite');
  const arch = $('#archiveBtn');
  arch.title = item.status === 'archived' ? t('unarchive') : t('archive');
  arch.innerHTML = '';
  arch.setAttribute('data-icon', item.status === 'archived' ? 'unarchive' : 'archive');
  applyIcons(arch.parentElement || document);
  $('#endArchive').hidden = item.status === 'archived';
  $('#endInfo').textContent = item.status === 'archived' ? t('inArchive') : t('endOfArticle');
}

function renderNoText() {
  const box = $('#noText');
  if (!item) return;
  box.hidden = false;
  box.replaceChildren(
    el('h2', null, item.content === 'failed' ? t('noTextFailedTitle') : t('noTextTitle')),
    el('p', null, item.excerpt || ''),
    el('p', { class: 'muted' }, t('noTextExplain')),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'primary', id: 'loadTextBtn', onclick: fetchText }, t('loadText')),
      el('a', { class: 'btn', href: stripTracking(item.url), target: '_blank', rel: 'noopener noreferrer' }, t('openOriginal')),
    ),
  );
  contentEl.replaceChildren();
  $('#aFoot').hidden = true;
}

function renderContent() {
  if (!content || !content.html) return renderNoText();
  $('#noText').hidden = true;
  $('#aFoot').hidden = false;
  // The stored HTML was sanitized when saved; sanitize again in case it came from a backup file.
  contentEl.innerHTML = treeToHtml(sanitizeTree(parseHtml(content.html)));
  for (const a of contentEl.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const img of contentEl.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    const local = blobUrls.get(src);
    if (local) img.src = local;
    else if (!settings.remoteImages) {
      // no text nodes here: highlight offsets must not depend on this setting
      const label = `🖼 ${img.alt || t('imageNotSaved')}`;
      img.replaceWith(el('a', { class: 'img-off', href: src, target: '_blank', rel: 'noopener noreferrer', 'data-label': label, 'aria-label': label }));
    }
  }
  applyHighlights();
}

// ------------------------------------------------------------------ highlights

/** Text offsets → DOM: wrap [start, end) of contentEl's text in <mark>. */
function applyHighlights() {
  lost = new Set();
  if (!highlights.length) return renderHlList();
  const text = contentEl.textContent || '';
  const ranges = [];
  for (const h of highlights) {
    const r = locate(text, h);
    if (r) ranges.push({ id: h.id, ...r });
    else lost.add(h.id);
  }
  const byId = new Map(highlights.map((h) => [h.id, h]));
  // collect text nodes with their offsets
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  /** @type {Array<{ node: Text, start: number }>} */
  const nodes = [];
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: /** @type {Text} */ (n), start: pos });
    pos += /** @type {Text} */ (n).data.length;
  }
  const segs = segments(ranges);
  // wrap from the end so earlier offsets stay valid
  for (let s = segs.length - 1; s >= 0; s--) {
    const seg = segs[s];
    const top = /** @type {import('../../lib/highlights.js').Highlight} */ (byId.get(seg.ids[seg.ids.length - 1]));
    for (let k = nodes.length - 1; k >= 0; k--) {
      const { node, start } = nodes[k];
      const end = start + node.data.length;
      if (end <= seg.start || start >= seg.end) continue;
      const a = Math.max(seg.start, start) - start;
      const b = Math.min(seg.end, end) - start;
      if (!node.data.slice(a, b).trim() && node.parentElement && /^(TR|TBODY|THEAD|TABLE|UL|OL)$/.test(node.parentElement.tagName)) continue;
      let target = node;
      if (b < target.data.length) target.splitText(b);
      if (a > 0) target = target.splitText(a);
      const mark = el('mark', { class: `hl${seg.ids.some((x) => byId.get(x)?.note) ? ' has-note' : ''}`, 'data-ids': seg.ids.join(' '), 'data-color': top.color, title: top.note || '' });
      target.replaceWith(mark);
      mark.append(target);
      // the node list for this index now refers to the head part; offsets before `a` unchanged
    }
  }
  renderHlList();
}

function renderHlList() {
  const list = $('#hlList');
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  list.replaceChildren(
    ...sorted.map((h) =>
      el('li', { 'data-color': h.color, tabindex: '0', onclick: () => jumpTo(h.id), onkeydown: (e) => e.key === 'Enter' && jumpTo(h.id) },
        el('div', { class: 'q' }, h.exact),
        h.note ? el('div', { class: 'n' }, h.note) : null,
        lost.has(h.id) ? el('div', { class: 'lost' }, t('highlightLost')) : null,
      ),
    ),
  );
  if (!sorted.length) list.replaceChildren(el('li', { class: 'muted', style: 'border:0;cursor:default' }, t('noHighlights')));
  $('#hlCopy').hidden = !sorted.length;
  $('#hlListBtn').title = `${t('highlightsTitle')}${sorted.length ? ` (${sorted.length})` : ''}`;
}

/** @param {string} hid */
function jumpTo(hid) {
  const m = contentEl.querySelector(`mark[data-ids~="${CSS.escape(hid)}"]`);
  if (!m) return;
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  m.classList.add('flash');
  setTimeout(() => m.classList.remove('flash'), 1400);
}

/** Current selection inside the article as text offsets, or null. */
function selectionOffsets() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.commonAncestorContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(contentEl);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length, rect: range.getBoundingClientRect() };
}

/** @type {null | { mode: 'new' } | { mode: 'edit', hid: string }} */
let popState = null;

/** @param {DOMRect} rect */
function showPop(rect, mode, hid) {
  const pop = $('#hlPop');
  popState = mode === 'edit' ? { mode, hid } : { mode: 'new' };
  pop.hidden = false;
  $('#popDel').hidden = mode !== 'edit';
  const h = mode === 'edit' ? highlights.find((x) => x.id === hid) : null;
  pop.querySelectorAll('.dot').forEach((d) => d.setAttribute('aria-pressed', String(!!h && d.getAttribute('data-color') === h.color)));
  const w = pop.offsetWidth;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2 + scrollX), scrollX + innerWidth - w - 8);
  const top = rect.top + scrollY - pop.offsetHeight - 10;
  pop.style.left = `${left}px`;
  pop.style.top = `${top < scrollY + 50 ? rect.bottom + scrollY + 10 : top}px`;
}

function hidePop() {
  $('#hlPop').hidden = true;
  popState = null;
}

/**
 * Create a highlight from the current selection.
 * @param {string} color
 * @returns {Promise<import('../../lib/highlights.js').Highlight | null>}
 */
async function createFromSelection(color) {
  if (!item) return null;
  const off = selectionOffsets();
  if (!off) return null;
  const selector = makeSelector(contentEl.textContent || '', off.start, off.end);
  if (!selector) return null;
  const now = Date.now();
  const h = { id: newId(now), itemId: item.id, ...selector, color, note: '', createdAt: now, updatedAt: now };
  highlights.push(h);
  getSelection()?.removeAllRanges();
  hidePop();
  await putHighlight(h);
  renderContentKeepScroll();
  return h;
}

function renderContentKeepScroll() {
  const y = scrollY;
  renderContent();
  scrollTo(0, y);
}

document.addEventListener('mouseup', (e) => {
  if (/** @type {HTMLElement} */ (e.target).closest('#hlPop')) return;
  setTimeout(() => {
    const off = selectionOffsets();
    if (off && off.end > off.start) showPop(off.rect, 'new');
    else if (!(/** @type {HTMLElement} */ (e.target).closest('mark.hl'))) hidePop();
  }, 0);
});
document.addEventListener('keyup', (e) => {
  if (e.shiftKey && e.key.startsWith('Arrow')) {
    const off = selectionOffsets();
    if (off) showPop(off.rect, 'new');
  }
});
contentEl.addEventListener('click', (e) => {
  const m = /** @type {HTMLElement} */ (e.target).closest('mark.hl');
  if (!m || !getSelection()?.isCollapsed) return;
  const ids = (m.getAttribute('data-ids') || '').split(' ');
  showPop(m.getBoundingClientRect(), 'edit', ids[ids.length - 1]);
});
$('#hlPop').addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
$('#hlPop').addEventListener('click', async (e) => {
  const dot = /** @type {HTMLElement} */ (e.target).closest('.dot');
  if (!dot || !popState) return;
  const color = dot.getAttribute('data-color') || 'yellow';
  if (popState.mode === 'new') await createFromSelection(color);
  else {
    const h = highlights.find((x) => popState && popState.mode === 'edit' && x.id === popState.hid);
    hidePop();
    if (h) {
      h.color = color;
      h.updatedAt = Date.now();
      await putHighlight(h);
      renderContentKeepScroll();
    }
  }
});
$('#popNote').addEventListener('click', async () => {
  if (!popState) return;
  let h = popState.mode === 'edit' ? highlights.find((x) => popState && popState.mode === 'edit' && x.id === popState.hid) : await createFromSelection('yellow');
  hidePop();
  if (h) openNote(h);
});
$('#popDel').addEventListener('click', async () => {
  if (!popState || popState.mode !== 'edit') return;
  const hid = popState.hid;
  const h = highlights.find((x) => x.id === hid);
  hidePop();
  if (!h) return;
  highlights = highlights.filter((x) => x.id !== hid);
  await deleteHighlight(h);
  renderContentKeepScroll();
  toast(t('highlightDeleted'), {
    action: t('undo'),
    onAction: async () => {
      highlights.push(h);
      await putHighlight(h);
      renderContentKeepScroll();
    },
  });
});

/** @type {import('../../lib/highlights.js').Highlight | null} */
let noteTarget = null;
/** @param {import('../../lib/highlights.js').Highlight} h */
function openNote(h) {
  noteTarget = h;
  $('#noteQuote').textContent = h.exact;
  $('#noteText').value = h.note || '';
  $('#noteDialog').showModal();
  $('#noteText').focus();
}
$('#noteForm').addEventListener('submit', async () => {
  if (!noteTarget) return;
  noteTarget.note = $('#noteText').value.trim().slice(0, 10000);
  noteTarget.updatedAt = Date.now();
  await putHighlight(noteTarget);
  renderContentKeepScroll();
});
$('#noteCancel').addEventListener('click', () => $('#noteDialog').close());

$('#hlListBtn').addEventListener('click', () => {
  const p = $('#hlPanel');
  p.hidden = !p.hidden;
  $('#hlListBtn').setAttribute('aria-expanded', String(!p.hidden));
});
$('#hlClose').addEventListener('click', () => {
  $('#hlPanel').hidden = true;
  $('#hlListBtn').setAttribute('aria-expanded', 'false');
});
$('#hlCopy').addEventListener('click', async () => {
  if (!item) return;
  const ok = await copyText(`# ${item.title}\n\n${item.url}\n\n${highlightsMarkdown(highlights)}\n`);
  toast(ok ? t('copied') : t('copyFailed'));
});

// ------------------------------------------------------------------ reading position

function maxScroll() {
  return Math.max(1, document.documentElement.scrollHeight - innerHeight);
}
function scrollRatio() {
  return Math.min(1, Math.max(0, scrollY / maxScroll()));
}
/** @param {number} r */
function scrollToRatio(r) {
  scrollTo(0, r * maxScroll());
}

let saveTimer = 0;
let lastY = 0;
let ticking = false;
let autoArchived = false;
addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const r = scrollRatio();
    $('#progressBar').style.width = `${Math.round(r * 100)}%`;
    const bar = $('#bar');
    bar.classList.toggle('scrolled', scrollY > 10);
    bar.classList.toggle('hide', scrollY > lastY && scrollY > 200 && $('#typePanel').hidden && $('#moreMenu').hidden);
    lastY = scrollY;
    if (restoring || !item || item.content !== 'full') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 700);
  });
});

async function saveProgress() {
  if (!item) return;
  const r = Math.round(scrollRatio() * 1000) / 1000;
  const now = Date.now();
  const finished = r >= 0.98;
  const archive = finished && settings.autoArchive && item.status === 'unread' && !autoArchived;
  [item] = await updateItems([item.id], (it) => ({ ...it, progress: r, lastReadAt: now, ...(archive ? { status: 'archived', archivedAt: now } : {}) }), { silent: !archive });
  if (archive) {
    autoArchived = true;
    renderHeader();
    toast(t('autoArchived'), { action: t('undo'), onAction: () => actOn([id], 'unarchive') });
  }
}
addEventListener('pagehide', () => {
  if (!restoring && item && item.content === 'full') saveProgress();
});

// ------------------------------------------------------------------ actions

$('#favBtn').addEventListener('click', async () => {
  if (!item) return;
  [item] = await actOn([item.id], item.favorite ? 'unfavorite' : 'favorite');
  renderHeader();
});
async function toggleArchive() {
  if (!item) return;
  const was = item.status;
  [item] = await actOn([item.id], was === 'archived' ? 'unarchive' : 'archive');
  renderHeader();
  toast(was === 'archived' ? t('doneUnarchived', ['1']) : t('doneArchived', ['1']), { action: t('undo'), onAction: async () => { [item] = await actOn([id], was === 'archived' ? 'archive' : 'unarchive'); renderHeader(); } });
}
$('#archiveBtn').addEventListener('click', toggleArchive);
$('#endArchive').addEventListener('click', async () => {
  await toggleArchive();
  location.href = '../library/library.html';
});
$('#deleteBtn').addEventListener('click', async () => {
  if (!item) return;
  await actOn([item.id], 'trash');
  location.href = '../library/library.html';
});
$('#copyMd').addEventListener('click', async () => {
  togglePanel('#moreMenu', '#moreBtn', false);
  if (!item) return;
  const body = content && content.html ? treeToMarkdown(parseHtml(content.html)) : '';
  const hl = highlights.length ? `\n\n## ${t('highlightsTitle')}\n\n${highlightsMarkdown(highlights)}` : '';
  const ok = await copyText(`# ${item.title}\n\n<${item.url}>\n\n${body}${hl}\n`);
  toast(ok ? t('copied') : t('copyFailed'));
});
$('#refetch').addEventListener('click', () => {
  togglePanel('#moreMenu', '#moreBtn', false);
  fetchText();
});

$('#tagBtn').addEventListener('click', async () => {
  if (!item) return;
  $('#tagInput').value = item.tags.join(', ');
  $('#tagList').replaceChildren(...tagCounts(await getAllItems()).map(([n]) => el('option', { value: n })));
  $('#tagDialog').showModal();
  $('#tagInput').focus();
});
$('#tagForm').addEventListener('submit', async () => {
  if (!item) return;
  const next = normalizeTags($('#tagInput').value);
  [item] = await editTags([item.id], next, item.tags.filter((x) => !next.includes(x)));
  renderHeader();
});
$('#tagCancel').addEventListener('click', () => $('#tagDialog').close());

async function fetchText() {
  if (!item) return;
  const origins = originsFor([item.url]);
  const granted = await requestOrigins(origins); // first await: keeps the click's user gesture
  if (!granted) {
    toast(t('permissionDenied'));
    return;
  }
  const btn = document.getElementById('loadTextBtn');
  if (btn) btn.replaceChildren(el('span', { class: 'spinner' }), t('loadingText'));
  toast(t('loadingText'), { ms: 20000 });
  try {
    const r = await loadTexts([{ id: item.id, url: item.url }], settings);
    await load();
    toast(r.ok ? t('textLoaded') : t('textLoadFailed'));
  } finally {
    await releaseOrigins(origins);
  }
}

// ------------------------------------------------------------------ keyboard

document.addEventListener('keydown', (e) => {
  const tgt = /** @type {HTMLElement} */ (e.target);
  if (document.querySelector('dialog[open]') || tgt.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case 'Escape':
      if (!$('#hlPop').hidden) hidePop();
      else if (!$('#typePanel').hidden || !$('#moreMenu').hidden) {
        togglePanel('#typePanel', '#typeBtn', false);
        togglePanel('#moreMenu', '#moreBtn', false);
      } else if (!$('#hlPanel').hidden) $('#hlPanel').hidden = true;
      else return;
      break;
    case 'b':
    case 'u':
      location.href = '../library/library.html';
      break;
    case 'h':
      createFromSelection('yellow');
      break;
    case 'n': {
      const off = selectionOffsets();
      if (off) $('#popNote').click();
      break;
    }
    case 'e':
      toggleArchive();
      break;
    case 'f':
      $('#favBtn').click();
      break;
    case 'o':
      if (item) window.open(stripTracking(item.url), '_blank', 'noopener,noreferrer');
      break;
    case '+':
    case '=':
      setPref({ fontSize: settings.fontSize + 1 });
      break;
    case '-':
      setPref({ fontSize: settings.fontSize - 1 });
      break;
    case 'd': {
      const order = ['auto', 'light', 'sepia', 'dark'];
      setPref({ theme: /** @type {any} */ (order[(order.indexOf(settings.theme) + 1) % order.length]) });
      break;
    }
    default:
      return;
  }
  e.preventDefault();
});

// ------------------------------------------------------------------ load

async function load() {
  item = await getItem(id);
  if (!item) {
    $('#loading').replaceChildren(el('span', null, t('notFound')), ' ', el('a', { href: '../library/library.html' }, t('backToLibrary')));
    return;
  }
  content = await getContent(id);
  highlights = await getHighlights(id);
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  for (const [u, blob] of await getImages(id)) blobUrls.set(u, URL.createObjectURL(blob));
  $('#loading').hidden = true;
  $('#article').hidden = false;
  renderHeader();
  renderContent();
}

applyTypography();
try {
  await load();
  if (item && item.deletedAt) toast(t('inTrashNotice'), { action: t('restore'), onAction: async () => { [item] = await actOn([id], 'restore'); renderHeader(); } , ms: 10000 });
  if (item && item.content === 'full' && item.progress > 0.01 && item.progress < 0.99) {
    // wait for layout (fonts, images without size) before restoring the position
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    scrollToRatio(item.progress);
  }
  if (item && item.content === 'full' && !item.lastReadAt) updateItems([id], (it) => ({ ...it, lastReadAt: Date.now() }), { silent: true });
} catch (e) {
  $('#loading').replaceChildren(el('span', { class: 'banner error' }, `${t('errLoad')}: ${String((e && /** @type {any} */ (e).message) || e)}`));
}
setTimeout(() => (restoring = false), 600);
document.body.dataset.ready = item ? '1' : '0';

// another tab changed this article (e.g. text loaded from the library)
onDbChange((m) => {
  if (m.kind === 'items' && (m.ids || []).includes(id)) {
    getItem(id).then((it) => {
      if (it && item && it.updatedAt !== item.updatedAt && it.content !== item.content) load();
      else if (it) {
        item = it;
        renderHeader();
      }
    });
  }
});
