# SiteGuardian

Chrome/Edge extension (MV3) that shows privacy intelligence per site:
- Cookies + estimated third-party cookies
- Storage (local/session + cache/idb proxy)
- Tracker request matches via declarativeNetRequest + feedback
- Trust score (weighted)
- History chart (7d/30d)
- Per-site alert threshold
- Exclusions list

## Repo-first workflow (no local runs needed)
- Edit `lists/trackers_domains.txt`
- Push to GitHub
- GitHub Actions builds `rules/tracker_rules_*.json` automatically

## Install (Load unpacked)
1. Chrome: `chrome://extensions`
2. Enable Developer Mode
3. Load Unpacked -> select the repo folder

## Notes
- Cache/IDB “bytes” are best-effort proxies.
- Tracker detection strength depends on the size/quality of `lists/trackers_domains.txt`.
