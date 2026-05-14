// Submit a batch of FL UCC search URLs to Firecrawl's async /v1/batch/scrape.
// Returns a job ID instantly (under Netlify's 10s sync limit). The client polls
// /api/scrape-status?id=<jobId> until status === 'completed'.
//
// FL UCC site structure (verified live):
//   - SPA at https://floridaucc.com/search
//   - Terms of Use modal blocks first visit. Accept by clicking the agreement
//     checkbox + the contained-primary "Next" button.
//   - Search form has 4 fields: Search Type, Search Option, Result Set,
//     Organization Name. The Result Set dropdown is REQUIRED.
//   - After accepting the modal, we use executeJavascript to click the 3rd
//     [aria-haspopup="listbox"] button (Result Set), pick the "Standard search
//     logic" option, then click the search button.
//   - Result columns: Name | UCC Number | Address | City | State | Zip | Status.
//   - The UCC Number's first 4 digits are the filing year.
//   - "Standard search logic" only matches compacted names exactly, so "A"
//     returns the businesses named exactly "A CORP.", etc. For prefix
//     browsing the user should supply concrete name fragments via customNames.

const FIRECRAWL_BATCH = 'https://api.firecrawl.dev/v1/batch/scrape';

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      description: 'Every row in the Search Results table.',
      items: {
        type: 'object',
        properties: {
          debtor_name: { type: 'string', description: 'Name column.' },
          ucc_number:  { type: 'string', description: 'UCC Number column.' },
          address:     { type: 'string' },
          city:        { type: 'string' },
          state:       { type: 'string' },
          zip:         { type: 'string', description: 'Zip Code column.' },
          status:      { type: 'string', description: 'e.g. FILED, LAPSED.' },
        },
      },
    },
    total_records_matched: {
      type: 'string',
      description: 'The "N records matched this search" footer text.',
    },
    filings_completed_through: { type: 'string' },
  },
};

const SEARCH_TYPE_MAP = {
  debtor: { searchOptionType: 'OrganizationDebtorName', searchOptionSubOption: 'FiledCompactDebtorNameList' },
  lender: { searchOptionType: 'SecuredPartyName',       searchOptionSubOption: 'FiledCompactSecuredPartyNameList' },
};

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return json(500, { error: 'FIRECRAWL_API_KEY env var is not set.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const searchType = SEARCH_TYPE_MAP[body.searchType] ? body.searchType : 'debtor';
  // searchCategory in the URL controls the INITIAL Result Set value. The valid
  // value observed in production is "Standard" (gives Standard search logic by
  // default; we then click Proximity via JS if asked). "BeginsWith" leaves the
  // Result Set field unset, which silently breaks the search.
  const searchCategory = 'Standard';
  const searchLogic = body.searchLogic === 'standard' ? 'standard' : 'proximity';
  const logicNeedle = searchLogic === 'standard' ? 'standard' : 'proximity';

  let prefixes = [];
  if (Array.isArray(body.prefixes)) prefixes.push(...body.prefixes);
  if (Array.isArray(body.customNames)) prefixes.push(...body.customNames);
  prefixes = [...new Set(prefixes.map(p => (p || '').trim()).filter(Boolean))];

  const maxQueries = clamp(parseInt(body.maxQueries, 10) || 25, 1, 50);
  if (prefixes.length > maxQueries) prefixes = prefixes.slice(0, maxQueries);
  if (!prefixes.length) return json(400, { error: 'No queries provided. Pick lenders or enter custom names.' });

  const cfg = SEARCH_TYPE_MAP[searchType];
  const urls = prefixes.map(p =>
    `https://floridaucc.com/search` +
    `?text=${encodeURIComponent(p)}` +
    `&searchOptionType=${cfg.searchOptionType}` +
    `&searchOptionSubOption=${cfg.searchOptionSubOption}` +
    `&searchCategory=${searchCategory}`
  );

  const payload = {
    urls,
    formats: ['json'],
    jsonOptions: {
      schema: LEAD_SCHEMA,
      prompt:
        'Extract every row from the "Search Results" table. Each row has columns: ' +
        'Name, UCC Number, Address, City, State, Zip Code, Status. Also capture the ' +
        '"N records matched this search" footer text and the "UCC Filings Completed ' +
        'Through" date from the page header. If only the search form is visible and ' +
        'no result rows are present, return an empty leads array.',
    },
    onlyMainContent: false,
    waitFor: 2000,
    timeout: 120000,
    actions: [
      // 1. Accept the Terms of Use modal.
      { type: 'wait', milliseconds: 2500 },
      { type: 'click', selector: 'input[type="checkbox"]' },
      { type: 'wait', milliseconds: 500 },
      { type: 'click', selector: 'button.MuiButton-contained' },
      { type: 'wait', milliseconds: 2500 },
      // 2. Click the "Result Set" dropdown (3rd dropdown on the form).
      { type: 'executeJavascript', script:
        "const b=document.querySelectorAll('button[aria-haspopup=\"listbox\"]');" +
        "if(b[2])b[2].click();"
      },
      { type: 'wait', milliseconds: 800 },
      // 3. Pick the search logic option (Proximity or Standard).
      { type: 'executeJavascript', script:
        "const o=Array.from(document.querySelectorAll('[role=\"option\"]'));" +
        `const t=o.find(x=>(x.textContent||'').toLowerCase().includes('${logicNeedle}'));` +
        "if(t)t.click();"
      },
      { type: 'wait', milliseconds: 800 },
      // 4. Submit the search (magnifying glass next to the text input).
      { type: 'click', selector: 'button[aria-label="search"]' },
      // 5. Wait for results table to render.
      { type: 'wait', milliseconds: 7000 },
    ],
  };

  let res;
  try {
    res = await fetch(FIRECRAWL_BATCH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json(502, { error: `Firecrawl request failed: ${err.message}` });
  }

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    return json(502, { error: 'Firecrawl returned non-JSON response', body: raw.slice(0, 500) });
  }
  if (!res.ok || data.success === false) {
    return json(res.status || 502, {
      error: data.error || data.message || 'Firecrawl returned an error',
      firecrawl_status: res.status,
      firecrawl_details: data,
    });
  }

  return json(200, {
    jobId: data.id,
    statusUrl: data.url,
    totalQueries: prefixes.length,
    queries: prefixes.map((p, i) => ({ query: p, url: urls[i] })),
    searchType,
    matchMode,
    submittedAt: new Date().toISOString(),
  });
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
