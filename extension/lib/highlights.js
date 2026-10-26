// Highlight anchoring over the article's plain text (textContent of the rendered article).
// A highlight stores the quoted text, a little context before/after and the original offset.
// To re-anchor: exact offset first; otherwise every occurrence of the quote is scored by how well
// its context matches and how close it is to the old offset. Survives re-saves that shift text.

/**
 * @typedef {object} Selector
 * @property {string} exact
 * @property {string} prefix
 * @property {string} suffix
 * @property {number} start
 *
 * @typedef {Selector & { id: string, itemId: string, color: string, note: string, createdAt: number, updatedAt: number }} Highlight
 */

export const CONTEXT = 32;
export const COLORS = ['yellow', 'green', 'blue', 'pink'];
export const MAX_QUOTE = 5000;

/**
 * Build a selector for text[start, end).
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {Selector | null}
 */
export function makeSelector(text, start, end) {
  const s = Math.max(0, Math.min(start, end));
  const e = Math.min(text.length, Math.max(start, end));
  // trim whitespace at the edges of the selection
  let a = s;
  let b = e;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  if (b <= a || b - a > MAX_QUOTE) return null;
  return {
    exact: text.slice(a, b),
    prefix: text.slice(Math.max(0, a - CONTEXT), a),
    suffix: text.slice(b, b + CONTEXT),
    start: a,
  };
}

/** Length of the common suffix of a and b. @param {string} a @param {string} b */
function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix. @param {string} a @param {string} b */
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Find where a selector lives in `text`.
 * @param {string} text
 * @param {Selector} sel
 * @returns {{ start: number, end: number } | null}
 */
export function locate(text, sel) {
  if (!sel || !sel.exact) return null;
  const len = sel.exact.length;
  if (text.substr(sel.start, len) === sel.exact) {
    const pre = text.slice(Math.max(0, sel.start - sel.prefix.length), sel.start);
    if (pre === sel.prefix || commonSuffix(pre, sel.prefix) >= Math.min(8, sel.prefix.length)) return { start: sel.start, end: sel.start + len };
  }
  let best = null;
  let bestScore = -Infinity;
  for (let i = text.indexOf(sel.exact); i >= 0; i = text.indexOf(sel.exact, i + 1)) {
    const pre = text.slice(Math.max(0, i - sel.prefix.length), i);
    const suf = text.slice(i + len, i + len + sel.suffix.length);
    const ctx = commonSuffix(pre, sel.prefix) + commonPrefix(suf, sel.suffix);
    const score = ctx * 10 - Math.abs(i - sel.start) / Math.max(1, text.length) * 50;
    if (score > bestScore) {
      bestScore = score;
      best = { start: i, end: i + len };
    }
  }
  if (best) return best;
  // whitespace differences (re-saved page with different line breaks)
  const loose = looseFind(text, sel.exact, sel.start);
  return loose;
}

/**
 * Find `needle` ignoring differences in whitespace; returns the closest match to `near`.
 * @param {string} text
 * @param {string} needle
 * @param {number} near
 */
function looseFind(text, needle, near) {
  const parts = needle.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length || parts.join('').length < 3) return null;
  const re = new RegExp(parts.join('\\s+'), 'g');
  let best = null;
  let m;
  while ((m = re.exec(text))) {
    if (!best || Math.abs(m.index - near) < Math.abs(best.start - near)) best = { start: m.index, end: m.index + m[0].length };
    if (m[0].length === 0) re.lastIndex++;
  }
  return best;
}

/**
 * Split overlapping ranges into a flat, ordered list of segments with the ids covering them,
 * so nested/overlapping highlights can be wrapped without breaking each other.
 * @param {Array<{ id: string, start: number, end: number }>} ranges
 * @returns {Array<{ start: number, end: number, ids: string[] }>}
 */
export function segments(ranges) {
  const points = new Set();
  for (const r of ranges) {
    if (r.end > r.start) {
      points.add(r.start);
      points.add(r.end);
    }
  }
  const xs = [...points].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k < xs.length - 1; k++) {
    const a = xs[k];
    const b = xs[k + 1];
    const ids = ranges.filter((r) => r.start <= a && r.end >= b).map((r) => r.id);
    if (ids.length) out.push({ start: a, end: b, ids });
  }
  return out;
}

/**
 * Markdown block for an article's highlights (export and copy).
 * @param {Array<Pick<Highlight, 'exact' | 'note' | 'start'>>} hs
 */
export function highlightsMarkdown(hs) {
  return [...hs]
    .sort((a, b) => a.start - b.start)
    .map((h) => {
      const quote = h.exact.replace(/\s*\n\s*/g, ' ').trim();
      const note = (h.note || '').trim();
      return `> ${quote}` + (note ? `\n\n${note.split('\n').map((l) => l.trim()).join('\n')}` : '');
    })
    .join('\n\n');
}
