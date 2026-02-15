(() => {
  const origin = location.origin;

  function storageBytes(storage) {
    let bytes = 0;
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const v = storage.getItem(k);
        bytes += (k?.length || 0) + (v?.length || 0);
      }
    } catch {}
    return bytes;
  }

  async function cacheBytesProxy() {
    try {
      if (!("caches" in window)) return 0;
      const names = await caches.keys();
      let totalEntries = 0;
      for (const n of names) {
        const c = await caches.open(n);
        const reqs = await c.keys();
        totalEntries += reqs.length;
      }
      return totalEntries * 2048; // proxy weight
    } catch {
      return 0;
    }
  }

  async function idbProxy() {
    try {
      if (indexedDB?.databases) {
        const dbs = await indexedDB.databases();
        const count = (dbs || []).filter(d => d?.name).length;
        return count * 4096; // proxy weight
      }
    } catch {}
    return 0;
  }

  async function hasSW() {
    try {
      if (!("serviceWorker" in navigator)) return false;
      const regs = await navigator.serviceWorker.getRegistrations();
      return !!(regs && regs.length);
    } catch {
      return false;
    }
  }

  async function sendMetrics(eventsDelta) {
    const localBytes = storageBytes(localStorage);
    const sessionBytes = storageBytes(sessionStorage);

    const cacheProxy = await cacheBytesProxy();
    const idb = await idbProxy();
    const sw = await hasSW();

    const persistentBytes = localBytes + cacheProxy + idb;

    chrome.runtime.sendMessage({
      type: "SG_METRICS",
      payload: {
        origin,
        persistentBytes,
        sessionBytes,
        serviceWorkerPresent: sw,
        storageEventsDelta: eventsDelta
      }
    }).catch(() => {});
  }

  // churn count
  const origSet = Storage.prototype.setItem;
  const origRemove = Storage.prototype.removeItem;
  const origClear = Storage.prototype.clear;

  function bump() { sendMetrics(1); }

  Storage.prototype.setItem = function () { const r = origSet.apply(this, arguments); bump(); return r; };
  Storage.prototype.removeItem = function () { const r = origRemove.apply(this, arguments); bump(); return r; };
  Storage.prototype.clear = function () { const r = origClear.apply(this, arguments); bump(); return r; };

  sendMetrics(0);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type !== "SG_CLEAR_STORAGE") return;

      try {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}

        try {
          if (indexedDB?.databases) {
            const dbs = await indexedDB.databases();
            await Promise.allSettled((dbs || []).map(db => new Promise((resolve) => {
              if (!db?.name) return resolve();
              const req = indexedDB.deleteDatabase(db.name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            })));
          }
        } catch {}

        try {
          if (window.caches?.keys) {
            const keys = await caches.keys();
            await Promise.allSettled(keys.map(k => caches.delete(k)));
          }
        } catch {}

        await sendMetrics(0);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();

    return true;
  });
})();
