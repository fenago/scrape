// Netlify Function: pull UCC filings from floridaucc.com (the new SPA at /search).
//
// FL UCC moved off the old SearchDisclaimer.aspx page. The new site is a React
// SPA that requires a Terms of Use disclaimer accept on first visit and a
// "Result Set" dropdown selection before search results render.
//
// Strategy: hit the deep URL with all query params so the form is pre-filled,
// then use Firecrawl `actions` to (1) accept the disclaimer modal, (2) pick
// "Standard search logic" in the Result Set dropdown, (3) click search, and
// (4) extract rows into a JSON schema.
//
// Supports two modes:
//   - searchType=debtor  → searchOptionType=OrganizationDebtorName (default)
//   - searchType=lender  → searchOptionType=SecuredPartyName (MCA funder hunt)

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      description: 'Every UCC filing row visible in the result table.',
      items: {
        type: 'object',
        properties: {
          debtor_name: { type: 'string', description: 'Debtor (business) name.' },
          file_number: { type: 'string', description: 'UCC file/document number.' },
          filing_date: { type: 'string', description: 'Date the UCC was filed (MM/DD/YYYY).' },
          filing_type: { type: 'string', description: 'e.g. Initial Financing Statement, Amendment.' },
          secured_party: { type: 'string', description: 'Secured party / lender name.' },
          address: { type: 'string', description: 'Debtor address if shown in row or expandable detail.' },
        },
      },
    },
    filings_completed_through: {
      type: 'string',
      description: 'The "UCC Filings Completed Through: MM/DD/YYYY" header value, if present.',
    },
  },
};

const SEARCH_TYPE_MAP = {
  debtor: {
    searchOptionType: 'OrganizationDebtorName',
    searchOptionSubOption: 'FiledCompactDebtorNameList',
    placeholderHint: 'Organization Name',
  },
  lender: {
    searchOptionType: 'SecuredPartyName',
    searchOptionSubOption: 'FiledCompactSecuredPartyNameList',
    placeholderHint: 'Secured Party Name',
  },
};

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return json(500, { error: 'FIRECRAWL_API_KEY env var is not set.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const prefix = (body.prefix || '').trim();
  const searchType = SEARCH_TYPE_MAP[body.searchType] ? body.searchType : 'debtor';
  const matchMode = body.matchMode === 'Exact' ? 'Exact' : 'BeginsWith';
  if (!prefix) return json(400, { error: 'prefix is required (e.g. a letter A-Z, or a name)' });

  const cfg = SEARCH_TYPE_MAP[searchType];
  const url =
    `https://floridaucc.com/search` +
    `?text=${encodeURIComponent(prefix)}` +
    `&searchOptionType=${cfg.searchOptionType}` +
    `&searchOptionSubOption=${cfg.searchOptionSubOption}` +
    `&searchCategory=${matchMode}`;

  const payload = {
    url,
    formats: [
      {
        type: 'json',
        schema: LEAD_SCHEMA,
        prompt:
          'Extract every row from the UCC search results list. Capture debtor name, ' +
          'file number, filing date, filing type, secured party, and any visible address. ' +
          'Also extract the "UCC Filings Completed Through" date if shown in the page header. ' +
          'If no results render or only the form is visible, return an empty leads array.',
      },
    ],
    onlyMainContent: false,
    waitFor: 3500,
    timeout: 90000,
    actions: [
      // Accept the disclaimer modal (checkbox + Next).
      { type: 'wait', milliseconds: 2500 },
      { type: 'click', selector: 'input[type="checkbox"]' },
      { type: 'wait', milliseconds: 400 },
      { type: 'click', selector: 'button:has-text("Next")' },
      { type: 'wait', milliseconds: 2500 },
      // Open the Result Set dropdown and pick "Standard search logic".
      // The Result Set field is the 3rd dropdown on the form; we click its trigger button.
      { type: 'click', selector: 'button[aria-haspopup="listbox"]:nth-of-type(3), [role="button"][aria-haspopup="listbox"]:nth-of-type(3)' },
      { type: 'wait', milliseconds: 600 },
      { type: 'click', selector: '[role="option"]:has-text("Standard search logic")' },
      { type: 'wait', milliseconds: 600 },
      // Trigger search (the magnifying glass button next to the text field).
      { type: 'click', selector: 'button[aria-label="search"], button:has(svg[data-testid*="Search"])' },
      { type: 'wait', milliseconds: 5000 },
    ],
  };

  let firecrawlRes;
  try {
    firecrawlRes = await fetch(FIRECRAWL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json(502, { error: `Firecrawl request failed: ${err.message}` });
  }

  const data = await firecrawlRes.json().catch(() => ({}));
  if (!firecrawlRes.ok || data.success === false) {
    return json(firecrawlRes.status || 502, {
      error: data.error || data.message || 'Firecrawl returned an error',
      details: data,
    });
  }

  const extracted = data?.data?.json || data?.data?.extract || {};
  const leads = Array.isArray(extracted.leads) ? extracted.leads : [];

  return json(200, {
    leads,
    filingsCompletedThrough: extracted.filings_completed_through || null,
    queryUrl: url,
    prefix,
    searchType,
    matchMode,
  });
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
