// Minimal Markdown → tree converter for imported articles saved as Markdown (some read-later
// exports store content that way). Covers headings, paragraphs, lists, quotes, code fences,
// horizontal rules, images, links, bold/italic/code. Output goes through sanitizeTree like any HTML.

/** @typedef {import('./html.js').TreeNode} TreeNode */

/**
 * @param {string} s
 * @returns {TreeNode[]}
 */
export function mdInline(s) {
  /** @type {TreeNode[]} */
  const out = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![\p{L}\p{N}])_([^_\s][^_]*)_(?![\p{L}\p{N}])|<(https?:\/\/[^>\s]+)>/gu;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(unescape(s.slice(last, m.index)));
    if (m[2] !== undefined) out.push({ tag: 'img', attrs: { src: m[2], alt: m[1] }, children: [] });
    else if (m[4] !== undefined) out.push({ tag: 'a', attrs: { href: m[4] }, children: mdInline(m[3]) });
    else if (m[5] !== undefined) out.push({ tag: 'code', attrs: {}, children: [m[5]] });
    else if (m[6] !== undefined || m[7] !== undefined) out.push({ tag: 'strong', attrs: {}, children: mdInline(m[6] ?? m[7]) });
    else if (m[8] !== undefined || m[9] !== undefined) out.push({ tag: 'em', attrs: {}, children: mdInline(m[8] ?? m[9]) });
    else if (m[10] !== undefined) out.push({ tag: 'a', attrs: { href: m[10] }, children: [m[10]] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(unescape(s.slice(last)));
  return out;
}

/** @param {string} s */
function unescape(s) {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
}

/**
 * @param {string} md
 * @returns {TreeNode[]}
 */
export function mdToTree(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {TreeNode[]} */
  const out = [];
  let i = 0;
  /** @type {string[]} */
  let para = [];
  const flush = () => {
    if (para.length) out.push({ tag: 'p', attrs: {}, children: mdInline(para.join(' ').trim()) });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+#-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      const attrs = fence[2] ? { class: `language-${fence[2]}` } : {};
      out.push({ tag: 'pre', attrs: {}, children: [{ tag: 'code', attrs, children: [code.join('\n')] }] });
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push({ tag: `h${h[1].length}`, attrs: {}, children: mdInline(h[2]) });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ tag: 'hr', attrs: {}, children: [] });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push({ tag: 'blockquote', attrs: {}, children: mdToTree(q.join('\n')) });
      continue;
    }
    const li = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[1]) === ordered) {
          items.push([m[2]]);
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1].push(lines[i].trim());
          i++;
        } else break;
      }
      out.push({ tag: ordered ? 'ol' : 'ul', attrs: {}, children: items.map((it) => ({ tag: 'li', attrs: {}, children: mdInline(it.join(' ')) })) });
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out;
}
