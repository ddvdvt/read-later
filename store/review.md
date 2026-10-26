# Chrome Web Store — Privacy practices & review notes (Read Later)

Copy each block into the matching field of the CWS developer dashboard.
`BASE` = the brand site address from `extension/lib/brand.js` (currently the placeholder `https://USER.github.io/REPO/` — replace it before submitting).

## Single purpose

Read Later saves web articles the user chooses into a local, offline reading library (clean article text, highlights and notes) and lets the user read, organise, import and export those articles. It does not manage tab sessions or browsing history.

## Permission justifications

**activeTab**
Used only when the user clicks the toolbar icon, the "Save page for later" context-menu item or the Alt+Shift+S shortcut. It grants temporary access to that one tab so the extension can extract the article text. No other tabs are read.

**scripting**
Used with activeTab to inject the extension's own bundled files (`vendor/Readability.js` — Mozilla Readability, and `src/content/capture.js`) into the tab the user acted on, via `chrome.scripting.executeScript`. They work on a copy of the document and return the article HTML and metadata; the page is not modified. It also shows a small "Saved" notice in that tab. No remote code.

**storage**
`chrome.storage.local` keeps the user's settings (reader font, theme, backup reminder interval). Nothing is synced or transmitted.

**contextMenus**
Adds "Save page for later" (page), "Save link for later" (links) and "Open library" (toolbar icon menu).

**unlimitedStorage**
Article texts, highlights and optionally images are stored in IndexedDB for offline reading. Without this permission the browser may evict the user's library under disk pressure; the permission prevents data loss. Nothing is stored outside the device.

**bookmarks (optional)**
Requested at runtime only when the user chooses "Import from browser bookmarks"; used to read the selected folder (`chrome.bookmarks.getTree/getSubTree`) and removed right after the import.

**Host permissions (optional: http://\*/\*, https://\*/\*)**
Not granted at install. Requested at runtime only when the user (a) clicks "Load text" for articles saved as bare links (e.g. after importing a Pocket export) — only the origins of those links are requested — or (b) clicks "Save selected tabs" to save several tabs at once. The permission is used to download those pages (without cookies) or read those tabs, and is removed with `chrome.permissions.remove` immediately after the job.

## Remote code

No, I am not using remote code. All JavaScript is packaged with the extension (including the unmodified Mozilla Readability 0.6.0, Apache-2.0); there is no eval/new Function and the default extension CSP is used. Downloaded article pages are parsed as inert documents (DOMParser) and sanitized; their scripts never run.

## Data usage

What user data do you plan to collect from users now or in the future? — **None of the listed types are collected.** (Content and URLs of pages the user explicitly saves are processed and stored only locally on the user's device in IndexedDB. Nothing is transmitted to the developer or third parties.)

Note for the person submitting: if the reviewer insists that locally stored saved pages count as "Website content", tick it with the explanation above; the certifications below stay true either way.

Certifications (all three checked):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

`BASE` + `privacy/read-later.html` → currently `https://USER.github.io/REPO/privacy/read-later.html`

## Notes for the reviewer (test instructions)

No account or setup is needed.

1. Open any article, e.g. a Wikipedia article or a news story.
2. Click the extension icon → "Save page". The popup confirms "Saved for later" and the item appears under "Recently saved". (Alternatively press Alt+Shift+S or right-click → "Save page for later"; a small notice appears in the page.)
3. Click "Read": the reader shows the clean article. Use the "Aa" button to change font/theme. Select some text → pick a color to highlight; click the highlight → "Note" to add a note.
4. Click "Open library": search for a word from the article, use the star/archive/tag/trash buttons, the Trash view and "Restore".
5. Settings (gear icon) → Import: paste a few URLs into "Paste a list of links" → "Read the links" → "Import". In the library choose "Links only" → "Select all" → "Load text": Chrome asks for access to those sites; after loading, the access is removed (Settings → Storage and access shows no website access).
6. Settings → Export: download the JSON backup, HTML bookmarks or Markdown ZIP.

Browser pages (chrome://, the Web Store) cannot be saved by design; the popup says so. The built-in PDF viewer cannot be read — such pages are saved as links.

After installation the extension opens one static welcome page (`BASE/welcome/read-later.html`); the uninstall URL is a static page (`BASE/bye/read-later.html`). No data or identifiers are added to these URLs.
