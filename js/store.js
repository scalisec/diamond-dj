/* Diamond DJ: storage on the device.
 * IndexedDB "diamond-dj":
 *   kv     small records: the team, the song library, game state, waveform peaks
 *   audio  song and announcement files (Blob) keyed by path, e.g. "Songs/Believer.mp3"
 * localStorage holds nothing important; everything that matters is in IndexedDB.
 */
'use strict';

const Store = (() => {
  const DB_NAME = 'diamond-dj';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Close other Diamond DJ windows and try again.'));
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage was interrupted'));
    });
  }

  const get = (store, key) => tx(store, 'readonly', s => s.get(key));
  const put = (store, key, value) => tx(store, 'readwrite', s => { s.put(value, key); });
  const del = (store, key) => tx(store, 'readwrite', s => { s.delete(key); });
  const keys = store => tx(store, 'readonly', s => s.getAllKeys());

  // ask the browser not to clear our music when space runs low
  async function persist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); }
    catch (e) {}
    return false;
  }

  async function usage() {
    try {
      if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
    } catch (e) {}
    return null;
  }

  return {
    get: k => get('kv', k),
    set: (k, v) => put('kv', k, v),
    remove: k => del('kv', k),
    audio: {
      get: path => get('audio', path),
      put: (path, blob) => put('audio', path, blob),
      remove: path => del('audio', path),
      paths: () => keys('audio'),
    },
    persist, usage,
  };
})();
