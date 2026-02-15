import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const OUT_FILE = path.join("lists", "trackers_domains.txt");

const SOURCES = [
  "https://easylist.to/easylist/easyprivacy.txt",
  "https://easylist.to/easylist/easylist.txt",
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
  "https://disconnect.me/trackerprotection/disconnect-plain.json"
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed ${url} ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function isDomain(s) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
}

function normalize(d) {
  return d.trim().toLowerCase().replace(/^www\./, "");
}

function extractDomains(text) {
  const out = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("!") || l.startsWith("#") || l.startsWith("@@")) continue;

    const match = l.match(/([a-z0-9.-]+\.[a-z]{2,})/i);
    if (match?.[1]) {
      const d = normalize(match[1]);
      if (isDomain(d)) out.push(d);
    }
  }

  return out;
}

(async () => {
  fs.mkdirSync("lists", { recursive: true });

  const domains = new Set();

  for (const url of SOURCES) {
    console.log(`Fetching ${url}`);
    const text = await fetchText(url);
    const extracted = extractDomains(text);
    for (const d of extracted) domains.add(d);
  }

  const final = [...domains].sort();
  fs.writeFileSync(OUT_FILE, final.join("\n"));
  console.log(`Wrote ${final.length} domains to ${OUT_FILE}`);
})();
