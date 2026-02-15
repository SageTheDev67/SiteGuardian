// service_worker.js (MV3 module)

const DB_KEY = "sg_db_v1";

const DEFAULTS = {
  settings: {
    snapshotEveryMinutes: 30,
    defaultThresholdKB: 256,     // per-site default alert threshold (growth)
    historyDays: 30
  },
  exclusions: {
    hostnames: []                // trusted sites ignored
  },
  sites: {
    // [origin]: site record
  }
};

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function toHostname(origin) { try { return new URL(origin).hostname; } catch { return ""; } }
function toOrigin(url) { try { return new URL(url).origin; } catch { return null; } }

async function loadDB() {
  const res = await chrome.storage.local.get(DB_KEY);
  return res[DB_KEY] || structuredClone(DEFAULTS);
}
async function saveDB(db) {
  await chrome.storage.local.set({ [DB_KEY]: db });
}
async function withDB(mutator) {
  const db = await loadDB();
  const out = await mutator(db);
  await saveDB(db);
  return out;
}

function isExcluded(db, hostname) {
  return db.exclusions.hostnames.includes(hostname);
}

// --- Trust score (weighted, aggressive) ---
function computeTrust(site) {
  // Trackers are the biggest hit.
  const trackerPenalty = Math.min(45, (site.trackerHits7d || 0) * 2);

  // Third-party cookies are serious.
  const thirdPartyCookiePenalty = Math.min(25, (site.thirdPartyCookies || 0) * 5);

  // Persistent storage size matters.
  const persistentKB = Math.floor((site.persistentBytes || 0) / 1024);
  const storagePenalty = Math.min(20, Math.floor(persistentKB / 64)); // 1 point per 64KB

  // Churn indicates tracking / profiling.
  const churnPenalty = Math.min(10, Math.floor((site.storageEvents7d || 0) / 50));

  // Service workers can be used for tracking + persistence (not always bad, but still a signal).
  const swPenalty = site.serviceWorkerPresent ? 5 : 0;

  let score = 100 - trackerPenalty - thirdPartyCookiePenalty - storagePenalty - churnPenalty - swPenalty;
  score = clamp(score, 0, 100);

  // Map to a “safer feels” curve: punish low scores more.
  if (score < 40) score = Math.floor(score * 0.85);
  return score;
}

// --- Cookie metrics (including third-party estimate) ---
async function refreshCookiesForOrigin(origin) {
  const url = new URL(origin);
  const cookies = await chrome.cookies.getAll({ url: url.href });

  // Estimate 3P cookies by domain mismatch.
  // Not perfect, but strong enough.
  const host = url.hostname.replace(/^www\./, "");
  let thirdParty = 0;
  let bytes = 0;

  for (const c of cookies) {
    const cd = (c.domain || "").replace(/^\./, "").replace(/^www\./, "");
    if (cd && cd !== host && !host.endsWith("." + cd) && !cd.endsWith("." + host)) thirdParty++;

    bytes += (c.name?.length || 0) + (c.value?.length || 0) + (c.domain?.length || 0) + (c.path?.length || 0) + 32;
  }

  return { cookiesCount: cookies.length, cookiesBytesEstimate: bytes, thirdPartyCookies: thirdParty };
}

// --- Tracker metrics from DNR feedback ---
// We cannot “see every request body”, but we CAN count matches for our rules (which is what we want).
async function getTrackerMatchesSince(sinceMs) {
  // Returns array of matched requests info. Can be heavy; keep it bounded.
  // If browser limits exist, we still get a useful sample.
  const res = await chrome.declarativeNetRequest.getMatchedRules({ minTimeStamp: sinceMs });
  return res?.rulesMatchedInfo || [];
}

function rollupByTopFrameOrigin(matches) {
  const map = new Map(); // origin -> count
  for (const m of matches) {
    const tf = m.request?.initiator || m.request?.documentId || null;
    // MatchedRulesInfo can vary; safest: use m.request?.initiator when present
    const origin = m.request?.initiator ? toOrigin(m.request.initiator) : null;
    if (!origin) continue;
    map.set(origin, (map.get(origin) || 0) + 1);
  }
  return map;
}

// --- History helpers ---
function pruneHistory(history, keepDays) {
  const cutoff = now() - keepDays * 24 * 60 * 60 * 1000;
  return (history || []).filter(p => p.ts >= cutoff);
}

function sumStorageKB(site) {
  return Math.floor(((site.persistentBytes || 0) + (site.sessionBytes || 0)) / 1024);
}

function getSite(db, origin) {
  const s = db.sites[origin];
  if (s) return s;

  return (db.sites[origin] = {
    origin,
    hostname: toHostname(origin),

    lastSeen: 0,

    // Cookies
    cookiesCount: 0,
    cookiesBytesEstimate: 0,
    thirdPartyCookies: 0,

    // Storage
    persistentBytes: 0,  // localStorage + IndexedDB + Cache estimate
    sessionBytes: 0,     // sessionStorage
    storageEvents7d: 0,

    // Features present
    serviceWorkerPresent: false,

    // Tracker hits
    trackerHits7d: 0,

    // Alerts
    thresholdKB: db.settings.defaultThresholdKB,
    lastAlertedAt: 0,

    // Time series
    history: [] // { ts, storageKB, trackerHits7d, trust }
  });
}

function bump7dCounter(site, field, delta) {
  // Store a rolling window using a tiny event log.
  // Keep minimal by storing day buckets (7 buckets).
  const day = Math.floor(now() / (24 * 60 * 60 * 1000));
  const key = `${field}_buckets`;
  site[key] ||= {};
  site[key][day] = (site[key][day] || 0) + delta;

  // prune buckets older than 7 days
  const cutoffDay = day - 7;
  for (const k of Object.keys(site[key])) {
    if (+k < cutoffDay) delete site[key][k];
  }

  // set summary
  site[field] = Object.values(site[key]).reduce((a, b) => a + b, 0);
}

// --- Alerts ---
async function maybeAlert(db, site) {
  const storageKB = sumStorageKB(site);
  const hist = site.history || [];
  const last = hist.length ? hist[hist.length - 1] : null;

  // Growth = compared to last snapshot.
  const prev = last?.storageKB ?? storageKB;
  const delta = storageKB - prev;
  if (delta <= 0) return;

  const threshold = site.thresholdKB ?? db.settings.defaultThresholdKB;

  // Avoid spamming: min 60 minutes between alerts per site.
  if (site.lastAlertedAt && (now() - site.lastAlertedAt) < 60 * 60 * 1000) return;

  if (delta >= threshold) {
    site.lastAlertedAt = now();
    await chrome.notifications.create(`sg_${site.hostname}_${site.lastAlertedAt}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "SiteGuardian alert",
      message: `${site.hostname} storage jumped +${delta} KB (threshold ${threshold} KB)`
    });
  }
}

// --- Snapshots (history + tracker rollup) ---
async function runSnapshot() {
  const since = now() - 24 * 60 * 60 * 1000; // last day for DNR feedback sample
  const matches = await getTrackerMatchesSince(since);
  const byOrigin = rollupByTopFrameOrigin(matches);

  await withDB(async (db) => {
    for (const [origin, count] of byOrigin.entries()) {
      const hostname = toHostname(origin);
      if (!hostname || isExcluded(db, hostname)) continue;

      const site = getSite(db, origin);
      bump7dCounter(site, "trackerHits7d", count);
      site.lastSeen = now();
    }

    // Add a history point for every site (even those w/ no new trackers)
    for (const origin of Object.keys(db.sites)) {
      const site = db.sites[origin];
      if (!site?.hostname) continue;
      if (isExcluded(db, site.hostname)) continue;

      const trust = computeTrust(site);

      site.history = pruneHistory(site.history, db.settings.historyDays);
      site.history.push({
        ts: now(),
        storageKB: sumStorageKB(site),
        trackerHits7d: site.trackerHits7d || 0,
        trust
      });

      await maybeAlert(db, site);
    }

    return db;
  });
}

// --- Messages from content script + popup ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "SG_GET_STATE") {
        const db = await loadDB();
        return sendResponse({ ok: true, db });
      }

      if (msg?.type === "SG_SET_EXCLUDED") {
        const { hostname, excluded } = msg.payload || {};
        if (!hostname) return sendResponse({ ok: false, error: "hostname missing" });

        await withDB(async (db) => {
          const list = db.exclusions.hostnames;
          const has = list.includes(hostname);
          if (excluded && !has) list.push(hostname);
          if (!excluded && has) db.exclusions.hostnames = list.filter(x => x !== hostname);
          return db;
        });

        return sendResponse({ ok: true });
      }

      if (msg?.type === "SG_SET_THRESHOLD") {
        const { origin, thresholdKB } = msg.payload || {};
        if (!origin || typeof thresholdKB !== "number") return sendResponse({ ok: false });
        await withDB(async (db) => {
          const site = getSite(db, origin);
          site.thresholdKB = clamp(Math.floor(thresholdKB), 0, 999999);
          return db;
        });
        return sendResponse({ ok: true });
      }

      if (msg?.type === "SG_CLEAR_SITE") {
        const { origin } = msg.payload || {};
        if (!origin) return sendResponse({ ok: false, error: "origin missing" });

        const url = new URL(origin);
        // Remove cookies
        const cookies = await chrome.cookies.getAll({ url: url.href });
        await Promise.allSettled(
          cookies.map(c =>
            chrome.cookies.remove({
              url: `${url.protocol}//${(c.domain || "").replace(/^\./, "")}${c.path || "/"}`,
              name: c.name,
              storeId: c.storeId
            })
          )
        );

        // Ask tabs to clear in-page storage + IDB + Cache
        const tabs = await chrome.tabs.query({ url: `${url.origin}/*` });
        await Promise.allSettled(
          tabs.map(t => chrome.tabs.sendMessage(t.id, { type: "SG_CLEAR_STORAGE" }))
        );

        // Reset record
        await withDB(async (db) => {
          const site = getSite(db, origin);
          site.cookiesCount = 0;
          site.cookiesBytesEstimate = 0;
          site.thirdPartyCookies = 0;
          site.persistentBytes = 0;
          site.sessionBytes = 0;
          site.serviceWorkerPresent = false;
          site.storageEvents7d = 0;
          site.trackerHits7d = 0;
          site.history = pruneHistory(site.history, db.settings.historyDays);
          return db;
        });

        return sendResponse({ ok: true });
      }

      if (msg?.type === "SG_METRICS") {
        const payload = msg.payload || {};
        const origin = payload.origin;
        if (!origin) return sendResponse({ ok: false, error: "origin missing" });

        await withDB(async (db) => {
          const hostname = toHostname(origin);
          if (!hostname || isExcluded(db, hostname)) return db;

          const site = getSite(db, origin);

          site.lastSeen = now();
          site.persistentBytes = payload.persistentBytes ?? site.persistentBytes;
          site.sessionBytes = payload.sessionBytes ?? site.sessionBytes;
          site.serviceWorkerPresent = !!payload.serviceWorkerPresent;

          // bump churn counter
          const eventsDelta = payload.storageEventsDelta ?? 0;
          if (eventsDelta) bump7dCounter(site, "storageEvents7d", eventsDelta);

          return db;
        });

        // Update cookie metrics outside lock (faster)
        const cookieStats = await refreshCookiesForOrigin(origin);
        await withDB(async (db) => {
          const hostname = toHostname(origin);
          if (!hostname || isExcluded(db, hostname)) return db;

          const site = getSite(db, origin);
          site.cookiesCount = cookieStats.cookiesCount;
          site.cookiesBytesEstimate = cookieStats.cookiesBytesEstimate;
          site.thirdPartyCookies = cookieStats.thirdPartyCookies;
          return db;
        });

        return sendResponse({ ok: true });
      }

      return sendResponse({ ok: false, error: "unknown message" });
    } catch (e) {
      return sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});

// --- Scheduling ---
chrome.runtime.onInstalled.addListener(async () => {
  await saveDB(await loadDB()); // ensure initialized

  // snapshot alarm
  const db = await loadDB();
  chrome.alarms.create("sg_snapshot", { periodInMinutes: db.settings.snapshotEveryMinutes });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name === "sg_snapshot") {
    await runSnapshot();
  }
});
