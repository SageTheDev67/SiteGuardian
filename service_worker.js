const DB_KEY = "sg_db_v1";

const DEFAULTS = {
  settings: {
    snapshotEveryMinutes: 30,
    defaultThresholdKB: 256,
    historyDays: 30
  },
  exclusions: {
    hostnames: []
  },
  sites: {}
};

const DAY_MS = 24 * 60 * 60 * 1000;

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function originHost(origin) { try { return new URL(origin).hostname; } catch { return ""; } }
function safeOrigin(u) { try { return new URL(u).origin; } catch { return null; } }

async function loadDB() {
  const res = await chrome.storage.local.get(DB_KEY);
  return res[DB_KEY] || structuredClone(DEFAULTS);
}
async function saveDB(db) {
  await chrome.storage.local.set({ [DB_KEY]: db });
}
async function withDB(fn) {
  const db = await loadDB();
  const out = await fn(db);
  await saveDB(db);
  return out;
}

function excluded(db, hostname) {
  return db.exclusions.hostnames.includes(hostname);
}

function getSite(db, origin) {
  const existing = db.sites[origin];
  if (existing) return existing;

  return (db.sites[origin] = {
    origin,
    hostname: originHost(origin),
    lastSeen: 0,

    cookiesCount: 0,
    cookiesBytesEstimate: 0,
    thirdPartyCookies: 0,

    persistentBytes: 0,
    sessionBytes: 0,

    serviceWorkerPresent: false,

    trackerHits7d: 0,
    storageEvents7d: 0,

    thresholdKB: db.settings.defaultThresholdKB,
    lastAlertedAt: 0,

    history: [],

    _buckets: {
      trackerHits7d: {},
      storageEvents7d: {}
    }
  });
}

function bucketAdd(site, field, delta) {
  const day = Math.floor(now() / DAY_MS);
  const b = site._buckets[field] || (site._buckets[field] = {});
  b[day] = (b[day] || 0) + delta;

  const cutoff = day - 7;
  for (const k of Object.keys(b)) {
    if (+k < cutoff) delete b[k];
  }

  site[field] = Object.values(b).reduce((a, v) => a + v, 0);
}

function sumStorageKB(site) {
  return Math.floor(((site.persistentBytes || 0) + (site.sessionBytes || 0)) / 1024);
}

function pruneHistory(site, keepDays) {
  const cutoff = now() - keepDays * DAY_MS;
  site.history = (site.history || []).filter(p => p.ts >= cutoff);
}

function computeTrust(site) {
  const trackerPenalty = Math.min(45, (site.trackerHits7d || 0) * 2);
  const thirdPartyCookiePenalty = Math.min(25, (site.thirdPartyCookies || 0) * 5);

  const persistentKB = Math.floor((site.persistentBytes || 0) / 1024);
  const storagePenalty = Math.min(20, Math.floor(persistentKB / 64));

  const churnPenalty = Math.min(10, Math.floor((site.storageEvents7d || 0) / 50));
  const swPenalty = site.serviceWorkerPresent ? 5 : 0;

  let score = 100 - trackerPenalty - thirdPartyCookiePenalty - storagePenalty - churnPenalty - swPenalty;
  score = clamp(score, 0, 100);
  if (score < 40) score = Math.floor(score * 0.85);
  return score;
}

async function refreshCookies(origin) {
  const url = new URL(origin);
  const cookies = await chrome.cookies.getAll({ url: url.href });

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

async function getMatchedRulesSince(sinceMs) {
  try {
    const res = await chrome.declarativeNetRequest.getMatchedRules({ minTimeStamp: sinceMs });
    return res?.rulesMatchedInfo || [];
  } catch {
    return [];
  }
}

function rollupMatches(matches) {
  const byOrigin = new Map();
  for (const m of matches) {
    const initiator = m?.request?.initiator;
    const origin = initiator ? safeOrigin(initiator) : null;
    if (!origin) continue;
    byOrigin.set(origin, (byOrigin.get(origin) || 0) + 1);
  }
  return byOrigin;
}

async function maybeAlert(db, site) {
  const storageKB = sumStorageKB(site);

  const hist = site.history || [];
  const prev = hist.length ? (hist[hist.length - 1].storageKB ?? storageKB) : storageKB;

  const delta = storageKB - prev;
  if (delta <= 0) return;

  const threshold = site.thresholdKB ?? db.settings.defaultThresholdKB;

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

async function runSnapshot() {
  const matches = await getMatchedRulesSince(now() - DAY_MS);
  const byOrigin = rollupMatches(matches);

  await withDB(async (db) => {
    // Update tracker hits
    for (const [origin, count] of byOrigin.entries()) {
      const hostname = originHost(origin);
      if (!hostname || excluded(db, hostname)) continue;

      const site = getSite(db, origin);
      site.lastSeen = now();
      bucketAdd(site, "trackerHits7d", count);
    }

    // Append history for all tracked sites
    for (const origin of Object.keys(db.sites)) {
      const site = db.sites[origin];
      if (!site?.hostname) continue;
      if (excluded(db, site.hostname)) continue;

      const trust = computeTrust(site);

      pruneHistory(site, db.settings.historyDays);
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

chrome.runtime.onInstalled.addListener(async () => {
  const db = await loadDB();
  await saveDB(db);
  chrome.alarms.create("sg_snapshot", { periodInMinutes: db.settings.snapshotEveryMinutes });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name === "sg_snapshot") await runSnapshot();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "SG_GET_STATE") {
        const db = await loadDB();
        return sendResponse({ ok: true, db });
      }

      if (msg?.type === "SG_SET_EXCLUDED") {
        const { hostname, excluded: ex } = msg.payload || {};
        if (!hostname) return sendResponse({ ok: false, error: "hostname missing" });

        await withDB(async (db) => {
          const list = db.exclusions.hostnames;
          const has = list.includes(hostname);
          if (ex && !has) list.push(hostname);
          if (!ex && has) db.exclusions.hostnames = list.filter(x => x !== hostname);
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

        const tabs = await chrome.tabs.query({ url: `${url.origin}/*` });
        await Promise.allSettled(
          tabs.map(t => chrome.tabs.sendMessage(t.id, { type: "SG_CLEAR_STORAGE" }))
        );

        await withDB(async (db) => {
          const site = getSite(db, origin);
          site.cookiesCount = 0;
          site.cookiesBytesEstimate = 0;
          site.thirdPartyCookies = 0;
          site.persistentBytes = 0;
          site.sessionBytes = 0;
          site.serviceWorkerPresent = false;
          site.trackerHits7d = 0;
          site.storageEvents7d = 0;
          site._buckets = { trackerHits7d: {}, storageEvents7d: {} };
          pruneHistory(site, db.settings.historyDays);
          return db;
        });

        return sendResponse({ ok: true });
      }

      if (msg?.type === "SG_METRICS") {
        const p = msg.payload || {};
        const origin = p.origin;
        if (!origin) return sendResponse({ ok: false, error: "origin missing" });

        await withDB(async (db) => {
          const hostname = originHost(origin);
          if (!hostname || excluded(db, hostname)) return db;

          const site = getSite(db, origin);
          site.lastSeen = now();
          site.persistentBytes = p.persistentBytes ?? site.persistentBytes;
          site.sessionBytes = p.sessionBytes ?? site.sessionBytes;
          site.serviceWorkerPresent = !!p.serviceWorkerPresent;

          const delta = p.storageEventsDelta ?? 0;
          if (delta) bucketAdd(site, "storageEvents7d", delta);

          return db;
        });

        const c = await refreshCookies(origin);
        await withDB(async (db) => {
          const hostname = originHost(origin);
          if (!hostname || excluded(db, hostname)) return db;

          const site = getSite(db, origin);
          site.cookiesCount = c.cookiesCount;
          site.cookiesBytesEstimate = c.cookiesBytesEstimate;
          site.thirdPartyCookies = c.thirdPartyCookies;
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
