// service_worker.js (MV3)
const DB_KEY = "siteMetrics_v1";

/**
 * DB shape:
 * {
 *   [origin]: {
 *     origin,
 *     hostname,
 *     lastSeen,
 *     cookiesCount,
 *     cookiesBytesEstimate,
 *     storageBytesEstimate,
 *     storageEvents,
 *     trustScore
 *   }
 * }
 */

function now() {
  return Date.now();
}

function hostnameFromOrigin(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function calcTrustScore({ cookiesCount = 0, storageBytesEstimate = 0, storageEvents = 0 } = {}) {
  // Simple v0 heuristic: fewer cookies + less storage => higher score.
  // Scale it into 0..100.
  const cookiePenalty = cookiesCount * 2; // 2 pts per cookie
  const storagePenalty = Math.round(storageBytesEstimate / 1024); // 1 pt per KB
  const churnPenalty = Math.min(20, Math.round(storageEvents / 10)); // small churn penalty

  const score = 100 - cookiePenalty - storagePenalty - churnPenalty;
  return clamp(score, 0, 100);
}

async function getDB() {
  const res = await chrome.storage.local.get(DB_KEY);
  return res[DB_KEY] || {};
}

async function setDB(db) {
  await chrome.storage.local.set({ [DB_KEY]: db });
}

async function upsertOrigin(origin, patch) {
  const db = await getDB();
  const existing = db[origin] || {
    origin,
    hostname: hostnameFromOrigin(origin),
    lastSeen: now(),
    cookiesCount: 0,
    cookiesBytesEstimate: 0,
    storageBytesEstimate: 0,
    storageEvents: 0,
    trustScore: 100
  };

  const next = {
    ...existing,
    ...patch,
    lastSeen: now()
  };
  next.trustScore = calcTrustScore(next);

  db[origin] = next;
  await setDB(db);
  return next;
}

async function refreshCookiesForOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return;
  }

  // Count cookies available to extension for this URL.
  const cookies = await chrome.cookies.getAll({ url: url.href });
  const count = cookies.length;

  // Rough size estimate: name+value+domain+path overhead
  let bytes = 0;
  for (const c of cookies) {
    bytes += (c.name?.length || 0) + (c.value?.length || 0) + (c.domain?.length || 0) + (c.path?.length || 0) + 16;
  }

  await upsertOrigin(origin, {
    cookiesCount: count,
    cookiesBytesEstimate: bytes
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // initialize storage
  chrome.storage.local.get(DB_KEY, (res) => {
    if (!res[DB_KEY]) chrome.storage.local.set({ [DB_KEY]: {} });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "SG_STORAGE_METRICS") {
      const { origin, storageBytesEstimate, storageEvents } = msg.payload || {};
      if (!origin) return sendResponse({ ok: false, error: "Missing origin" });

      await upsertOrigin(origin, {
        storageBytesEstimate: storageBytesEstimate ?? 0,
        storageEvents: storageEvents ?? 0
      });

      // Update cookies too (keeps dashboard consistent)
      await refreshCookiesForOrigin(origin);

      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "SG_GET_DB") {
      const db = await getDB();
      sendResponse({ ok: true, db });
      return;
    }

    if (msg?.type === "SG_CLEAR_SITE") {
      const { origin } = msg.payload || {};
      if (!origin) return sendResponse({ ok: false, error: "Missing origin" });

      // Clear cookies via cookies API
      let url;
      try {
        url = new URL(origin);
      } catch {
        return sendResponse({ ok: false, error: "Bad origin" });
      }

      const cookies = await chrome.cookies.getAll({ url: url.href });
      await Promise.all(
        cookies.map((c) =>
          chrome.cookies.remove({
            url: `${url.protocol}//${c.domain.startsWith(".") ? c.domain.substring(1) : c.domain}${c.path}`,
            name: c.name,
            storeId: c.storeId
          }).catch(() => null)
        )
      );

      // Tell tab(s) on that origin to clear storage (content script)
      const tabs = await chrome.tabs.query({ url: `${url.origin}/*` });
      await Promise.all(
        tabs.map((t) =>
          chrome.tabs.sendMessage(t.id, { type: "SG_CLEAR_STORAGE", payload: { origin } }).catch(() => null)
        )
      );

      // Refresh stored metrics after clearing
      await upsertOrigin(origin, {
        cookiesCount: 0,
        cookiesBytesEstimate: 0,
        storageBytesEstimate: 0,
        storageEvents: 0
      });

      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message" });
  })();

  // Keep the message channel open for async
  return true;
});

// Cookie changes can be used to keep metrics fresh
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  // We don't know exact origin here reliably; dashboard refresh will still work.
  // Optional: could map cookie.domain to multiple origins, but keep v0 simple.
});

