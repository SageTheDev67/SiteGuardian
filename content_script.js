// content_script.js
(() => {
  const origin = location.origin;

  // Track events + bytes (localStorage + sessionStorage)
  let storageEvents = 0;

  function estimateStorageBytes(storage) {
    let bytes = 0;
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const v = storage.getItem(k);
        bytes += (k?.length || 0) + (v?.length || 0);
      }
    } catch {
      // Some pages may restrict access under certain sandboxing.
    }
    return bytes;
  }

  function sendMetrics() {
    const localBytes = estimateStorageBytes(window.localStorage);
    const sessionBytes = estimateStorageBytes(window.sessionStorage);
    const total = localBytes + sessionBytes;

    chrome.runtime.sendMessage({
      type: "SG_STORAGE_METRICS",
      payload: {
        origin,
        storageBytesEstimate: total,
        storageEvents
      }
    }).catch(() => {});
  }

  // Patch Storage methods to count events
  const origSetItem = Storage.prototype.setItem;
  const origRemoveItem = Storage.prototype.removeItem;
  const origClear = Storage.prototype.clear;

  Storage.prototype.setItem = function (k, v) {
    storageEvents++;
    const r = origSetItem.apply(this, arguments);
    queueMicrotask(sendMetrics);
    return r;
  };

  Storage.prototype.removeItem = function (k) {
    storageEvents++;
    const r = origRemoveItem.apply(this, arguments);
    queueMicrotask(sendMetrics);
    return r;
  };

  Storage.prototype.clear = function () {
    storageEvents++;
    const r = origClear.apply(this, arguments);
    queueMicrotask(sendMetrics);
    return r;
  };

  // Initial send once DOM is ready-ish
  sendMetrics();

  // Clear storage on request (also clears IndexedDB + Cache when possible)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type !== "SG_CLEAR_STORAGE") return;

      try {
        // local/session
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}

        // IndexedDB: delete all databases if supported
        if (indexedDB?.databases) {
          const dbs = await indexedDB.databases();
          await Promise.all(
            (dbs || []).map((db) => {
              if (!db?.name) return Promise.resolve();
              return new Promise((resolve) => {
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = req.onerror = req.onblocked = () => resolve();
              });
            })
          );
        }

        // Cache Storage
        if (window.caches?.keys) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }

        // Reset local counters + report
        storageEvents = 0;
        sendMetrics();

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();

    return true;
  });
})();

