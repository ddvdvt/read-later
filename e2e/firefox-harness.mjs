// Real-Firefox harness for the e2e tests (shared by the author's extensions, same file in each repo).
//
// - puppeteer-core drives the installed Firefox over WebDriver BiDi, with a fresh temporary profile
//   (never the user's own profile; the user's running Firefox windows are not touched);
// - the extension is installed as a temporary add-on (browser.installExtension → BiDi
//   webExtension.install), exactly like about:debugging → "Load Temporary Add-on";
// - its moz-extension:// UUID is fixed through the extensions.webextensions.uuids pref, so the test
//   knows the address of every extension page;
// - extension pages need "-remote-allow-system-access" to be scriptable over BiDi; puppeteer cannot
//   wait for their load event, so open() navigates and polls document.readyState instead;
// - the background page is reached from an extension page with runtime.getBackgroundPage();
// - *.test host names: Firefox has no --host-resolver-rules, so the fixture server also acts as the
//   HTTP proxy for every non-local request (see proxyAware());
// - errors: Firefox prints uncaught errors of extension pages / the background / content scripts to
//   stdout as "JavaScript error: moz-extension://<uuid>/…"; the harness collects those lines, and the
//   test copy of the background also records console.error and unhandled rejections.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, freemem } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const FIREFOX = process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a request handler so that it also serves proxy requests ("GET http://site.test/x HTTP/1.1"):
 * req.url becomes the path and req.headers.host stays the requested host.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => any} handler
 */
export function proxyAware(handler) {
  return (req, res) => {
    if (/^https?:\/\//i.test(req.url || '')) {
      const u = new URL(req.url || '');
      req.headers.host = u.host;
      req.url = u.pathname + u.search;
    }
    return handler(req, res);
  };
}

const COLLECTOR = `// test-only: records background errors for the e2e test (not part of the extension)
self.__e2eErrors = [];
const __e2eErr = console.error.bind(console);
console.error = (...a) => { self.__e2eErrors.push('console.error: ' + a.map(String).join(' ')); __e2eErr(...a); };
self.addEventListener('error', (e) => self.__e2eErrors.push('error: ' + (e.message || e)));
self.addEventListener('unhandledrejection', (e) => self.__e2eErrors.push('unhandledrejection: ' + (e.reason && e.reason.stack || e.reason)));
`;

/**
 * Launch Firefox with a temporary profile and install the unpacked extension in `extDir`
 * (a temporary copy: the harness adds a test-only error collector to its background).
 * @param {{
 *   extDir: string,
 *   addonId: string,
 *   proxyPort?: number,
 *   prefs?: Record<string, any>,
 *   headless?: boolean,
 *   helperPath?: string,
 * }} o
 */
export async function startFirefox(o) {
  if (!existsSync(FIREFOX)) throw new Error(`Firefox not found at ${FIREFOX}. Set FIREFOX_PATH.`);
  const manifestPath = join(o.extDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.background?.scripts) {
    await mkdir(join(o.extDir, '__e2e__'), { recursive: true });
    await writeFile(join(o.extDir, '__e2e__', 'collect.js'), COLLECTOR);
    manifest.background.scripts = ['__e2e__/collect.js', ...manifest.background.scripts];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  const work = await mkdtemp(join(tmpdir(), 'ff-e2e-'));
  const profile = join(work, 'profile');
  const downloads = join(work, 'downloads');
  await mkdir(downloads, { recursive: true });
  const uuid = randomUUID();
  const prefs = {
    'extensions.webextensions.uuids': JSON.stringify({ [o.addonId]: uuid }),
    // keep the event page alive while the test inspects its state (default: suspended after 30 s idle)
    'extensions.background.idle.timeout': 600000,
    'browser.download.folderList': 2,
    'browser.download.dir': downloads,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.alwaysOpenPanel': false,
    'browser.download.panel.shown': true,
    'app.normandy.enabled': false,
    'messaging-system.rsexperimentloader.enabled': false,
    'nimbus.rollouts.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'browser.aboutwelcome.enabled': false,
    'extensions.getAddons.cache.enabled': false,
    // pages see a light system theme unless a test switches it (setColorScheme)
    'layout.css.prefers-color-scheme.content-override': 1,
    ...(o.proxyPort
      ? {
          'network.proxy.type': 1,
          'network.proxy.http': '127.0.0.1',
          'network.proxy.http_port': o.proxyPort,
          'network.proxy.ssl': '127.0.0.1',
          'network.proxy.ssl_port': o.proxyPort,
          'network.proxy.no_proxies_on': '',
          'network.proxy.allow_hijacking_localhost': false,
        }
      : {}),
    ...(o.prefs || {}),
  };

  /** @type {import('puppeteer-core').Browser | null} */
  let browser = null;
  let lastErr;
  for (let attempt = 1; attempt <= 4 && !browser; attempt++) {
    if (freemem() < 700 * 1024 * 1024) {
      console.log(`# low free memory (${Math.round(freemem() / 1048576)} MB), waiting before launch…`);
      await sleep(20000);
    }
    try {
      browser = await puppeteer.launch({
        browser: 'firefox',
        executablePath: FIREFOX,
        headless: o.headless ?? !process.env.E2E_HEADED,
        userDataDir: profile,
        args: ['-remote-allow-system-access', '-no-remote', '--width=1100', '--height=800'],
        extraPrefsFirefox: prefs,
        dumpio: false,
        protocolTimeout: 60000,
      });
    } catch (e) {
      lastErr = e;
      console.log(`# Firefox launch failed (attempt ${attempt}): ${String(e).slice(0, 200)}; retrying…`);
      await sleep(15000);
    }
  }
  if (!browser) throw lastErr;

  /** "JavaScript error: moz-extension://<uuid>/…" lines from Firefox stdout/stderr. */
  const stdoutErrors = [];
  const proc = browser.process();
  let buf = '';
  const onData = (d) => {
    buf += String(d);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) if (/^JavaScript (error|warning): moz-extension:\/\//.test(line) && line.includes(uuid)) stdoutErrors.push(line.replace(`moz-extension://${uuid}/`, '/'));
  };
  proc?.stdout?.on('data', onData);
  proc?.stderr?.on('data', onData);

  const addon = await browser.installExtension(o.extDir);
  const base = `moz-extension://${uuid}/`;

  /**
   * Open a URL (extension page or fixture) in a new tab and wait until it has loaded.
   * @param {string} url absolute, or a path inside the extension
   * @param {{ ready?: string }} [opts] CSS selector to wait for
   */
  async function open(url, opts = {}) {
    const full = /^[a-z-]+:/.test(url) ? url : base + url.replace(/^\//, '');
    const page = await browser.newPage();
    await navigate(page, full, opts);
    return page;
  }

  /** @param {import('puppeteer-core').Page} page @param {string} full @param {{ ready?: string }} [opts] */
  async function navigate(page, full, opts = {}) {
    if (full.startsWith('moz-extension:')) {
      // the load event of extension pages is not reported over BiDi: mark the old document, navigate
      // (also to the same URL = reload), then wait for a new, complete document at that URL
      const current = await page.evaluate(() => {
        (/** @type {any} */ (window)).__e2eOld = 1;
        return location.href;
      }).catch(() => '');
      if (full.includes('#') && current.split('#')[0] === full.split('#')[0]) {
        // same document, another #hash: a plain navigation would not load a new document
        page.evaluate((u) => {
          location.href = u;
          location.reload();
        }, full).catch(() => {});
      } else {
        page.goto(full).catch(() => {});
      }
      await waitFor(page, (u) => location.href === u && document.readyState === 'complete' && !(/** @type {any} */ (window)).__e2eOld, full);
    } else {
      await page.goto(full, { waitUntil: 'load' });
    }
    if (opts.ready) await waitFor(page, (s) => !!document.querySelector(s), opts.ready);
  }

  /**
   * Poll a predicate inside the page (page.waitForFunction is unreliable on extension pages).
   * @template A
   * @param {import('puppeteer-core').Page} page
   * @param {(arg: A) => any} fn
   * @param {A} [arg]
   * @param {number} [timeout]
   */
  async function waitFor(page, fn, arg, timeout = 15000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await page.evaluate(fn, arg);
        if (last) return last;
      } catch (e) {
        last = e;
      }
      await sleep(100);
    }
    throw new Error(`waitFor timed out: ${String(fn).slice(0, 160)} (last: ${String(last).slice(0, 200)})`);
  }

  /** @type {import('puppeteer-core').Page | null} */
  let helper = null;
  async function helperPage() {
    if (!helper || helper.isClosed()) helper = await open(o.helperPath || manifest.options_ui?.page || manifest.action?.default_popup);
    return helper;
  }

  /**
   * Run `fn(bg, ...args)` with the background page window (like sw.evaluate in the Chrome tests).
   * The function is serialised: it may only use its arguments.
   * @param {(bg: any, ...args: any[]) => any} fn
   * @param {...any} args
   */
  async function bg(fn, ...args) {
    const h = await helperPage();
    return h.evaluate(`(async () => { const bg = await browser.runtime.getBackgroundPage(); return (${fn.toString()})(bg, ...${JSON.stringify(args)}); })()`);
  }

  /** Pages whose current URL matches (BiDi reports extension tabs as about:blank, so ask the page). */
  async function findPage(pred, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const p of await browser.pages()) {
        const href = await p.evaluate(() => location.href).catch(() => p.url());
        if (pred(href)) return p;
      }
      await sleep(200);
    }
    return null;
  }

  /**
   * Evaluate an expression in the browser chrome (privileged) context, e.g. to change prefs at run
   * time. Needs -remote-allow-system-access (set above). Used instead of CDP-only emulation calls.
   * @param {string} expression
   */
  async function chromeEval(expression) {
    const conn = /** @type {any} */ (browser).connection;
    const tree = await conn.send('browsingContext.getTree', { 'moz:scope': 'chrome', maxDepth: 0 });
    const ctx = tree.result.contexts[0].context;
    const r = await conn.send('script.evaluate', { expression, target: { context: ctx }, awaitPromise: true });
    if (r.result.type === 'exception') throw new Error(`chromeEval: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
    return r.result.result?.value;
  }

  /** Set a Firefox pref while running. @param {string} name @param {boolean | number | string} value */
  async function setPref(name, value) {
    const fn = typeof value === 'boolean' ? 'setBoolPref' : typeof value === 'number' ? 'setIntPref' : 'setStringPref';
    await chromeEval(`Services.prefs.${fn}(${JSON.stringify(name)}, ${JSON.stringify(value)}); true`);
  }

  /**
   * prefers-color-scheme seen by pages (like Playwright's emulateMedia({ colorScheme })), through the
   * content pref. It applies to documents loaded afterwards: reload an open page to see the change.
   * @param {'light' | 'dark'} scheme
   */
  async function setColorScheme(scheme) {
    await setPref('layout.css.prefers-color-scheme.content-override', scheme === 'dark' ? 0 : 1);
    await sleep(100);
  }

  /** CSS media type of every tab, 'print' or 'screen' (Playwright's emulateMedia({ media })). @param {'print' | 'screen'} medium */
  async function setMedium(medium) {
    await chromeEval(
      `for (const w of Services.wm.getEnumerator('navigator:browser')) for (const b of w.gBrowser.browsers) b.browsingContext.mediumOverride = ${JSON.stringify(medium === 'print' ? 'print' : '')}; true`,
    );
    await sleep(100);
  }

  /**
   * Bring a tab to the front. browsingContext.activate is refused for extension pages over BiDi, so
   * those activate themselves through the tabs API.
   * @param {import('puppeteer-core').Page} page
   */
  async function front(page) {
    try {
      await page.bringToFront();
    } catch {
      await page.evaluate(async () => {
        const tab = await chrome.tabs.getCurrent();
        if (tab && tab.id != null) await chrome.tabs.update(tab.id, { active: true });
      });
    }
    await sleep(100);
  }

  /**
   * Resize the viewport. browsingContext.setViewport is refused for extension pages over BiDi, so
   * those resize their window (outer size: the viewport ends up a little smaller).
   * @param {import('puppeteer-core').Page} page @param {number} width @param {number} height
   */
  async function resize(page, width, height) {
    try {
      await page.setViewport({ width, height });
    } catch {
      await page.evaluate(async (width, height) => {
        const win = await chrome.windows.getCurrent();
        await chrome.windows.update(win.id, { width, height });
      }, width, height);
    }
    await sleep(200);
  }

  async function errors() {
    let bgErrors = [];
    try {
      bgErrors = await bg((b) => b.__e2eErrors || []);
    } catch (e) {
      bgErrors = [`could not read background errors: ${e}`];
    }
    return [...stdoutErrors, ...bgErrors.map((e) => `background ${e}`)];
  }

  async function close() {
    try {
      await browser.close();
    } catch {
      proc?.kill();
    }
    await sleep(500);
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
  }

  return { browser, addon, uuid, base, downloads, open, navigate, waitFor, helperPage, bg, findPage, front, resize, errors, close, chromeEval, setPref, setColorScheme, setMedium };
}
