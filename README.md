# 🛡️ SiteGuardian — Privacy Intelligence, Right in Your Browser

> **Know what’s stored. Take control.**  
> SiteGuardian watches what websites quietly leave behind — cookies, storage, tracker activity — then turns it into a clean, **SaaS-style dashboard popup** with a **Trust Score**, **alerts**, **history graphs**, and **leaderboards**.

---

## 🆓 100% Free • 🔓 Open Source • 🚫 Zero Data Collection

SiteGuardian is:
- 🆓 **100% free** (no paywalls, no premium locks)
- 🔓 **open source** (you can inspect everything it does)
- 🚫 **no accounts**
- 🚫 **no analytics**
- 🚫 **no telemetry**
- 🚫 **no tracking**
- ✅ **does not collect, sell, or transmit any personal data**
- ✅ **does not send your browsing data anywhere**
- ✅ **everything stays inside your browser**

If it isn’t in the code, it isn’t happening.

---

## ✨ What SiteGuardian Does

### 🔍 Full Transparency (Per Site)
- 🍪 **Cookies** + estimated **third-party cookies**
- 💾 **Stored data** (local/session storage + cache/IDB proxy metrics)
- 🧵 **Tracker detection** via **Declarative Net Request** rules + match feedback
- 📈 **History graphs** (storage over time)

### 🧪 Trust Score (Actually Useful)
SiteGuardian calculates a **Trust Score (0–100)** using weighted signals like:
- 📡 tracker match volume (last 7 days)
- 🍪 third-party cookies
- 💾 persistent vs session storage behavior
- 🔁 storage churn (rapid changes)
- 🧰 service worker presence (minor weight)

### 🚨 Smart Alerts
- 📈 **Per-site notification thresholds**
- Get warned when a site’s stored data jumps unusually fast

### 🏆 Leaderboards + “Worst Today”
- 🥇 **Global ranking leaderboard** (worst sites first)
- ☠️ **Worst site visited today** (based on Trust Score)

### 🗞️ Daily Report Notifications (Optional)
- ✅ Toggle daily privacy report on/off
- 🕘 Choose the hour it fires (local time)

---

## 🧠 How It Works (Baby-Simple)

1. 🧾 SiteGuardian loads a big tracker ruleset (split into 10 chunks)
2. 🌐 Chrome reports when a request matches one of those tracker rules
3. 📊 The background worker totals everything up per site
4. 🧩 The popup dashboard reads the local database and shows:
   - trust score
   - trackers
   - storage
   - history graph
   - rankings
5. 🚨 Alerts fire if storage growth exceeds your threshold

**No cloud. No server. No accounts. No data leaving your device.**

---

## ✅ Features Checklist

- [x] Popup dashboard (modern UI)
- [x] Per-site storage metrics
- [x] Per-site cookie counts + third-party estimate
- [x] Exclusions list (trusted sites)
- [x] History graph (7d / 30d)
- [x] Trust score (weighted + hardened)
- [x] Per-site notification thresholds
- [x] Tracker detection via DNR + feedback
- [x] Global worst-sites leaderboard
- [x] Worst site visited today
- [x] Daily report notification (optional)

---

## ⚡ Repo-First Workflow (GitHub Builds the Big Stuff)

This repo is designed so GitHub can do the heavy lifting:
- 📥 Fetches huge tracker lists
- 🧠 Extracts and deduplicates domains
- 🧱 Builds MV3 DNR rulesets automatically
- ✅ Commits the generated output back into the repo

So you can edit normally, push, and let Actions handle the massive lists 🔥

---

## 🚀 Install (Load Unpacked)

1. Open Chrome: `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select the repo folder

Then:
- Visit a few sites
- Open the SiteGuardian popup
- Watch tracker counts and trust scores update instantly ✅

---

## 🗂️ Project Structure

```txt
.
├─ manifest.json
├─ service_worker.js
├─ content_script.js
├─ dashboard/
│  ├─ dashboard.html
│  ├─ dashboard.css
│  ├─ dashboard.js
│  └─ chart.js
├─ lists/
│  └─ trackers_domains.txt
├─ rules/
│  ├─ tracker_rules_1.json
│  ├─ ...
│  └─ tracker_rules_10.json
├─ scripts/
│  ├─ fetch_trackers.mjs
│  └─ build_rules.mjs
└─ .github/workflows/
   └─ build-rules.yml
