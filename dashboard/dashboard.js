const listEl = document.getElementById("list");
const template = document.getElementById("rowTemplate");
const searchEl = document.getElementById("search");
const refreshBtn = document.getElementById("refresh");

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function minutesAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m <= 0) return "just now";
  if (m === 1) return "1 min ago";
  return `${m} min ago`;
}

async function getDB() {
  const res = await chrome.runtime.sendMessage({ type: "SG_GET_DB" });
  return res?.db || {};
}

async function clearOrigin(origin) {
  await chrome.runtime.sendMessage({ type: "SG_CLEAR_SITE", payload: { origin } });
}

function render(db, q = "") {
  listEl.innerHTML = "";
  const items = Object.values(db)
    .filter((x) => x?.hostname)
    .filter((x) => x.hostname.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.style.opacity = "0.75";
    empty.style.padding = "8px";
    empty.textContent = "No sites recorded yet. Browse a few pages, then open this dashboard again.";
    listEl.appendChild(empty);
    return;
  }

  for (const it of items) {
    const node = template.content.cloneNode(true);
    const row = node.querySelector(".row");
    const host = node.querySelector(".host");
    const meta = node.querySelector(".meta");
    const score = node.querySelector(".score");
    const clearBtn = node.querySelector(".clear");

    host.textContent = it.hostname;
    meta.textContent =
      `Cookies: ${it.cookiesCount ?? 0} • Storage: ${formatBytes(it.storageBytesEstimate ?? 0)} • Seen: ${minutesAgo(it.lastSeen ?? Date.now())}`;

    score.textContent = `${it.trustScore ?? 0}/100`;

    clearBtn.addEventListener("click", async () => {
      clearBtn.disabled = true;
      clearBtn.textContent = "Clearing...";
      try {
        await clearOrigin(it.origin);
      } finally {
        clearBtn.disabled = false;
        clearBtn.textContent = "Clear";
        const newDB = await getDB();
        render(newDB, searchEl.value);
      }
    });

    listEl.appendChild(row);
  }
}

async function refresh() {
  const db = await getDB();
  render(db, searchEl.value);
}

searchEl.addEventListener("input", () => refresh());
refreshBtn.addEventListener("click", () => refresh());

refresh();

