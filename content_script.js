// content_script.js
(() => {
  const origin = location.origin;

  let lastEventCounter = 0;

  function safeStorageBytes(storage) {
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

  async function cacheBytesEstimate() {
    try {
      if (!("caches" in window)) return 0;
      const names = await caches.keys();
      let total = 0;

      // This is best-effort because exact sizes are not always exposed.
      // We sum entry counts as a proxy weight, then map to bytes.
      for (const n of names) {
        const c = await caches.open(n);
        const reqs = await c.keys();
        total += reqs.length;
      }
      return total * 2048; // proxy: 2KB per cached request
    } catch {
      return 0;
    }
  }

  async function indexedDBSignal() {
    try {
      if (!indexedDB?.databases) return { present: true, dbCount: 0 };
      const dbs = await indexedDB.databases();
      return { present: true, dbCount: (dbs || []).filter(d => d?.name).length };
    } catch {
      return { present: true, dbCount: 1 };
    }
  }

  async function hasServiceWorker() {
    try {
      if (!("serviceWorker" in navigator)) return false;
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs && regs.length > 0;
    } catch {
      return false;
    }
  }

  async function sendMetrics(eventsDelta = 0) {
    const localBytes = safeStorageBytes(localStorage);
    const sessionBytes = safeStorageBytes(sessionStorage);

    const cacheBytes = await cacheBytesEstimate();
    const idb = await indexedDBSignal();
    const sw = await hasServiceWorker();

    // persistent = localStorage + cache proxy + IDB proxy weight
    const idbProxyBytes = (idb.dbCount || 0) * 4096; // proxy weight per DB
    const persistentBytes = localBytes + cacheBytes + idbProxyBytes;

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

  // Count churn by patching Storage writes
  const origSet = Storage.prototype.setItem;
  const origRemove = Storage.prototype.removeItem;
  const origClear = Storage.prototype.clear;

  function bump() {
    lastEventCounter++;
    // send only the delta since last send (cheap)
    sendMetrics(1);
  }

  Storage.prototype.setItem = function () { const r = origSet.apply(this, arguments); bump(); return r; };
  Storage.prototype.removeItem = function () { const r = origRemove.apply(this, arguments); bump(); return r; };
  Storage.prototype.clear = function () { const r = origClear.apply(this, arguments); bump(); return r; };

  // First report
  sendMetrics(0);

  // Clear request (cookies cleared in SW; here we clear page storage)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type !== "SG_CLEAR_STORAGE") return;

      try {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}

        // IndexedDB delete all (best-effort)
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

        // Cache clear
        try {
          if (window.caches?.keys) {
            const keys = await caches.keys();
            await Promise.allSettled(keys.map(k => caches.delete(k)));
          }
        } catch {}

        // Report after clear
        lastEventCounter = 0;
        await sendMetrics(0);

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });
})();
