const DB_KEY = "sg_db_v2";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  settings: {
    snapshotEveryMinutes: 30,
    defaultThresholdKB: 256,
    historyDays: 30,

    // New:
    dailyReportEnabled: false,
    dailyReportHourLocal: 9, // 0-23 local time
    dailyReportTopN: 5
  },
  exclusions: {
    hostnames: []
  },
  meta: {
    lastSnapshotAt: 0
  },
  sites: {}
};

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function originHost(origin) { try { return new URL(origin).hostname; } catch { return ""; } }
function safeOrigin(u) { try { return new URL(u).origin; } catch { return null; } }

function startOfLocalDayMs(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

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

    // New: for "visited today"
    lastSeenToday: 0,

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

// Strong trust score (maxed weighting)
function computeTrust(site) {
  const trackerPenalty = Math.min(55, (site.trackerHits7d || 0) * 2.5);
  const thirdPartyCookiePenalty = Math.min(25, (site.thirdPartyCookies || 0) * 5);

  const persistentKB = Math.floor((site.persistentBytes || 0) / 1024);
  const storagePenalty = Math.min(22, Math.floor(persistentKB / 64));

  const churnPenalty = Math.min(12, Math.floor((site.storageEvents7d || 0) / 50));
  const swPenalty = site.serviceWorkerPresent ? 5 : 0;

  // Persistent > Session = more suspicious (small penalty)
  const sessionRatioPenalty = (site.persistentBytes || 0) > (site.sessionBytes || 0) ? 5 : 0;

  let score = 100 - trackerPenalty - thirdPartyCookiePenalty - storagePenalty - churnPenalty - swPenalty - sessionRatioPenalty;
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

/**
 * Tracker attribution:
 * DNR matched rules provide tabId (best) and often initiator (fallback).
 */
const tabTopOrigin = new Map(); // tabId -> origin

async function updateTabTopOrigin(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const o = tab?.url ? safeOrigin(tab.url) : null;
    if (o) tabTopOrigin.set(tabId, o);
  } catch {}
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.url) {
    const o = safeOrigin(changeInfo.url);
    if (o) tabTopOrigin.set(tabId, o);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateTabTopOrigin(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabTopOrigin.delete(tabId);
});

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
    const req = m?.request || {};
    const tabId = req.tabId;

    let origin = null;

    // best: tabId -> top origin
    if (typeof tabId === "number" && tabId >= 0) {
      origin = tabTopOrigin.get(tabId) || null;
    }

    // fallback: initiator origin
    if (!origin && req.initiator) {
      origin = safeOrigin(req.initiator);
    }

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

  // anti-spam: 60 minutes cooldown
  if (site.lastAlertedAt && (now() - site.lastAlertedAt) < 60 * 60 * 1000) return;

  if (delta >= threshold) {
    site.lastAlertedAt = now();
    await chrome.notifications.create(`sg_growth_${site.hostname}_${site.lastAlertedAt}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "SiteGuardian alert",
      message: `${site.hostname} storage jumped +${delta} KB (threshold ${threshold} KB)`
    });
  }
}

function computeWorstToday(db) {
  const start = startOfLocalDayMs();
  const sites = Object.values(db.sites || {})
    .filter(s => s?.hostname)
    .filter(s => !excluded(db, s.hostname))
    .filter(s => (s.lastSeenToday || 0) >= start);

  if (!sites.length) return null;

  sites.sort((a, b) => {
    const ta = a.history?.at(-1)?.trust ?? 100;
    const tb = b.history?.at(-1)?.trust ?? 100;
    if (ta !== tb) return ta - tb;
    return (b.lastSeenToday || 0) - (a.lastSeenToday || 0);
  });

  const worst = sites[0];
  return {
    hostname: worst.hostname,
    trust: worst.history?.at(-1)?.trust ?? 100,
    trackers7d: worst.trackerHits7d || 0,
    storageKB: sumStorageKB(worst)
  };
}

function computeLeaderboard(db, topN = 10) {
  const sites = Object.values(db.sites || {})
    .filter(s => s?.hostname)
    .filter(s => !excluded(db, s.hostname));

  sites.sort((a, b) => {
    const ta = a.history?.at(-1)?.trust ?? 100;
    const tb = b.history?.at(-1)?.trust ?? 100;
    if (ta !== tb) return ta - tb; // worst first
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  return sites.slice(0, topN).map(s => ({
    hostname: s.hostname,
    trust: s.history?.at(-1)?.trust ?? 100,
    trackers7d: s.trackerHits7d || 0,
    storageKB: sumStorageKB(s),
    lastSeen: s.lastSeen || 0
  }));
}

async function runSnapshot({ sinceMs, reason } = {}) {
  await withDB(async (db) => {
    const last = db.meta?.lastSnapshotAt || 0;

    // Default: snapshot since lastSnapshotAt; cap to 24h back for safety
    const fallbackSince = Math.max(now() - DAY_MS, last || (now() - DAY_MS));
    const since = typeof sinceMs === "number" ? sinceMs : fallbackSince;

    const matches = await getMatchedRulesSince(since);
    const byOrigin = rollupMatches(matches);

    // Apply tracker deltas
    for (const [origin, count] of byOrigin.entries()) {
      const hostname = originHost(origin);
      if (!hostname || excluded(db, hostname)) continue;

      const site = getSite(db, origin);
      site.lastSeen = now();
      site.lastSeenToday = now();
      bucketAdd(site, "trackerHits7d", count);
    }

    // Append a history point for each tracked site
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

    db.meta.lastSnapshotAt = now();

    // (debug-friendly) store last snapshot reason (safe)
    db.meta.lastSnapshotReason = reason || "scheduled";

    return db;
  });
}

function scheduleDailyReportAlarm(db) {
  const hour = clamp(db.settings.dailyReportHourLocal ?? 9, 0, 23);

  const d = new Date();
  d.setHours(hour, 0, 0, 0);

  // if already passed today, schedule for tomorrow
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);

  chrome.alarms.create("sg_daily_report", { when: d.getTime() });
}

async function sendDailyReportIfEnabled() {
  const db = await loadDB();
  if (!db.settings.dailyReportEnabled) {
    scheduleDailyReportAlarm(db);
    return;
  }

  const worst = computeWorstToday(db);
  const top = computeLeaderboard(db, db.settings.dailyReportTopN || 5);

  let message = "";
  if (!worst) {
    message = "No sites visited today yet.";
  } else {
    message =
      `Worst today: ${worst.hostname} (${worst.trust}/100). ` +
      `Trackers: ${worst.trackers7d} | Storage: ${worst.storageKB} KB`;
  }

  if (top.length) {
    const list = top
      .slice(0, 3)
      .map((x, i) => `${i + 1}) ${x.hostname} (${x.trust}/100)`)
      .join("  ");
    message += `  Top risks: ${list}`;
  }

  await chrome.notifications.create(`sg_daily_${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "SiteGuardian daily report",
    message
  });

  scheduleDailyReportAlarm(db);
}

// Install scheduling
chrome.runtime.onInstalled.addListener(async () => {
  const db = await loadDB();
  if (!db.meta) db.meta = structuredClone(DEFAULTS.meta);
  await saveDB(db);

  chrome.alarms.create("sg_snapshot", { periodInMinutes: db.settings.snapshotEveryMinutes });
  scheduleDailyReportAlarm(db);
});

// Alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name === "sg_snapshot") {
    await runSnapshot({ reason: "scheduled" });
  }
  if (alarm?.name === "sg_daily_report") {
    await sendDailyReportIfEnabled();
  }
});

// Message API
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "SG_GET_STATE") {
        const db = await loadDB();
        const worstToday = computeWorstToday(db);
        const leaderboard = computeLeaderboard(db, 10);
        return sendResponse({ ok: true, db, worstToday, leaderboard });
      }

      // Instant tracker update when popup opens
      if (msg?.type === "SG_SNAPSHOT_NOW") {
        const db = await loadDB();
        const since = db.meta?.lastSnapshotAt || Math.max(Date.now() - DAY_MS, 0);
        await runSnapshot({ sinceMs: since, reason: "popup_open" });
        const db2 = await loadDB();
        const worstToday = computeWorstToday(db2);
        const leaderboard = computeLeaderboard(db2, 10);
        return sendResponse({ ok: true, db: db2, worstToday, leaderboard });
      }

      if (msg?.type === "SG_SET_DAILY_REPORT") {
        const { enabled } = msg.payload || {};
        await withDB(async (db) => {
          db.settings.dailyReportEnabled = !!enabled;
          return db;
        });
        const db = await loadDB();
        scheduleDailyReportAlarm(db);
        return sendResponse({ ok: true });
      }

      if (msg?.type === "SG_SET_DAILY_REPORT_HOUR") {
        const { hour } = msg.payload || {};
        await withDB(async (db) => {
          db.settings.dailyReportHourLocal = clamp(Math.floor(Number(hour)), 0, 23);
          return db;
        });
        const db = await loadDB();
        scheduleDailyReportAlarm(db);
        return sendResponse({ ok: true });
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
          site.lastSeenToday = now();
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
