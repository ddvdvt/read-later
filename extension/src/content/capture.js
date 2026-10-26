// Page capture: runs Mozilla Readability (vendor/Readability.js, injected right before this file)
// on a COPY of the document and returns the article HTML + metadata. The live page is never
// modified. Also used by the library page on documents fetched for "load text later".
//
// Classic script (chrome.scripting.executeScript files): it only defines a global function;
// injecting it twice is harmless.
/* global Readability */
(() => {
  if (globalThis.__readLaterCapture) return;

  /** @param {Document} doc @param {string[]} names */
  const meta = (doc, names) => {
    for (const n of names) {
      const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
      const v = el && el.getAttribute('content');
      if (v && v.trim()) return v.trim();
    }
    return '';
  };

  /** @param {Blob} blob @returns {Promise<string>} */
  const toDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });

  /**
   * Download images of the article within a byte budget (best effort: images the browser may
   * not read because of the site's CORS rules are skipped and stay links to the original).
   * @param {string} html
   * @param {number} budget bytes
   */
  async function grabImages(html, budget) {
    const tpl = document.createElement('template'); // inert: nothing is loaded or executed
    tpl.innerHTML = html;
    const urls = [];
    for (const img of tpl.content.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (/^https?:\/\//i.test(src) && !urls.includes(src)) urls.push(src);
      if (urls.length >= 40) break;
    }
    const out = [];
    let used = 0;
    for (const url of urls) {
      if (used >= budget) break;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', cache: 'force-cache' });
        clearTimeout(timer);
        if (!res.ok) continue;
        const blob = await res.blob();
        const type = (blob.type || res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(type)) continue;
        if (blob.size > Math.min(budget - used, 3 * 1024 * 1024) || blob.size < 100) continue;
        out.push({ url, type, data: await toDataUrl(blob) });
        used += blob.size;
      } catch {
        /* CORS, network error or timeout: keep the remote image */
      }
    }
    return out;
  }

  /**
   * @param {Document} doc
   * @param {{ url?: string, imageBudget?: number }} [opts]
   */
  globalThis.__readLaterCapture = async function capture(doc, opts = {}) {
    const url = opts.url || doc.location?.href || doc.baseURI || '';
    const result = {
      url,
      title: '',
      byline: '',
      siteName: '',
      excerpt: '',
      publishedTime: '',
      lang: '',
      dir: '',
      content: '',
      leadImage: '',
      images: /** @type {Array<{url: string, type: string, data: string}>} */ ([]),
      error: '',
    };
    try {
      result.lang = (doc.documentElement.getAttribute('lang') || '').trim();
      result.leadImage = meta(doc, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image']);
      result.title = meta(doc, ['og:title', 'twitter:title']) || (doc.title || '').trim();
      result.excerpt = meta(doc, ['description', 'og:description', 'twitter:description']);
      result.siteName = meta(doc, ['og:site_name', 'application-name']);
      result.publishedTime = meta(doc, ['article:published_time', 'datePublished', 'date', 'pubdate', 'DC.date.issued']);
      if (typeof Readability !== 'function') throw new Error('Readability is not loaded');
      let article = null;
      for (const charThreshold of [500, 100]) {
        const clone = /** @type {Document} */ (doc.cloneNode(true));
        article = new Readability(clone, { charThreshold, keepClasses: true, maxElemsToParse: 200000 }).parse();
        if (article && article.content && (article.textContent || '').trim().length > 80) break;
      }
      if (article) {
        result.title = (article.title || '').trim() || result.title;
        result.byline = (article.byline || '').trim();
        result.siteName = (article.siteName || '').trim() || result.siteName;
        result.excerpt = (article.excerpt || '').trim() || result.excerpt;
        result.publishedTime = (article.publishedTime || '').trim() || result.publishedTime;
        result.lang = (article.lang || '').trim() || result.lang;
        result.dir = article.dir || '';
        if ((article.textContent || '').trim().length > 0) result.content = article.content || '';
      }
      if (result.content && opts.imageBudget && opts.imageBudget > 0) result.images = await grabImages(result.content, opts.imageBudget);
    } catch (e) {
      result.error = String((e && e.message) || e);
    }
    return result;
  };
})();
