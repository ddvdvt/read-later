// Article tree utilities: whitelist sanitizer, safe HTML serializer, plain text and Markdown.
// Everything shown in the reader goes through sanitizeTree() + treeToHtml(), so the stored HTML
// can never carry scripts, event handlers, styles, forms or javascript: URLs.
import { isEl, escapeHtml, escapeAttr, VOID_TAGS } from './html.js';

/** @typedef {import('./html.js').TreeNode} TreeNode @typedef {import('./html.js').ElementNode} ElementNode */

/** Tags kept as they are (attributes filtered separately). */
const KEEP = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'hr', 'br', 'a',
  'strong', 'em', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small', 'kbd', 'samp', 'var', 'q', 'cite',
  'abbr', 'time', 'img', 'div', 'details', 'summary',
]);

/** Renamed tags. */
const RENAME = { b: 'strong', i: 'em', strike: 's', section: 'div', article: 'div', main: 'div', header: 'div', footer: 'div', aside: 'div', center: 'div', tt: 'code' };

/** Unwrapped: the element goes away, its children stay. */
const UNWRAP = new Set(['span', 'font', 'picture', 'big', 'nobr', 'label', 'bdi', 'bdo', 'data', 'body', 'html', 'address', 'hgroup', 'search']);

/** Dropped with all content. */
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'base', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'svg', 'math', 'canvas', 'source', 'track',
  'audio', 'map', 'area', 'dialog', 'frame', 'frameset', 'nav', 'menu', 'param', 'slot',
]);

/** class/id tokens of page furniture that sometimes survives Readability (ads, share bars…). */
const JUNK = /(?:^|[\s_-])(?:ad|ads|adv|advert|adverts|advertisement|advertising|adsbygoogle|sponsor|sponsored|promo|promoted|share|sharing|social|newsletter|subscribe|subscription|related|outbrain|taboola|paywall|cookie|cookies|consent)(?=$|[\s_-])/i;

const BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure',
  'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'hr', 'div', 'details', 'summary',
]);

/**
 * Is a URL safe for a link?
 * @param {string} url
 */
export function safeHref(url) {
  const u = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  return '';
}

/**
 * Is a URL safe as an image source? (no SVG data URLs: they may carry scripts in some contexts)
 * @param {string} url
 */
export function safeSrc(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(u)) return u;
  return '';
}

/**
 * Resolve a possibly relative URL against a base.
 * @param {string} url
 * @param {string} [base]
 */
export function resolveUrl(url, base) {
  try {
    return new URL(url, base || undefined).href;
  } catch {
    return url;
  }
}

/** First URL of a srcset attribute. @param {string} srcset */
function firstSrcset(srcset) {
  const first = String(srcset || '').split(',')[0] || '';
  return first.trim().split(/\s+/)[0] || '';
}

/**
 * @param {ElementNode} el
 * @param {string} tag (already renamed)
 * @param {string} [base]
 * @returns {Record<string, string> | null} null → drop the element
 */
function cleanAttrs(el, tag, base) {
  const a = el.attrs || {};
  /** @type {Record<string, string>} */
  const out = {};
  if (a.dir === 'rtl' || a.dir === 'ltr') out.dir = a.dir;
  if (a.lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(a.lang)) out.lang = a.lang;
  if (tag === 'a') {
    const href = safeHref(resolveUrl(a.href || '', base));
    if (href) out.href = href;
    if (a.title) out.title = a.title.slice(0, 300);
  } else if (tag === 'img') {
    const raw = a.src || a['data-src'] || a['data-original'] || firstSrcset(a.srcset || a['data-srcset'] || '');
    const src = safeSrc(/^data:/i.test(raw) ? raw : resolveUrl(raw, base));
    if (!src) return null;
    out.src = src;
    if (a.alt) out.alt = a.alt.slice(0, 500);
    if (a.title) out.title = a.title.slice(0, 300);
  } else if (tag === 'td' || tag === 'th') {
    for (const k of ['colspan', 'rowspan']) if (/^\d{1,3}$/.test(a[k] || '') && a[k] !== '1') out[k] = a[k];
  } else if (tag === 'ol') {
    if (/^-?\d{1,6}$/.test(a.start || '')) out.start = a.start;
    if (a.reversed !== undefined) out.reversed = '';
  } else if (tag === 'li') {
    if (/^-?\d{1,6}$/.test(a.value || '')) out.value = a.value;
  } else if (tag === 'abbr') {
    if (a.title) out.title = a.title.slice(0, 300);
  } else if (tag === 'time') {
    if (a.datetime) out.datetime = a.datetime.slice(0, 64);
  } else if (tag === 'code' || tag === 'pre') {
    const lang = /(?:^|\s)(?:language|lang)-([\w+#-]{1,30})/.exec(a.class || '');
    if (lang) out['data-lang'] = lang[1];
  } else if (tag === 'details') {
    if (a.open !== undefined) out.open = '';
  }
  return out;
}

/**
 * Concatenated text nodes — the same string as the rendered article's textContent.
 * Highlights are anchored in this text space.
 * @param {TreeNode[]} nodes
 */
export function flatText(nodes) {
  return (nodes || []).map(rawText).join('');
}

/** Text of a subtree. @param {TreeNode} n @returns {string} */
function rawText(n) {
  if (!isEl(n)) return n;
  return n.children.map(rawText).join('');
}

/** Does the subtree carry anything visible? @param {TreeNode} n */
function hasContent(n) {
  if (!isEl(n)) return /\S/.test(n);
  if (n.tag === 'img' || n.tag === 'hr' || n.tag === 'br') return true;
  return n.children.some(hasContent);
}

/**
 * Sanitize a parsed tree: whitelist tags and attributes, resolve relative URLs, drop empty
 * wrappers. Returns a new tree (input is not modified).
 * @param {TreeNode[]} nodes
 * @param {{ base?: string }} [opts]
 * @returns {TreeNode[]}
 */
export function sanitizeTree(nodes, opts = {}) {
  const base = opts.base;
  /** @param {TreeNode[]} list @param {boolean} inPre @returns {TreeNode[]} */
  const walk = (list, inPre) => {
    /** @type {TreeNode[]} */
    const out = [];
    const push = (n) => {
      const last = out[out.length - 1];
      if (typeof n === 'string' && typeof last === 'string') out[out.length - 1] = last + n;
      else out.push(n);
    };
    for (const n of list || []) {
      if (!isEl(n)) {
        if (n) push(inPre ? n : n.replace(/[\t\n\r\f ]+/g, ' '));
        continue;
      }
      let tag = n.tag;
      if (tag.includes(':') || DROP.has(tag)) continue;
      if (n.attrs && (n.attrs.hidden !== undefined || n.attrs['aria-hidden'] === 'true') && tag !== 'img') continue;
      // small boxes marked as ads / share bars / newsletter forms (big ones may be the article itself)
      if (n.attrs && JUNK.test(`${n.attrs.class || ''} ${n.attrs.id || ''}`) && rawText(n).length < 800) continue;
      tag = /** @type {Record<string,string>} */ (RENAME)[tag] || tag;
      if (tag === 'iframe' || tag === 'video') {
        const src = safeHref(resolveUrl((n.attrs && (n.attrs.src || n.attrs['data-src'])) || '', base));
        if (src) push({ tag: 'p', attrs: {}, children: [{ tag: 'a', attrs: { href: src }, children: [hostOf(src) || src] }] });
        continue;
      }
      if (UNWRAP.has(tag) || !KEEP.has(tag)) {
        for (const c of walk(n.children, inPre)) push(c);
        continue;
      }
      const attrs = cleanAttrs(n, tag, base);
      if (!attrs) continue;
      if (tag === 'a' && !attrs.href) {
        for (const c of walk(n.children, inPre)) push(c);
        continue;
      }
      const children = VOID_TAGS.has(tag) ? [] : walk(n.children, inPre || tag === 'pre');
      const el = { tag, attrs, children };
      if (!VOID_TAGS.has(tag) && tag !== 'td' && tag !== 'th' && !children.some(hasContent)) continue;
      push(el);
    }
    return out;
  };
  return trimBlocks(walk(nodes, false));
}

/** Trim whitespace-only text between block elements and at block edges. @param {TreeNode[]} nodes */
function trimBlocks(nodes) {
  /** @param {TreeNode[]} list @param {boolean} pre */
  const fix = (list, pre) => {
    const out = list.map((n) => (isEl(n) ? { ...n, children: fix(n.children, pre || n.tag === 'pre') } : n));
    if (pre) return out;
    const blocky = out.some((n) => isEl(n) && BLOCK.has(n.tag));
    return out.filter((n) => !(blocky && typeof n === 'string' && !/\S/.test(n)));
  };
  return fix(nodes, false);
}

/**
 * Remove a leading <h1>/<h2> that repeats the article title (the reader shows the title itself).
 * @param {TreeNode[]} nodes sanitized tree
 * @param {string} title
 * @returns {TreeNode[]}
 */
export function dropTitleHeading(nodes, title) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(title);
  if (!want) return nodes;
  /** @param {TreeNode[]} list @returns {TreeNode[] | null} */
  const visit = (list) => {
    const idx = list.findIndex((n) => isEl(n) || /\S/.test(n));
    if (idx < 0) return null;
    const first = list[idx];
    if (!isEl(first)) return null;
    if ((first.tag === 'h1' || first.tag === 'h2') && norm(rawText(first)) === want) return [...list.slice(0, idx), ...list.slice(idx + 1)];
    if (first.tag === 'div') {
      const inner = visit(first.children);
      if (inner) return [...list.slice(0, idx), { ...first, children: inner }, ...list.slice(idx + 1)];
    }
    return null;
  };
  return visit(nodes) || nodes;
}

/** @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Serialize a (sanitized) tree to HTML. Text and attributes are always escaped.
 * @param {TreeNode[]} nodes
 * @returns {string}
 */
export function treeToHtml(nodes) {
  let s = '';
  for (const n of nodes || []) {
    if (!isEl(n)) {
      s += escapeHtml(n);
      continue;
    }
    if (!/^[a-z][a-z0-9]*$/.test(n.tag)) continue;
    const attrs = Object.entries(n.attrs || {})
      .filter(([k]) => /^[a-z][a-z0-9-]*$/.test(k) && !/^on/.test(k))
      .map(([k, v]) => (v === '' && (k === 'reversed' || k === 'open') ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
      .join('');
    if (VOID_TAGS.has(n.tag)) s += `<${n.tag}${attrs}>`;
    else s += `<${n.tag}${attrs}>${treeToHtml(n.children)}</${n.tag}>`;
  }
  return s;
}

/**
 * Plain text with paragraphs separated by blank lines. Used for search, word counts, excerpts.
 * @param {TreeNode[]} nodes
 */
export function treeToText(nodes) {
  /** @type {string[]} */
  const parts = [];
  /** @param {TreeNode[]} list */
  const walk = (list) => {
    for (const n of list) {
      if (!isEl(n)) {
        parts.push(n);
        continue;
      }
      if (n.tag === 'br') {
        parts.push('\n');
        continue;
      }
      if (n.tag === 'img') {
        continue;
      }
      const block = BLOCK.has(n.tag);
      if (block) parts.push('\n\n');
      walk(n.children);
      if (n.tag === 'td' || n.tag === 'th') parts.push('\t');
      if (block) parts.push('\n\n');
    }
  };
  walk(nodes || []);
  return parts
    .join('')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n[ \t\u00a0]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .trim();
}

/**
 * All image URLs of a tree in document order (no duplicates).
 * @param {TreeNode[]} nodes
 * @returns {string[]}
 */
export function imagesOf(nodes) {
  /** @type {string[]} */
  const out = [];
  const walk = (list) => {
    for (const n of list || []) {
      if (!isEl(n)) continue;
      if (n.tag === 'img' && n.attrs.src && !out.includes(n.attrs.src)) out.push(n.attrs.src);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Escape Markdown control characters in inline text. @param {string} s */
export function mdEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]<>])/g, '\\$1')
    .replace(/^(\s*)([#>+-])(?=\s)/gm, '$1\\$2')
    .replace(/^(\s*\d+)\.(?=\s)/gm, '$1\\.');
}

/**
 * Convert a sanitized tree to Markdown (CommonMark + GFM tables).
 * @param {TreeNode[]} nodes
 * @returns {string}
 */
export function treeToMarkdown(nodes) {
  /** @param {TreeNode[]} list @returns {string} */
  const inline = (list) => {
    let s = '';
    for (const n of list) {
      if (!isEl(n)) {
        s += mdEscape(n.replace(/\s+/g, ' '));
        continue;
      }
      const inner = () => inline(n.children).trim();
      switch (n.tag) {
        case 'strong':
          s += wrap('**', inner());
          break;
        case 'em':
        case 'cite':
          s += wrap('_', inner());
          break;
        case 's':
        case 'del':
          s += wrap('~~', inner());
          break;
        case 'code':
        case 'kbd':
        case 'samp': {
          const t = rawText(n);
          const fence = t.includes('`') ? '`` ' : '`';
          s += t ? `${fence}${t}${fence === '`' ? '`' : ' ``'}` : '';
          break;
        }
        case 'a': {
          const t = inner() || n.attrs.href;
          s += `[${t}](${mdUrl(n.attrs.href)})`;
          break;
        }
        case 'img':
          s += `![${mdEscape(n.attrs.alt || '')}](${mdUrl(n.attrs.src)})`;
          break;
        case 'br':
          s += '  \n';
          break;
        case 'sub':
        case 'sup':
        case 'mark':
        case 'u':
        case 'ins':
        case 'small':
        case 'abbr':
        case 'time':
        case 'q':
        case 'var':
          s += n.tag === 'q' ? `“${inner()}”` : inline(n.children);
          break;
        default:
          s += BLOCK.has(n.tag) ? ` ${inner()} ` : inline(n.children);
      }
    }
    return s;
  };

  /** @param {TreeNode[]} list @param {string} indent @returns {string[]} blocks */
  const blocks = (list, indent = '') => {
    /** @type {string[]} */
    const out = [];
    /** @type {TreeNode[]} */
    let run = [];
    const flush = () => {
      const t = inline(run).replace(/[ \t]+/g, ' ').trim();
      if (t) out.push(t);
      run = [];
    };
    for (const n of list) {
      if (!isEl(n) || !BLOCK.has(n.tag)) {
        run.push(n);
        continue;
      }
      flush();
      const tag = n.tag;
      if (/^h[1-6]$/.test(tag)) {
        const t = inline(n.children).replace(/\s+/g, ' ').trim();
        if (t) out.push(`${'#'.repeat(Number(tag[1]))} ${t}`);
      } else if (tag === 'p' || tag === 'summary' || tag === 'figcaption' || tag === 'caption' || tag === 'dt') {
        const t = inline(n.children).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
        if (t) out.push(tag === 'dt' ? `**${t}**` : tag === 'figcaption' || tag === 'caption' ? `_${t}_` : t);
      } else if (tag === 'hr') {
        out.push('---');
      } else if (tag === 'pre') {
        const t = rawText(n).replace(/\n+$/, '');
        const fence = t.includes('```') ? '~~~' : '```';
        const lang = n.attrs['data-lang'] || findLang(n) || '';
        out.push(`${fence}${lang}\n${t}\n${fence}`);
      } else if (tag === 'blockquote') {
        const inner = blocks(n.children).join('\n\n');
        if (inner) out.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      } else if (tag === 'ul' || tag === 'ol') {
        let num = Number(n.attrs.start || 1);
        const items = [];
        for (const li of n.children) {
          if (!isEl(li)) continue;
          const marker = tag === 'ol' ? `${li.tag === 'li' && li.attrs.value ? (num = Number(li.attrs.value)) : num}. ` : '- ';
          num++;
          const body = blocks(li.tag === 'li' ? li.children : [li]).join('\n\n');
          const pad = ' '.repeat(marker.length);
          items.push(marker + body.split('\n').map((l, k) => (k === 0 || !l ? l : pad + l)).join('\n'));
        }
        if (items.length) out.push(items.join('\n'));
      } else if (tag === 'table') {
        const md = tableToMarkdown(n, inline);
        if (md) out.push(md);
      } else {
        out.push(...blocks(n.children));
      }
    }
    flush();
    return out.map((b) => (indent ? b.split('\n').map((l) => indent + l).join('\n') : b));
  };
  return blocks(nodes || []).join('\n\n').trim();
}

/** @param {string} s @param {string} t */
function wrap(s, t) {
  return t ? `${s}${t}${s}` : '';
}

/** @param {string} url */
function mdUrl(url) {
  const u = String(url || '');
  return /[\s()<>]/.test(u) ? `<${u.replace(/[<>]/g, encodeURIComponent)}>` : u;
}

/** @param {ElementNode} pre */
function findLang(pre) {
  const code = pre.children.find((c) => isEl(c) && c.tag === 'code');
  return code && isEl(code) ? code.attrs['data-lang'] || '' : '';
}

/**
 * @param {ElementNode} table
 * @param {(l: TreeNode[]) => string} inline
 */
function tableToMarkdown(table, inline) {
  /** @type {ElementNode[]} */
  const rows = [];
  const collect = (list) => {
    for (const c of list) {
      if (!isEl(c)) continue;
      if (c.tag === 'tr') rows.push(c);
      else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') collect(c.children);
    }
  };
  collect(table.children);
  if (!rows.length) return '';
  const cells = rows.map((r) =>
    r.children.filter((c) => isEl(c) && (c.tag === 'td' || c.tag === 'th')).map((c) => inline(/** @type {ElementNode} */ (c).children).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()),
  );
  const width = Math.max(...cells.map((r) => r.length));
  if (!width) return '';
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
  return [line(cells[0]), `|${' --- |'.repeat(width)}`, ...cells.slice(1).map(line)].join('\n');
}
