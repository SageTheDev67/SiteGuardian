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

let state = null;
let selectedOrigin = null;
let rangeDays = 7;
let activeTab = "tracked";

function fmtKB(kb){
  if (kb < 1024) return `${kb} KB`;
  return `${(kb/1024).toFixed(1)} MB`;
}

function calcTotals(db){
  const sites = Object.values(db.sites || {});
  const tracked = sites.filter(s => s?.hostname && !db.exclusions.hostnames.includes(s.hostname));
  const totalTrackers = tracked.reduce((a,s)=>a+(s.trackerHits7d||0),0);
  const totalStorageKB = tracked.reduce((a,s)=>a+Math.floor(((s.persistentBytes||0)+(s.sessionBytes||0))/1024),0);
  const total3p = tracked.reduce((a,s)=>a+(s.thirdPartyCookies||0),0);
  const avgTrust = tracked.length ? Math.round(tracked.reduce((a,s)=>a+((s.history?.at(-1)?.trust) ?? 100),0)/tracked.length) : 100;
  return { tracked, totalTrackers, totalStorageKB, total3p, avgTrust };
}

async function getState(){
  const res = await chrome.runtime.sendMessage({ type: "SG_GET_STATE" });
  if (!res?.ok) throw new Error(res?.error || "Failed to load");
  return res.db;
}

function pickDefaultSite(tracked){
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

function rowHTML(site, excluded){
  const storageKB = Math.floor(((site.persistentBytes||0)+(site.sessionBytes||0))/1024);
  const trust = site.history?.at(-1)?.trust ?? 100;

  const actions = excluded
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
      <td><span class="badge">${trust}/100</span></td>
      <td class="actions">${actions}</td>
    </tr>
  `;
}

function render(){
  const db = state;
  const q = (searchEl.value || "").toLowerCase();
  const totals = calcTotals(db);

  mTrackers.textContent = totals.totalTrackers;
  mStorage.textContent = fmtKB(totals.totalStorageKB);
  m3p.textContent = totals.total3p;
  mSites.textContent = totals.tracked.length;
  avgTrustPill.textContent = `Avg Trust ${totals.avgTrust}%`;

  pickDefaultSite(totals.tracked);

  const sites = Object.values(db.sites || {}).filter(s => s?.hostname);
  const excludedHosts = new Set(db.exclusions.hostnames);

  let visible = sites.filter(s => s.hostname.toLowerCase().includes(q));
  if (activeTab === "tracked") visible = visible.filter(s => !excludedHosts.has(s.hostname));
  if (activeTab === "excluded") visible = visible.filter(s => excludedHosts.has(s.hostname));

  visible.sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0));

  rowsEl.innerHTML = "";
  for (const s of visible) rowsEl.insertAdjacentHTML("beforeend", rowHTML(s, excludedHosts.has(s.hostname)));

  emptyEl.style.display = visible.length ? "none" : "block";

  // chart: selected origin
  const selected = selectedOrigin ? db.sites[selectedOrigin] : null;
  buildChart(selected);
}

async function refresh(){
  state = await getState();
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
    await refresh();
    return;
  }

  if (act === "exclude") {
    btn.disabled = true;
    await chrome.runtime.sendMessage({ type: "SG_SET_EXCLUDED", payload: { hostname: btn.dataset.host, excluded: true } });
    await refresh();
    return;
  }

  if (act === "unexclude") {
    btn.disabled = true;
    await chrome.runtime.sendMessage({ type: "SG_SET_EXCLUDED", payload: { hostname: btn.dataset.host, excluded: false } });
    await refresh();
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
    await refresh();
    return;
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

refresh();
