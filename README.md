# Ledger

A zero-backend revenue & receipt tracker that runs entirely in your browser.

- **Upload a CSV** (e.g. a Depop sales export) — parsed locally with an interactive column mapper
- **See revenue** in a filterable ledger table with running totals (revenue, expenses, net)
- **Add receipts as expenses** — with categories, free-form labels, and a stored photo of each receipt
- **Backup / restore** everything as a JSON file

## Privacy

No server, no database, no network calls. All data — CSV rows, receipts, and images —
lives in IndexedDB and localStorage on your own device. Export a backup if you
switch browsers or devices.

## Run locally

Open `index.html` in any modern browser. No build step, no dependencies.

## Deploy

Pushed to GitHub Pages automatically by `.github/workflows/deploy.yml`.