import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const OUT_FILE = path.join("lists", "trackers_domains.txt");

// Use sources that are stable + public
const SOURCES = [
  // EasyPrivacy
  "https://easylist.to/easylist/easyprivacy.txt",
  // EasyList (extra coverage)
  "https://easylist.to/easylist/easylist.txt",
  // Peter Lowe hosts list
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
  // Disconnect plaintext list (working endpoint)
  "https://services.disconnect.me/disconnect-plaintext.json"
];

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects: ${url}`));
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(fetchText(next, redirectsLeft - 1));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Failed ${url} ${res.statusCode}`));
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function isDomain(s) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) && !s.includes("..") && s.length <= 253;
}

function normalizeDomain(d) {
  return d.trim().toLowerCase().replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
}

function extractFromAdblock(text) {
  const out = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("!") || l.startsWith("[") || l.startsWith("@@")) continue;

    // ||example.com^ style
    const m = l.match(/^\|\|([a-z0-9.-]+)\^/i);
    if (m?.[1]) {
      const d = normalizeDomain(m[1]);
      if (isDomain(d)) out.push(d);
      continue;
    }

    // fallback: first domain-like token in the line
    const m2 = l.match(/([a-z0-9.-]+\.[a-z]{2,})/i);
    if (m2?.[1]) {
      const d = normalizeDomain(m2[1]);
      if (isDomain(d)) out.push(d);
    }
  }

  return out;
}

function extractFromHosts(text) {
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

function extractFromDisconnectPlaintext(jsonText) {
  // It's JSON. We extract any domain-looking strings.
  const out = [];
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return out;
  }

  const stack = [obj];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) stack.push(x);
    } else if (typeof v === "string") {
      const s = normalizeDomain(v);
      if (isDomain(s)) out.push(s);
    }
  }
  return out;
}

(async () => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const domains = new Set();

  for (const url of SOURCES) {
    try {
      console.log(`Fetching ${url}`);
      const text = await fetchText(url);

      if (url.includes("pgl.yoyo.org")) {
        extractFromHosts(text).forEach((d) => domains.add(d));
      } else if (url.includes("services.disconnect.me")) {
        extractFromDisconnectPlaintext(text).forEach((d) => domains.add(d));
      } else {
        extractFromAdblock(text).forEach((d) => domains.add(d));
      }

      console.log(`OK ${url}`);
    } catch (e) {
      // IMPORTANT: do not fail the job if one source breaks
      console.log(`WARN ${url} -> ${String(e.message || e)}`);
    }
  }

  const final = [...domains]
    .map(normalizeDomain)
    .filter((d) => isDomain(d))
    .filter((d) => d !== "localhost")
    .filter((d) => !d.endsWith(".local"))
    .sort();

  fs.writeFileSync(OUT_FILE, final.join("\n") + "\n", "utf8");
  console.log(`Wrote ${OUT_FILE} with ${final.length} domains`);
})();
