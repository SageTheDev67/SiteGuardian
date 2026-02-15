import { drawLineChart } from "./chart.js";

const rowsEl = document.getElementById("rows");
const emptyEl = document.getElementById("emptyState");
const searchEl = document.getElementById("search");
const avgTrustPill = document.getElementById("avgTrustPill");

const mTrackers = document.getElementById("mTrackers");
const mStorage = document.getElementById("mStorage");
const m3p = document.getElementById("m3p");
const mSites = document.getElementById("mSites");

const chartCanvas = document.getElementById("chart");
const rangeBtns = [...document.querySelectorAll(".segBtn")];
const tabBtns = [...document.querySelectorAll(".tab")];

// New
const worstTodayMain = document.getElementById("worstTodayMain");
const worstTodayMeta = document.getElementById("worstTodayMeta");
const leaderList = document.getElementById("leaderList");
const dailyToggle = document.getElementById("dailyToggle");
const dailyHour = document.getElementById("dailyHour");

let state = null;
let worstToday = null;
let leaderboard = [];
let selectedOrigin = null;
let rangeDays = 7;
let activeTab = "tracked";

function fmtKB(kb){
  if (kb < 1024) return `${kb} KB`;
  return `${(kb/1024).toFixed(1)} MB`;
}

function trustColor(trust){
  if (trust >= 80) return "#16a34a";
  if (trust >= 50) return "#ca8a04";
  return "#dc2626";
}

// Instant update: snapshot now on popup open
async function getStateInstant(){
  const res = await chrome.runtime.sendMessage({ type: "SG_SNAPSHOT_NOW" });
  if (!res?.ok) throw new Error(res?.error || "Failed to load");
  return res;
}

function totals(db){
  const sites = Object.values(db.sites || {});
  const tracked = sites.filter(s => s?.hostname && !db.exclusions.hostnames.includes(s.hostname));
  const totalTrackers = tracked.reduce((a,s)=>a+(s.trackerHits7d||0),0);
  const totalStorageKB = tracked.reduce((a,s)=>a+Math.floor(((s.persistentBytes||0)+(s.sessionBytes||0))/1024),0);
  const total3p = tracked.reduce((a,s)=>a+(s.thirdPartyCookies||0),0);
  const avgTrust = tracked.length
    ? Math.round(tracked.reduce((a,s)=>a+((s.history?.at(-1)?.trust) ?? 100),0)/tracked.length)
    : 100;
  return { tracked, totalTrackers, totalStorageKB, total3p, avgTrust };
}

function ensureSelection(tracked){
  if (selectedOrigin && state?.sites?.[selectedOrigin]) return;
  selectedOrigin = tracked[0]?.origin || null;
}

function buildChart(site){
  const hist = (site?.history || []).slice();
  const cutoff = Date.now() - rangeDays*24*60*60*1000;
  const pts = hist.filter(p => p.ts >= cutoff);

  const points = pts.map((p,i)=>({ x:i, y: p.storageKB }));
  if (points.length < 2) {
    drawLineChart(chartCanvas, [{x:0,y:0},{x:1,y:0}]);
    return;
  }
  drawLineChart(chartCanvas, points);
}

function rowHTML(site, isExcluded){
  const storageKB = Math.floor(((site.persistentBytes||0)+(site.sessionBytes||0))/1024);
  const trust = site.history?.at(-1)?.trust ?? 100;
  const color = trustColor(trust);

  const actions = isExcluded
    ? `<button class="btn" data-act="unexclude" data-host="${site.hostname}">Unexclude</button>`
    : `
      <button class="btn" data-act="select" data-origin="${site.origin}">View</button>
      <button class="btn" data-act="exclude" data-host="${site.hostname}">Exclude</button>
      <button class="btn" data-act="threshold" data-origin="${site.origin}">Threshold</button>
      <button class="btn danger" data-act="clear" data-origin="${site.origin}">Clear</button>
    `;

  return `
    <tr>
      <td><b>${site.hostname}</b></td>
      <td><span class="badge">${site.trackerHits7d||0}</span></td>
      <td>${fmtKB(storageKB)}</td>
      <td>${site.thirdPartyCookies||0}</td>
      <td><span class="badge" style="color:${color}">${trust}/100</span></td>
      <td class="actions">${actions}</td>
    </tr>
  `;
}

function renderTodayAndLeaderboard(){
  // Daily settings UI
  dailyToggle.checked = !!state?.settings?.dailyReportEnabled;
  const hour = state?.settings?.dailyReportHourLocal ?? 9;
  dailyHour.value = String(hour);

  // Worst today
  if (!worstToday) {
    worstTodayMain.textContent = "—";
    worstTodayMeta.textContent = "No sites visited today yet.";
  } else {
    const c = trustColor(worstToday.trust);
    worstTodayMain.innerHTML = `<span style="color:${c}">${worstToday.hostname}</span> (${worstToday.trust}/100)`;
    worstTodayMeta.textContent = `Trackers (7d): ${worstToday.trackers7d}  •  Storage: ${worstToday.storageKB} KB`;
  }

  // Leaderboard list
  leaderList.innerHTML = "";
  const list = (leaderboard || []).slice(0, 10);
  for (const item of list) {
    const c = trustColor(item.trust);
    const html = `
      <div class="leaderItem">
        <div class="leaderLeft">
          <div class="leaderHost" style="color:${c}">${item.hostname}</div>
          <div class="leaderMeta">Trackers: ${item.trackers7d} • Storage: ${item.storageKB} KB</div>
        </div>
        <div class="badge" style="color:${c}">${item.trust}/100</div>
      </div>
    `;
    leaderList.insertAdjacentHTML("beforeend", html);
  }
}

function render(){
  const db = state;
  const q = (searchEl.value || "").toLowerCase();
  const t = totals(db);

  mTrackers.textContent = t.totalTrackers;
  mStorage.textContent = fmtKB(t.totalStorageKB);
  m3p.textContent = t.total3p;
  mSites.textContent = t.tracked.length;
  avgTrustPill.textContent = `Avg Trust ${t.avgTrust}%`;

  ensureSelection(t.tracked);

  const sites = Object.values(db.sites || {}).filter(s => s?.hostname);
  const excludedSet = new Set(db.exclusions.hostnames);

  let visible = sites.filter(s => s.hostname.toLowerCase().includes(q));
  if (activeTab === "tracked") visible = visible.filter(s => !excludedSet.has(s.hostname));
  if (activeTab === "excluded") visible = visible.filter(s => excludedSet.has(s.hostname));

  // Worst trust first
  visible.sort((a,b) => {
    const ta = a.history?.at(-1)?.trust ?? 100;
    const tb = b.history?.at(-1)?.trust ?? 100;
    if (ta !== tb) return ta - tb;
    return (b.lastSeen||0) - (a.lastSeen||0);
  });

  rowsEl.innerHTML = "";
  for (const s of visible) rowsEl.insertAdjacentHTML("beforeend", rowHTML(s, excludedSet.has(s.hostname)));

  emptyEl.style.display = visible.length ? "none" : "block";

  // chart = selected origin
  const selected = selectedOrigin ? db.sites[selectedOrigin] : null;
  buildChart(selected);

  // today + leaderboard
  renderTodayAndLeaderboard();
}

async function refreshInstant(){
  const res = await getStateInstant();
  state = res.db;
  worstToday = res.worstToday || null;
  leaderboard = res.leaderboard || [];
  render();
}

rowsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const act = btn.dataset.act;

  if (act === "select") {
    selectedOrigin = btn.dataset.origin;
    render();
    return;
  }

  if (act === "clear") {
    btn.disabled = true;
    await chrome.runtime.sendMessage({ type: "SG_CLEAR_SITE", payload: { origin: btn.dataset.origin } });
    await refreshInstant();
    return;
  }

  if (act === "exclude") {
    btn.disabled = true;
    await chrome.runtime.sendMessage({ type: "SG_SET_EXCLUDED", payload: { hostname: btn.dataset.host, excluded: true } });
    await refreshInstant();
    return;
  }

  if (act === "unexclude") {
    btn.disabled = true;
    await chrome.runtime.sendMessage({ type: "SG_SET_EXCLUDED", payload: { hostname: btn.dataset.host, excluded: false } });
    await refreshInstant();
    return;
  }

  if (act === "threshold") {
    const origin = btn.dataset.origin;
    const current = state?.sites?.[origin]?.thresholdKB ?? state?.settings?.defaultThresholdKB ?? 256;
    const nextStr = prompt("Alert threshold in KB (growth between snapshots):", String(current));
    if (nextStr == null) return;
    const next = Math.max(0, Math.floor(Number(nextStr)));
    if (!Number.isFinite(next)) return;

    await chrome.runtime.sendMessage({ type: "SG_SET_THRESHOLD", payload: { origin, thresholdKB: next } });
    await refreshInstant();
  }
});

searchEl.addEventListener("input", () => render());

rangeBtns.forEach(b => b.addEventListener("click", () => {
  rangeBtns.forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  rangeDays = Number(b.dataset.range) || 7;
  render();
}));

tabBtns.forEach(b => b.addEventListener("click", () => {
  tabBtns.forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  activeTab = b.dataset.tab;
  render();
}));

dailyToggle.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "SG_SET_DAILY_REPORT",
    payload: { enabled: dailyToggle.checked }
  });
  await refreshInstant();
});

dailyHour.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "SG_SET_DAILY_REPORT_HOUR",
    payload: { hour: Number(dailyHour.value) }
  });
  await refreshInstant();
});

// Run instant snapshot & render
refreshInstant();
