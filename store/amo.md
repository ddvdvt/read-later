# Firefox Add-ons (AMO) — listing and review notes (Read Later)

Upload `dist/read-later-<version>-firefox.zip` (built by `npm run zip:firefox`).
Add-on ID: `read-later@ddvdvt.github.io`. Minimum version: Firefox 140.0 (Android: 142.0).
The Russian listing texts can be reused from `listing.ru.md`; the UI is localized (ru, en, kk).

## Name

Read Later — offline articles, no account

## Summary (≤ 250 characters)

Save articles and read them offline. Clean reader, highlights and notes, full-text search. Everything stays on your device: no account, no server. Import Pocket, Omnivore and Instapaper exports; export to JSON, HTML or Markdown.

## Description

Save articles to read later — on the train, on a plane or just in the evening. The text, your highlights and notes live in your browser, not on a remote server: no sign-up, and nobody can shut your library down.

- One-click saving: the toolbar button, Alt+Shift+S or "Save page for later" in the context menu. Save a link from its context menu, or several selected tabs at once.
- Clean article text without ads or menus (Mozilla Readability), with title, author, date and reading time. Images are kept for offline reading.
- Reader: font, size, spacing, line width; light, sepia and dark themes; your reading position is remembered.
- Highlights in four colors with notes; copy them as Markdown.
- Library: unread, favorites, archive, tags, full-text search, sorting, bulk actions, keyboard shortcuts, a 30-day trash.
- Move from other services: Pocket (HTML/CSV), Omnivore (ZIP), Instapaper (CSV), browser bookmarks or a list of links.
- No lock-in: complete JSON backup, HTML bookmarks file, Markdown files for Obsidian or any notes app.

Privacy: no account, analytics, ads or telemetry. The only network requests are the ones you ask for: loading the text of a saved link or the images of an article from its own site.

## Categories

- Feeds, News & Blogging
- Bookmarks

## Tags

read later, pocket alternative, offline reading, reader view, highlights, markdown export

## Homepage / support

- Homepage: https://ddvdvt.github.io/
- Privacy policy: https://ddvdvt.github.io/privacy/read-later.html (also paste the text of `PRIVACY.md` into the AMO privacy policy field)
- License: MIT

## Data collection (data_collection_permissions)

`"required": ["none"]` — nothing is collected or transmitted to the developer or third parties. Saved articles, highlights and settings stay in the browser's IndexedDB / `storage.local`. Network requests go only to the article's own site, when the user asks to save or load it.

## Notes for reviewers

**Source code:** not minified, not bundled, no build step, no remote code. The package is the `extension/` folder of the repository as is; only `manifest.json` is generated for Firefox by `scripts/firefox.mjs` (service worker → event page with the same file, gecko id, `minimum_chrome_version` removed, CSP below). Third-party code: `vendor/Readability.js` — Mozilla Readability 0.6.0, unmodified (Apache-2.0, license file next to it); the two `innerHTML` linter warnings are inside it.

**Permissions:**

- `activeTab` + `scripting` — after the user clicks the toolbar button, the context-menu item or presses the shortcut, the bundled Readability + `src/content/capture.js` run in that tab to extract the article; a short "Saved" notice is shown in a closed Shadow DOM.
- `contextMenus` — "Save page for later", "Save link for later", "Open library".
- `storage` — settings. `unlimitedStorage` — articles and their images are stored in IndexedDB for offline reading; without it Firefox may evict the library when disk space is low.
- Optional `bookmarks` — requested only for "Import from bookmarks", removed right after.
- Optional host permissions `http://*/*`, `https://*/*` — requested only when the user asks to load the text of saved links (only their sites) or to save several selected tabs; removed right after the job.
- `content_security_policy.extension_pages` is `script-src 'self'` — the default script policy without `upgrade-insecure-requests`, so articles and images on http-only sites can be loaded. No remote scripts, no eval.

**How to test:**

1. Open an article (e.g. https://en.wikipedia.org/wiki/Reading) → toolbar button → "Save". The popup lists it; "Read" opens the clean reader. Works offline afterwards.
2. In the reader select text → pick a color → add a note. Change the theme to sepia; reload — everything is kept.
3. Options → Import: choose a Pocket export (`ril_export.html`) → links appear in the library; select them → "Load text" → Firefox asks for site access → texts are loaded, access is removed again.
4. Options → Export: JSON backup / Markdown ZIP.

The add-on also opens a static welcome page on install and sets a static uninstall page (https://ddvdvt.github.io/); nothing is sent to them.
