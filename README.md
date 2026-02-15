# SiteGuardian

A Chrome/Edge extension (Manifest V3) that monitors and clears site data:
- Cookies (count + size estimate)
- localStorage + sessionStorage (size estimate + change events)
- Clearing: cookies + local/session + IndexedDB (best-effort) + Cache Storage (best-effort)

## Run locally
1. Open Chrome -> `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked"
4. Select the `siteguardian/` folder

Browse a few sites, then click the SiteGuardian icon.

## Notes / limitations
- Cookie size is an estimate.
- IndexedDB + Cache clearing depends on browser support and page context.
- This is an MVP starter; expand scoring, categories, and tracker detection as needed.
