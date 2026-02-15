import fs from "node:fs";
import path from "node:path";

const INPUT = "lists/trackers_domains.txt";
const OUT_DIR = "rules";

const MAX_RULESETS = 10;
const CHUNK_SIZE = 9000;

function uniq(arr) { return [...new Set(arr)]; }

function readDomains(file) {
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !l.startsWith("#"))
    .map(d => d.toLowerCase())
    .map(d => d.replace(/^www\./, ""))
    .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d));
}

function toRule(id, domain) {
  // IMPORTANT: urlFilter uses Adblock-style anchors for accuracy
  // Example: ||doubleclick.net^
  return {
    id,
    priority: 1,
    action: { type: "allow" },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: [
        "main_frame",
        "sub_frame",
        "script",
        "xmlhttprequest",
        "image",
        "media",
        "font",
        "stylesheet",
        "other"
      ]
    }
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

if (!fs.existsSync(INPUT)) {
  console.error(`Missing ${INPUT}`);
  process.exit(1);
}

let domains = uniq(readDomains(INPUT));
console.log(`domains: ${domains.length}`);

fs.mkdirSync(OUT_DIR, { recursive: true });

const parts = chunk(domains, CHUNK_SIZE).slice(0, MAX_RULESETS);

let globalId = 1;

// Always write ALL 10 files every run
for (let i = 1; i <= MAX_RULESETS; i++) {
  const idx = i - 1;
  const slice = parts[idx] || [];
  const rules = slice.map(d => toRule(globalId++, d));

  fs.writeFileSync(
    path.join(OUT_DIR, `tracker_rules_${i}.json`),
    JSON.stringify(rules, null, 2),
    "utf8"
  );

  console.log(`wrote tracker_rules_${i}.json (${rules.length})`);
}

if (parts.length <= 1) {
  console.log(`Only ${parts.length} ruleset(s) produced. Increase domains or lower CHUNK_SIZE.`);
}
