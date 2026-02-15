# SiteGuardian  
## Privacy Intelligence, Right in Your Browser

> Know what's stored. Take control.  
> SiteGuardian tracks what websites leave behind — cookies, storage, and tracker activity — then presents it clearly in a SaaS-style dashboard popup with a Trust Score, alerts, history graphs, and leaderboards.

---

# 100% Free • Open Source • Zero Data Collection

SiteGuardian is:

- 100% free (no paywalls, no locked features)  
- Open source (you can view every line of code)  
- Account-free  
- Analytics-free  
- Telemetry-free  
- Tracking-free  
- Does **not** collect, sell, or transmit any personal data  
- Does **not** send your browsing activity to any server  
- Everything stays securely within your browser  

If it’s not in the code, it’s not happening.

---

# What SiteGuardian Does

## Full Transparency (Per Site)

- Cookies (and estimated third-party cookies)  
- Stored data (local/session storage + cache/IDB proxy metrics)  
- Tracker detection via Declarative Net Request rules + match feedback  
- History graphs showing storage usage over time  

## Trust Score (Actually Useful)

SiteGuardian generates a Trust Score (0–100) based on weighted factors such as:

- Volume of trackers detected (last 7 days)  
- Number of third-party cookies  
- Usage of persistent vs. session storage  
- How quickly storage is changing (churn)  
- Presence of service workers (minor weighting)  

## Smart Alerts

- Customizable notification thresholds for individual sites  
- Receive warnings when a site's storage usage increases unusually rapidly  

## Leaderboards + "Worst Today"

- A global ranking leaderboard of sites, ordered from worst to best  
- The "Worst site visited today" based on your individual Trust Score  

## Daily Report Notifications (Optional)

- Enable or disable a daily privacy summary  
- Schedule when you want to receive the report (in your local time)  

---

# How It Works

1. SiteGuardian downloads and caches a large list of tracker rules (split into 10 parts).  
2. Chrome notifies SiteGuardian whenever a request matches one of these tracker rules.  
3. The background script aggregates all detected trackers and storage data per site.  
4. When you open the popup, it reads from a local database to display:
   - Your site's trust score  
   - Detected trackers  
   - Current storage usage  
   - History graph  
   - Rankings  
5. Alerts are triggered if storage usage exceeds your set threshold.  

No cloud. No server. No accounts. No data leaves your device.

---

# Features Checklist

- [x] Popup dashboard with a modern, user-friendly interface  
- [x] Detailed per-site storage metrics  
- [x] Per-site cookie counts with estimated third-party cookie numbers  
- [x] Option to add trusted sites to an exclusion list  
- [x] History graphs displaying storage usage over the last 7 or 30 days  
- [x] Weighted and hardened Trust Score for clear site privacy assessment  
- [x] Per-site notification thresholds for custom alerts  
- [x] Tracker detection using DNR rules with detailed match feedback  
- [x] Global leaderboard showing the worst performing sites  
- [x] Identification of the worst site visited today  
- [x] Optional daily privacy report notifications  

---

# Repo-First Workflow (GitHub Builds the Big Stuff)

This repository is set up so GitHub can handle the resource-intensive tasks:

- Fetching vast lists of trackers  
- Deduplicating and extracting domain information  
- Automatically generating MV3 DNR rulesets  
- Committing the generated output back into the repository  

This allows you to work normally, push your changes, and let GitHub Actions take care of the complex list generation.

---

# Install (Load Unpacked)

1. Open Chrome and navigate to `chrome://extensions`  
2. Turn on **Developer Mode**  
3. Click **Load unpacked**  
4. Select the repository folder  

After installing:

- Visit several websites to gather data.  
- Open the SiteGuardian popup to see tracker counts and trust scores update in real-time.  

---

# Project Structure

```txt
.
Manifest.json
service_worker.js
content_script.js
dashboard/
  dashboard.html
  dashboard.css
  dashboard.js
  chart.js
lists/
  trackers_domains.txt
rules/
  trackerrules1.json
  ...
  trackerrules10.json
scripts/
  fetch_trackers.mjs
  build_rules.mjs
.github/workflows/
  build-rules.yml
