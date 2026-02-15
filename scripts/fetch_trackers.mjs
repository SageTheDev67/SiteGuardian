// scripts/fetch_trackers.mjs
import fs from "node:fs";
import path from "node:path";

const OUT_FILE = path.join("lists", "trackers_domains.txt");

// Sources (URLs are inside code, as required)
const SOURCES = [
  // EasyPrivacy
  "https://easylist.to/easylist/easyprivacy.txt",
  // EasyList (contains many tracker/ads domains too)
  "https://easylist.to/easylist/easylist.txt",
  // Peter Lowe’s ad/tracking list
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
  // Disconnect.me tracking protection list (json)
  "https://disconnect.me/trackerprotection/disconnect-plain.json"
];

function isDomain(s) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) && !s.includes("..") && s.length <= 253;
}

function normalizeDomain(d) {
  return d
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function extractFromAdblock(text) {
  // Pull domains from patterns like:
  // ||example.com^
  // ||sub.example.com^$third-party
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("!") || l.startsWith("[") || l.startsWith("@@")) continue;

    const m = l.match(/^\|\|([a-z0-9.-]+)\^/i);
    if (m?.[1]) {
      const d = normalizeDomain(m[1]);
      if (isDomain(d)) out.push(d);
      continue;
    }

    // Some rules use plain domains in urlFilter-like patterns
    // Try a safe fallback: find domains inside the rule
    const m2 = l.match(/([a-z0-9.-]+\.[a-z]{2,})/i);
    if (m2?.[1]) {
      const d = normalizeDomain(m2[1]);
      if (isDomain(d)) out.push(d);
    }
  }
  return out;
}

function extractFromHosts(text) {
  // Hosts format like: 0.0.0.0 example.com
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const parts = l.split(/\s+/);
    if (parts.length >= 2) {
      const d = normalizeDomain(parts[1]);
      if (isDomain(d)) out.push(d);
    }
  }
  return out;
}

function extractFromDisconnectJSON(jsonText) {
  // disconnect-plain.json structure: categories -> services -> domains
  const out = [];
  let data;
  try { data = JSON.parse(jsonText); } catch { return out; }

  // The JSON usually has top-level "categories"
  const categories = data?.categories || data;
  if (!categories || typeof categories !== "object") return out;

  for (const cat of Object.values(categories)) {
    if (!cat || typeof cat !== "object") continue;

    const services = cat;
    for (const svc of Object.values(services)) {
      // svc often like: { "ServiceName": { "http://...": ["domain", "domain2"] } }
      if (!svc || typeof svc !== "object") continue;

      for (const entry of Object.values(svc)) {
        if (!entry || typeof entry !== "object") continue;
        for (const arr of Object.values(entry)) {
          if (!Array.isArray(arr)) continue;
          for (const dom of arr) {
            const d = normalizeDomain(String(dom));
            if (isDomain(d)) out.push(d);
          }
        }
      }
    }
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return await res.text();
}

(async () => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const domains = new Set();

  for (const url of SOURCES) {
    const text = await fetchText(url);

    if (url.includes("disconnect-plain.json")) {
      for (const d of extractFromDisconnectJSON(text)) domains.add(d);
      continue;
    }

    // Heuristic: yoyo hosts list is hosts format
    if (url.includes("pgl.yoyo.org")) {
      for (const d of extractFromHosts(text)) domains.add(d);
      continue;
    }

    // EasyList/EasyPrivacy: adblock format
    for (const d of extractFromAdblock(text)) domains.add(d);
  }

  // Remove obvious non-internet / noise
  const cleaned = [...domains]
    .filter(d => isDomain(d))
    .filter(d => !d.endsWith(".local"))
    .filter(d => d !== "localhost")
    .sort();

  fs.writeFileSync(OUT_FILE, cleaned.join("\n") + "\n", "utf8");
  console.log(`Wrote ${OUT_FILE} with ${cleaned.length} domains`);
})();
