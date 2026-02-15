import fs from "node:fs";
import path from "node:path";

const INPUT = "lists/trackers_domains.txt";
const OUT_DIR = "rules";

// keep under your max number of rulesets in manifest
const MAX_RULESETS = 10;

// chunk size controls how many output files you get
const CHUNK_SIZE = 9000;

function uniq(arr) { return [...new Set(arr)]; }

function readDomains(file) {
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !l.startsWith("#"))
    .map(d => d.replace(/^www\./, ""))
    .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d));
}

function toRule(id, domain) {
  // allow (do not block) + use DNR feedback to count matches
  return {
    id,
    priority: 1,
    action: { type: "allow" },
    condition: {
      urlFilter: domain,
      resourceTypes: [
        "main_frame","sub_frame","script","xmlhttprequest","image","media","font","stylesheet","other"
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

// write populated files
for (let i = 0; i < parts.length; i++) {
  const rules = parts[i].map(d => toRule(globalId++, d));
  fs.writeFileSync(path.join(OUT_DIR, `tracker_rules_${i + 1}.json`), JSON.stringify(rules, null, 2));
  console.log(`wrote tracker_rules_${i + 1}.json (${rules.length})`);
}

// ensure remaining files exist (empty)
for (let i = parts.length + 1; i <= MAX_RULESETS; i++) {
  const p = path.join(OUT_DIR, `tracker_rules_${i}.json`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, "[]");
  console.log(`ensured tracker_rules_${i}.json`);
}
