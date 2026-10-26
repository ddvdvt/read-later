// Small, forgiving HTML → tree parser. Pure: runs in the service worker (no DOMParser there),
// extension pages and node tests.
//
// It is built for article HTML that was already serialized by a browser (Readability's
// innerHTML) or exported by read-later services: well-formed tags, quoted attributes. It also
// survives sloppy markup: unquoted attributes, stray closing tags, unclosed <p>/<li>.
//
// A node is either a text string or an element { tag, attrs, children } (same shape everywhere).

/**
 * @typedef {{ tag: string, attrs: Record<string, string>, children: TreeNode[] }} ElementNode
 * @typedef {string | ElementNode} TreeNode
 */

export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is raw text (never parsed as markup). */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template']);

/** Opening one of these closes an open <p>. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul',
]);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', shy: '\u00ad', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bdquo: '„',
  sbquo: '‚', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  minus: '−', plusmn: '±', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', frac12: '½',
  frac14: '¼', frac34: '¾', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', thinsp: '\u2009',
  ensp: '\u2002', emsp: '\u2003', zwnj: '\u200c', zwj: '\u200d', prime: '′', Prime: '″', numero: '№',
  iexcl: '¡', iquest: '¿', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', uuml: 'ü',
  ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä', ccedil: 'ç', ntilde: 'ñ', oacute: 'ó', iacute: 'í',
  uacute: 'ú', hearts: '♥', check: '✓',
};

/**
 * Decode HTML character references. Unknown named references are kept as written.
 * @param {string} s
 */
export function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ref) ? NAMED[ref] : m;
  });
}

/** @param {string} s */
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} s */
export function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parse attributes from the inside of a start tag (after the tag name).
 * @param {string} src
 * @returns {Record<string, string>}
 */
function parseAttrs(src) {
  /** @type {Record<string, string>} */
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

/**
 * Parse an HTML fragment (or a whole document) into a list of top-level nodes.
 * Comments, doctype and processing instructions are dropped.
 * @param {string} html
 * @returns {TreeNode[]}
 */
export function parseHtml(html) {
  const src = String(html || '');
  /** @type {ElementNode} */
  const root = { tag: '#root', attrs: {}, children: [] };
  /** @type {ElementNode[]} */
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (t) => {
    if (!t) return;
    const kids = top().children;
    const last = kids[kids.length - 1];
    if (typeof last === 'string') kids[kids.length - 1] = last + t;
    else kids.push(t);
  };
  /** Close up to and including the nearest open `tag`; returns false when it is not open. */
  const closeTag = (tag) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) {
        stack.length = i;
        return true;
      }
    }
    return false;
  };
  const isOpen = (tag, stopAt) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) return true;
      if (stopAt && stopAt.has(stack[i].tag)) return false;
    }
    return false;
  };
  const LIST_SCOPE = new Set(['ul', 'ol', 'table', 'div', 'blockquote', 'section', 'article']);
  const DL_SCOPE = new Set(['dl', 'table', 'div']);
  const ROW_SCOPE = new Set(['table']);

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeEntities(src.slice(i, lt)));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      const end = src.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const close = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*>/.exec(src.slice(i, i + 200));
    if (close) {
      const tag = close[1].toLowerCase();
      if (tag === 'p' && !isOpen('p', LIST_SCOPE)) top().children.push({ tag: 'p', attrs: {}, children: [] });
      else closeTag(tag);
      i += close[0].length;
      continue;
    }
    const open = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(src.slice(i, i + 100));
    if (!open) {
      pushText('<');
      i += 1;
      continue;
    }
    // find the end of the start tag, respecting quotes
    let j = i + open[0].length;
    let quote = '';
    for (; j < n; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const tag = open[1].toLowerCase();
    let inner = src.slice(i + open[0].length, j);
    const selfClosing = /\/\s*$/.test(inner);
    if (selfClosing) inner = inner.replace(/\/\s*$/, '');
    const el = { tag, attrs: parseAttrs(inner), children: [] };
    i = j + 1;

    // implied end tags
    if (CLOSES_P.has(tag) && isOpen('p', LIST_SCOPE)) closeTag('p');
    if (tag === 'li' && isOpen('li', new Set(['ul', 'ol']))) closeTag('li');
    if ((tag === 'dt' || tag === 'dd') && (isOpen('dt', DL_SCOPE) || isOpen('dd', DL_SCOPE))) {
      if (!closeTag('dd')) closeTag('dt');
    }
    if (tag === 'tr' && isOpen('tr', ROW_SCOPE)) closeTag('tr');
    if ((tag === 'td' || tag === 'th') && (isOpen('td', new Set(['tr'])) || isOpen('th', new Set(['tr'])))) {
      if (!closeTag('td')) closeTag('th');
    }
    if (tag === 'option' && isOpen('option')) closeTag('option');

    top().children.push(el);
    if (VOID_TAGS.has(tag) || selfClosing) continue;
    if (RAW_TEXT.has(tag)) {
      const endRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = src.slice(i);
      const m = endRe.exec(rest);
      const text = m ? rest.slice(0, m.index) : rest;
      if (text) el.children.push(tag === 'textarea' || tag === 'title' ? decodeEntities(text) : text);
      i = m ? i + m.index + m[0].length : n;
      continue;
    }
    stack.push(el);
  }
  return root.children;
}

/** @param {TreeNode} n @returns {n is ElementNode} */
export function isEl(n) {
  return n !== null && typeof n === 'object' && typeof /** @type {any} */ (n).tag === 'string';
}

/**
 * Element builder for tests: h('p', { class: 'x' }, 'text', h('b', 'bold')).
 * @param {string} tag
 * @param {...any} rest
 * @returns {ElementNode}
 */
export function h(tag, ...rest) {
  let attrs = {};
  if (rest.length && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) && !isEl(rest[0])) attrs = rest.shift();
  const children = rest.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== '');
  return { tag: tag.toLowerCase(), attrs: { ...attrs }, children };
}

/**
 * Depth-first search for elements.
 * @param {TreeNode[]} nodes
 * @param {(el: ElementNode) => boolean} pred
 * @returns {ElementNode[]}
 */
export function findAll(nodes, pred) {
  /** @type {ElementNode[]} */
  const out = [];
  const visit = (list) => {
    for (const c of list) {
      if (!isEl(c)) continue;
      if (pred(c)) out.push(c);
      visit(c.children);
    }
  };
  visit(nodes);
  return out;
}
