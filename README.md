# Florida UCC Leads

React + Vite app deployed to Netlify. Searches the Florida Secured Transaction
Registry (`floridaucc.com`) for UCC filings and returns structured leads. The
scrape runs in a Netlify Function so the Firecrawl API key never reaches the
browser.

## Firecrawl mode

Florida's portal is JS-heavy with a disclaimer wall and ASP.NET WebForms
postbacks, so plain markdown scraping won't work. The function uses:

- **Endpoint:** `POST https://api.firecrawl.dev/v1/scrape`
- **`actions`:** click "Accept" on the disclaimer → pick Organization/Individual
  → write the debtor name → click "Search" → wait for results.
- **`formats: ['json']`** with a `schema` so Firecrawl returns parsed lead
  rows (`debtor_name`, `file_number`, `filing_date`, `secured_party`,
  `address`) instead of raw HTML.

Selectors are kept loose (attribute-contains + `:has-text`) because the FL
portal occasionally re-skins. If results come back empty, inspect
`https://www.floridaucc.com/` in DevTools and tighten the selectors in
`netlify/functions/search-ucc.js`.

## Local dev

```bash
npm install
cp .env.example .env       # add your Firecrawl key
npx netlify dev            # serves React + functions on :8888
```

## Deploy to Netlify

1. Push this branch to GitHub.
2. In Netlify: **Add new site → Import from Git**, pick the repo.
3. Build settings auto-detect from `netlify.toml`.
4. Set env var `FIRECRAWL_API_KEY` in **Site settings → Environment variables**.
5. Deploy.

## Files

- `src/App.jsx` — search form + results table + CSV export.
- `netlify/functions/search-ucc.js` — Firecrawl call (server-side).
- `netlify.toml` — build config + `/api/*` → functions redirect.
