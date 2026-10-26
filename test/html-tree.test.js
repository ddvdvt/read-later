import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml, decodeEntities, h, isEl } from '../extension/lib/html.js';
import { sanitizeTree, treeToHtml, treeToText, treeToMarkdown, flatText, imagesOf, safeHref, safeSrc, mdEscape } from '../extension/lib/tree.js';

const clean = (html, base = 'https://example.com/a/b.html') => treeToHtml(sanitizeTree(parseHtml(html), { base }));

test('parseHtml: elements, attributes, entities, comments', () => {
  const [p] = parseHtml('<!-- x --><p class="a" data-x=\'1\' hidden>Tom &amp; Jerry &mdash; &#8212; &#x41;&nbsp;<b>bold</b></p>');
  assert.ok(isEl(p));
  assert.equal(p.tag, 'p');
  assert.deepEqual(p.attrs, { class: 'a', 'data-x': '1', hidden: '' });
  assert.equal(p.children[0], 'Tom & Jerry — — A\u00a0');
  assert.deepEqual(p.children[1], { tag: 'b', attrs: {}, children: ['bold'] });
});

test('parseHtml: implied end tags and void elements', () => {
  const nodes = parseHtml('<ul><li>one<li>two</ul><p>a<p>b<br>c<img src=x.png>');
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes[0].children.map((li) => li.children[0]), ['one', 'two']);
  assert.equal(nodes[1].children[0], 'a');
  assert.equal(nodes[2].children.length, 4);
  assert.equal(nodes[2].children[3].attrs.src, 'x.png');
});

test('parseHtml: raw text in script/style is not parsed', () => {
  const nodes = parseHtml('<script>if (a < b) { x = "<p>" }</script><p>ok</p>');
  assert.equal(nodes[0].children[0], 'if (a < b) { x = "<p>" }');
  assert.equal(nodes[1].tag, 'p');
});

test('parseHtml: quoted ">" inside attributes, unknown entities kept', () => {
  const [a] = parseHtml('<a title="1 > 0" href="/x?a=1&b=2">x &foo; y</a>');
  assert.equal(a.attrs.title, '1 > 0');
  assert.equal(a.attrs.href, '/x?a=1&b=2');
  assert.equal(a.children[0], 'x &foo; y');
  assert.equal(decodeEntities('&lt;&#0;&#xD800;'), '<\ufffd\ufffd');
});

test('sanitize: scripts, styles, handlers, forms and javascript: links are removed', () => {
  const out = clean(
    '<div onclick="evil()"><script>alert(1)</script><style>p{}</style><p style="color:red" onmouseover="x">Hi <a href="javascript:alert(1)">bad</a> <a href="/ok" onclick="x">ok</a></p><form><input value="x"></form><iframe src="https://www.youtube.com/embed/abc"></iframe><svg><circle/></svg></div>',
  );
  assert.ok(!/script|style|onclick|onmouseover|javascript:|form|input|svg/i.test(out), out);
  assert.match(out, /<a href="https:\/\/example.com\/ok">ok<\/a>/);
  assert.match(out, /Hi bad /);
  assert.match(out, /<p><a href="https:\/\/www.youtube.com\/embed\/abc">youtube.com<\/a><\/p>/);
});

test('sanitize: images (lazy, srcset, relative), data URLs, empty wrappers', () => {
  const out = clean('<p><img data-src="img/1.jpg" alt="One"></p><p><img srcset="/2.png 1x, /2@2x.png 2x"></p><p><img src="data:image/svg+xml;base64,AAA"></p><p><img src="data:image/png;base64,iVBORw0KGgo="></p><p>  </p><div><span></span></div>');
  assert.match(out, /<img src="https:\/\/example.com\/a\/img\/1.jpg" alt="One">/);
  assert.match(out, /<img src="https:\/\/example.com\/2.png">/);
  assert.ok(!out.includes('svg'));
  assert.match(out, /data:image\/png;base64/);
  assert.ok(!/<p>\s*<\/p>|<div><\/div>/.test(out), out);
});

test('sanitize: renames, unwraps, keeps table spans and code language', () => {
  const out = clean('<section><b>B</b><i>I</i><span>S</span><font>F</font><table><tr><td colspan="2" style="x">c</td></tr></table><pre class="language-js"><code class="language-js">x</code></pre></section>');
  assert.equal(out, '<div><strong>B</strong><em>I</em>SF<table><tr><td colspan="2">c</td></tr></table><pre data-lang="js"><code data-lang="js">x</code></pre></div>');
});

test('sanitize: hidden content is dropped, aria-hidden too', () => {
  assert.equal(clean('<p>a<span hidden>secret</span><span aria-hidden="true">x</span>b</p>'), '<p>ab</p>');
});

test('treeToHtml escapes text and attributes', () => {
  assert.equal(treeToHtml([h('p', { title: '"<x>"' }, '<b>&')]), '<p title="&quot;&lt;x&gt;&quot;">&lt;b&gt;&amp;</p>');
  assert.equal(treeToHtml([h('p', { onclick: 'x' }, 'a')]), '<p>a</p>');
});

test('safeHref / safeSrc', () => {
  assert.equal(safeHref('JAVASCRIPT:alert(1)'), '');
  assert.equal(safeHref(' data:text/html,x'), '');
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeSrc('http://x/y.png'), 'http://x/y.png');
  assert.equal(safeSrc('data:image/svg+xml;base64,AA'), '');
});

test('treeToText: blocks separated, whitespace collapsed', () => {
  const tree = sanitizeTree(parseHtml('<h1>Title</h1><p>First   para\n line.</p><ul><li>a</li><li>b</li></ul><p>x<br>y</p>'));
  assert.equal(treeToText(tree), 'Title\n\nFirst para line.\n\na\n\nb\n\nx\ny');
});

test('flatText equals the concatenated text nodes', () => {
  const tree = sanitizeTree(parseHtml('<p>One <b>two</b></p><p>three</p>'));
  assert.equal(flatText(tree), 'One twothree');
});

test('imagesOf lists unique image URLs in order', () => {
  const tree = sanitizeTree(parseHtml('<img src="https://a/1.png"><p><img src="https://a/2.png"><img src="https://a/1.png"></p>'));
  assert.deepEqual(imagesOf(tree), ['https://a/1.png', 'https://a/2.png']);
});

test('treeToMarkdown: headings, emphasis, links, lists, quotes, code, tables, images', () => {
  const tree = sanitizeTree(
    parseHtml(
      '<h2>Head</h2><p>Text with <strong>bold</strong>, <em>it</em>, <code>c`d</code> and <a href="https://x.org/a b">link</a>.</p>' +
        '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="3"><li>three</li></ol>' +
        '<blockquote><p>quote</p></blockquote><pre><code class="language-py">print(1)\n</code></pre>' +
        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table><p><img src="https://x.org/i.png" alt="pic"></p><hr><p>1. not a list *star*</p>',
    ),
  );
  const md = treeToMarkdown(tree);
  assert.equal(
    md,
    [
      '## Head',
      'Text with **bold**, _it_, `` c`d `` and [link](https://x.org/a%20b).',
      '- one\n- two\n\n  - nested',
      '3. three',
      '> quote',
      '```py\nprint(1)\n```',
      '| A | B |\n| --- | --- |\n| 1 | 2\\|3 |',
      '![pic](https://x.org/i.png)',
      '---',
      '1\\. not a list \\*star\\*',
    ].join('\n\n'),
  );
});

test('mdEscape escapes control characters', () => {
  assert.equal(mdEscape('# a_b [c]'), '\\# a\\_b \\[c\\]');
});
