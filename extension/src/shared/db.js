// IndexedDB storage of the library. Used by the service worker and by extension pages.
// Every multi-record change runs in ONE transaction (item + text + search terms + highlights +
// images), so an interrupted write never leaves half an article. Deleting moves items to the
// trash; records are removed for good only from the trash (manually or after 30 days).
import { expiredTrash, applyAction, normalizeTags } from '../../lib/model.js';

const DB_NAME = 'read-later';
const DB_VERSION = 1;
export const STORES = ['items', 'contents', 'terms', 'highlights', 'images', 'meta'];

/** @typedef {import('../../lib/model.js').Item} Item */
/** @typedef {import('../../lib/highlights.js').Highlight} Highlight */
/** @typedef {{ id: string, html: string, text: string }} Content */
/** @typedef {{ key: string, itemId: string, url: string, blob: Blob, size: number }} ImageRec */

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/** @returns {Promise<IDBDatabase>} */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('normUrl', 'normUrl');
        items.createIndex('addedAt', 'addedAt');
      }
      if (!db.objectStoreNames.contains('contents')) db.createObjectStore('contents', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('terms')) db.createObjectStore('terms', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('highlights')) db.createObjectStore('highlights', { keyPath: 'id' }).createIndex('itemId', 'itemId');
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'key' }).createIndex('itemId', 'itemId');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => reject(new Error('database is blocked by another tab'));
  });
  return dbPromise;
}

/** @template T @param {IDBRequest<T>} req @returns {Promise<T>} */
export function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run `fn` inside one transaction; resolves with fn's result after the transaction COMMITS.
 * @template T
 * @param {string[]} stores
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' });
    /** @type {T} */
    let result;
    let failed = false;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
    tx.onabort = () => reject(tx.error || new Error(failed ? 'transaction aborted' : 'transaction aborted (quota?)'));
    Promise.resolve()
      .then(() => fn(tx))
      .then((r) => {
        result = r;
      })
      .catch((e) => {
        failed = true;
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        reject(e);
      });
  });
}

// ------------------------------------------------------------------ change notifications

const channelName = 'read-later-db';

/** Tell other extension pages that the library changed. @param {string} [kind] @param {string[]} [ids] */
export function notifyChange(kind = 'items', ids = []) {
  try {
    const ch = new BroadcastChannel(channelName);
    ch.postMessage({ kind, ids });
    ch.close();
  } catch {
    /* BroadcastChannel unavailable */
  }
}

/** @param {(msg: { kind: string, ids: string[] }) => void} cb @returns {() => void} unsubscribe */
export function onDbChange(cb) {
  const ch = new BroadcastChannel(channelName);
  ch.onmessage = (e) => cb(e.data || {});
  return () => ch.close();
}

/** Record that user data changed (for the backup reminder). @param {IDBTransaction} tx */
function touch(tx) {
  const meta = tx.objectStore('meta');
  const now = Date.now();
  const req = meta.get('changes');
  req.onsuccess = () => {
    const cur = req.result || { key: 'changes', firstChangeAt: now };
    meta.put({ ...cur, key: 'changes', firstChangeAt: cur.firstChangeAt || now, lastChangeAt: now });
  };
}

// ------------------------------------------------------------------ items

/** @returns {Promise<Item[]>} */
export async function getAllItems() {
  return withTx(['items'], 'readonly', (tx) => promisify(tx.objectStore('items').getAll()));
}

/** @param {string} id @returns {Promise<Item | undefined>} */
export async function getItem(id) {
  return withTx(['items'], 'readonly', (tx) => promisify(tx.objectStore('items').get(id)));
}

/**
 * Item with this canonical URL (a live one is preferred over one in the trash).
 * @param {string} normUrl
 * @returns {Promise<Item | undefined>}
 */
export async function findByUrl(normUrl) {
  const list = await withTx(['items'], 'readonly', (tx) => promisify(tx.objectStore('items').index('normUrl').getAll(normUrl)));
  return list.find((i) => !i.deletedAt) || list[0];
}

/** @param {string} id @returns {Promise<Content | undefined>} */
export async function getContent(id) {
  return withTx(['contents'], 'readonly', (tx) => promisify(tx.objectStore('contents').get(id)));
}

/**
 * Write an item with (optionally) its text, terms and images in one transaction.
 * Existing images of the item are replaced when `images` is given.
 * @param {{ item: Item, content?: Content | null, terms?: string[] | null, images?: Array<{ url: string, blob: Blob }> | null, highlights?: Highlight[] | null }} rec
 * @param {{ silent?: boolean }} [opts] silent: don't count as a change for the backup reminder
 */
export async function putRecord(rec, opts = {}) {
  await withTx(STORES, 'readwrite', async (tx) => {
    putRecordInTx(tx, rec);
    if (!opts.silent) touch(tx);
  });
  notifyChange('items', [rec.item.id]);
  return rec.item;
}

/** @param {IDBTransaction} tx @param {Parameters<typeof putRecord>[0]} rec */
function putRecordInTx(tx, rec) {
  const { item } = rec;
  if (rec.content) tx.objectStore('contents').put({ ...rec.content, id: item.id });
  if (rec.terms) tx.objectStore('terms').put({ id: item.id, terms: rec.terms });
  if (rec.images) {
    const store = tx.objectStore('images');
    const idx = store.index('itemId');
    const r = idx.getAllKeys(item.id);
    r.onsuccess = () => {
      for (const k of r.result) store.delete(k);
      let bytes = 0;
      for (const im of /** @type {Array<{url: string, blob: Blob}>} */ (rec.images)) {
        store.put({ key: `${item.id}\n${im.url}`, itemId: item.id, url: im.url, blob: im.blob, size: im.blob.size });
        bytes += im.blob.size;
      }
      tx.objectStore('items').put({ ...item, imageBytes: bytes });
    };
  }
  if (rec.highlights) for (const h of rec.highlights) tx.objectStore('highlights').put({ ...h, itemId: item.id });
  tx.objectStore('items').put(item);
}

/**
 * Write many records in one transaction (imports). Returns the number written.
 * @param {Array<Parameters<typeof putRecord>[0]>} recs
 */
export async function putRecords(recs) {
  if (!recs.length) return 0;
  await withTx(STORES, 'readwrite', (tx) => {
    for (const r of recs) putRecordInTx(tx, r);
    touch(tx);
  });
  notifyChange('items', recs.map((r) => r.item.id));
  return recs.length;
}

/**
 * Update items by id with a function (inside one transaction).
 * @param {string[]} ids
 * @param {(item: Item) => Item} fn
 * @param {{ silent?: boolean }} [opts]
 * @returns {Promise<Item[]>}
 */
export async function updateItems(ids, fn, opts = {}) {
  /** @type {Item[]} */
  const out = [];
  await withTx(['items', 'meta'], 'readwrite', async (tx) => {
    const store = tx.objectStore('items');
    for (const id of ids) {
      const cur = await promisify(store.get(id));
      if (!cur) continue;
      const next = fn(cur);
      store.put(next);
      out.push(next);
    }
    if (!opts.silent) touch(tx);
  });
  notifyChange('items', ids);
  return out;
}

/**
 * @param {string[]} ids
 * @param {'archive' | 'unarchive' | 'favorite' | 'unfavorite' | 'trash' | 'restore'} action
 */
export function actOn(ids, action) {
  const now = Date.now();
  return updateItems(ids, (it) => applyAction(it, action, now));
}

/**
 * Add and/or remove tags on items.
 * @param {string[]} ids
 * @param {string[]} add
 * @param {string[]} [remove]
 */
export function editTags(ids, add, remove = []) {
  const rm = new Set(normalizeTags(remove));
  const now = Date.now();
  return updateItems(ids, (it) => ({ ...it, tags: normalizeTags([...it.tags.filter((t) => !rm.has(t)), ...add]), updatedAt: now }));
}

/**
 * Rename (or merge) a tag across the library. @param {string} from @param {string} to
 */
export async function renameTag(from, to) {
  const items = (await getAllItems()).filter((i) => i.tags.includes(from));
  const target = normalizeTags([to])[0];
  return editTags(
    items.map((i) => i.id),
    target ? [target] : [],
    [from],
  );
}

/**
 * Delete items and everything attached to them, for good.
 * @param {string[]} ids
 */
export async function deleteForever(ids) {
  if (!ids.length) return 0;
  await withTx(STORES, 'readwrite', async (tx) => {
    for (const id of ids) {
      tx.objectStore('items').delete(id);
      tx.objectStore('contents').delete(id);
      tx.objectStore('terms').delete(id);
      for (const name of ['highlights', 'images']) {
        const store = tx.objectStore(name);
        const keys = await promisify(store.index('itemId').getAllKeys(id));
        for (const k of keys) store.delete(k);
      }
    }
    touch(tx);
  });
  notifyChange('items', ids);
  return ids.length;
}

/** Remove trash items older than 30 days. @returns {Promise<number>} */
export async function purgeTrash(now = Date.now()) {
  const old = expiredTrash(await getAllItems(), now);
  if (old.length) await deleteForever(old.map((i) => i.id));
  return old.length;
}

/** All search term lists. @returns {Promise<Array<{ id: string, terms: string[] }>>} */
export async function getAllTerms() {
  return withTx(['terms'], 'readonly', (tx) => promisify(tx.objectStore('terms').getAll()));
}

/** @param {string[]} ids @returns {Promise<Map<string, Content>>} */
export async function getContents(ids) {
  /** @type {Map<string, Content>} */
  const out = new Map();
  await withTx(['contents'], 'readonly', async (tx) => {
    const store = tx.objectStore('contents');
    const all = await Promise.all(ids.map((id) => promisify(store.get(id))));
    all.forEach((c, i) => c && out.set(ids[i], c));
  });
  return out;
}

// ------------------------------------------------------------------ highlights

/** @param {string} itemId @returns {Promise<Highlight[]>} */
export async function getHighlights(itemId) {
  return withTx(['highlights'], 'readonly', (tx) => promisify(tx.objectStore('highlights').index('itemId').getAll(itemId)));
}

/** @returns {Promise<Highlight[]>} */
export async function getAllHighlights() {
  return withTx(['highlights'], 'readonly', (tx) => promisify(tx.objectStore('highlights').getAll()));
}

/** Recount highlights of an item inside a transaction. @param {IDBTransaction} tx @param {string} itemId */
async function recount(tx, itemId) {
  const n = await promisify(tx.objectStore('highlights').index('itemId').count(itemId));
  const items = tx.objectStore('items');
  const it = await promisify(items.get(itemId));
  if (it) items.put({ ...it, highlights: n, updatedAt: Date.now() });
}

/** @param {Highlight} h */
export async function putHighlight(h) {
  await withTx(['highlights', 'items', 'meta'], 'readwrite', async (tx) => {
    tx.objectStore('highlights').put(h);
    await recount(tx, h.itemId);
    touch(tx);
  });
  notifyChange('highlights', [h.itemId]);
}

/** @param {Highlight} h */
export async function deleteHighlight(h) {
  await withTx(['highlights', 'items', 'meta'], 'readwrite', async (tx) => {
    tx.objectStore('highlights').delete(h.id);
    await recount(tx, h.itemId);
    touch(tx);
  });
  notifyChange('highlights', [h.itemId]);
}

// ------------------------------------------------------------------ images

/** @param {string} itemId @returns {Promise<Map<string, Blob>>} */
export async function getImages(itemId) {
  const list = await withTx(['images'], 'readonly', (tx) => promisify(tx.objectStore('images').index('itemId').getAll(itemId)));
  return new Map(list.map((r) => [r.url, r.blob]));
}

/** @returns {Promise<ImageRec[]>} */
export async function getAllImages() {
  return withTx(['images'], 'readonly', (tx) => promisify(tx.objectStore('images').getAll()));
}

// ------------------------------------------------------------------ meta

/** @param {string} key */
export async function getMeta(key) {
  const r = await withTx(['meta'], 'readonly', (tx) => promisify(tx.objectStore('meta').get(key)));
  return r || null;
}

/** @param {string} key @param {Record<string, unknown>} value */
export async function setMeta(key, value) {
  await withTx(['meta'], 'readwrite', (tx) => {
    tx.objectStore('meta').put({ ...value, key });
  });
}

/** Clear the whole library (settings stay). */
export async function clearAll() {
  await withTx(STORES, 'readwrite', (tx) => {
    for (const s of STORES) tx.objectStore(s).clear();
  });
  notifyChange('items', []);
}
