import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, tokenize, termsOf, parseQuery, SearchIndex, rankByQuery, snippet } from '../extension/lib/search.js';
import { makeSelector, locate, segments, highlightsMarkdown, CONTEXT } from '../extension/lib/highlights.js';
import { mdToTree, mdInline } from '../extension/lib/markdown.js';
import { treeToHtml, sanitizeTree } from '../extension/lib/tree.js';

test('normalize: case, ё, Latin diacritics; Cyrillic й is kept', () => {
  assert.equal(normalize('ЁЛКА Café Йога'), 'елка cafe йога');
  assert.deepEqual(tokenize('Hello, мир! C++ 2024'), ['hello', 'мир', 'c', '2024']);
});

test('termsOf: unique terms from metadata and text, short noise skipped', () => {
  const terms = termsOf({ title: 'Как читать', site: 'habr.com', tags: ['чтение'], text: 'читать и ещё раз читать 7' });
  assert.ok(terms.includes('как') && terms.includes('читать') && terms.includes('habr') && terms.includes('чтение') && terms.includes('7'));
  assert.ok(!terms.includes('и'));
  assert.equal(new Set(terms).size, terms.length);
});

test('parseQuery: words and quoted phrases', () => {
  assert.deepEqual(parseQuery('rust "async await" Rust'), { words: ['rust', 'async', 'await'], phrases: ['async await'] });
});

test('SearchIndex: prefix AND matching, add/remove/update', () => {
  const idx = new SearchIndex();
  idx.add('1', termsOf({ title: 'Программирование на Rust', text: 'владение и заимствование' }));
  idx.add('2', termsOf({ title: 'Rust для веба', text: 'async и wasm' }));
  idx.add('3', termsOf({ title: 'Кулинария', text: 'борщ' }));
  assert.equal(idx.query(''), null);
  assert.deepEqual([...(idx.query('rust') || [])].sort(), ['1', '2']);
  assert.deepEqual([...(idx.query('програм rust') || [])], ['1']);
  assert.deepEqual([...(idx.query('Заимств')) || []], ['1']);
  assert.deepEqual([...(idx.query('rust борщ') || [])], []);
  idx.add('3', termsOf({ title: 'Rust и борщ' }));
  assert.deepEqual([...(idx.query('борщ') || [])], ['3']);
  idx.remove('3');
  assert.deepEqual([...(idx.query('борщ') || [])], []);
  assert.equal(idx.size, 2);
});

test('rankByQuery puts title matches first', () => {
  const items = [
    { id: 'a', title: 'Something else', site: 'x', addedAt: 3 },
    { id: 'b', title: 'Rust tips', site: 'y', addedAt: 1 },
    { id: 'c', title: 'Old', site: 'rust-lang.org', addedAt: 2 },
  ];
  assert.deepEqual(rankByQuery(items, 'rust').map((i) => i.id), ['b', 'c', 'a']);
});

test('snippet around the first match', () => {
  const text = 'Начало текста. '.repeat(20) + 'Здесь важное слово заимствование и ещё немного текста после него. ' + 'Хвост. '.repeat(30);
  const s = snippet(text, 'заимств', 40);
  assert.match(s, /^….*заимствование.*…$/);
  assert.equal(snippet(text, 'нетутакого'), '');
});

const ARTICLE = 'The quick brown fox jumps over the lazy dog. The quick brown fox is quick. End of the story.';

test('makeSelector trims whitespace and captures context', () => {
  const start = ARTICLE.indexOf('lazy dog');
  const sel = makeSelector(ARTICLE, start - 1, start + 8);
  assert.ok(sel);
  assert.equal(sel.exact, 'lazy dog');
  assert.equal(sel.start, start);
  assert.equal(sel.prefix, ARTICLE.slice(start - CONTEXT, start));
  assert.equal(makeSelector(ARTICLE, 5, 5), null);
  assert.equal(makeSelector('   ', 0, 3), null);
});

test('locate: exact offset, moved text, repeated quotes, whitespace changes', () => {
  const i2 = ARTICLE.indexOf('quick brown fox', 10);
  const sel = /** @type {any} */ (makeSelector(ARTICLE, i2, i2 + 15));
  assert.deepEqual(locate(ARTICLE, sel), { start: i2, end: i2 + 15 });
  // text inserted before: the second occurrence is still chosen thanks to the context
  const moved = 'NEW INTRO PARAGRAPH. ' + ARTICLE;
  assert.deepEqual(locate(moved, sel), { start: i2 + 21, end: i2 + 36 });
  // first occurrence with its own context
  const sel1 = /** @type {any} */ (makeSelector(ARTICLE, 4, 19));
  assert.deepEqual(locate(moved, sel1), { start: 25, end: 40 });
  // line breaks changed
  const sel3 = /** @type {any} */ (makeSelector(ARTICLE, ARTICLE.indexOf('over the lazy'), ARTICLE.indexOf('over the lazy') + 13));
  const reflow = ARTICLE.replace('over the lazy', 'over\nthe  lazy');
  const r = locate(reflow, sel3);
  assert.ok(r);
  assert.equal(reflow.slice(r.start, r.end), 'over\nthe  lazy');
  assert.equal(locate('completely different', sel3), null);
});

test('segments split overlapping ranges', () => {
  assert.deepEqual(segments([{ id: 'a', start: 0, end: 10 }, { id: 'b', start: 5, end: 15 }, { id: 'c', start: 20, end: 20 }]), [
    { start: 0, end: 5, ids: ['a'] },
    { start: 5, end: 10, ids: ['a', 'b'] },
    { start: 10, end: 15, ids: ['b'] },
  ]);
});

test('highlightsMarkdown', () => {
  assert.equal(highlightsMarkdown([{ exact: 'second', note: '', start: 9 }, { exact: 'first\nline', note: 'my note', start: 1 }]), '> first line\n\nmy note\n\n> second');
});

test('mdToTree: Markdown content of imported articles', () => {
  const html = treeToHtml(sanitizeTree(mdToTree('# Title\n\nPara with **bold** and [a link](https://x.org) and `code`.\nNext line.\n\n- one\n- two\n\n1. first\n\n> quote\n\n```js\nlet a = 1;\n```\n\n---\n\n![img](https://x.org/i.png)')));
  assert.equal(
    html,
    '<h1>Title</h1><p>Para with <strong>bold</strong> and <a href="https://x.org/">a link</a> and <code>code</code>. Next line.</p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><blockquote><p>quote</p></blockquote><pre><code data-lang="js">let a = 1;</code></pre><hr><p><img src="https://x.org/i.png" alt="img"></p>',
  );
  assert.deepEqual(mdInline('snake_case_word'), ['snake_case_word']);
});
