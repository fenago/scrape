// Netlify Function: pull UCC filings from floridaucc.com (the new SPA at /search).
//
// FL UCC moved off the old SearchDisclaimer.aspx page. The new site is a React
// SPA that pops a Terms of Use modal on first visit and requires a "Result Set"
// dropdown selection before search results render.
//
// Strategy: hit the deep URL with all query params so the form is pre-filled,
// then use Firecrawl `actions` to (1) accept the disclaimer modal, (2) pick
// "Standard search logic" in the Result Set dropdown, (3) click search, and
// (4) extract rows into a JSON schema.

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
          debtor_name: { type: 'string' },
          file_number: { type: 'string' },
          filing_date: { type: 'string' },
          filing_type: { type: 'string' },
          secured_party: { type: 'string' },
          address: { type: 'string' },
        },
      },
    },
    filings_completed_through: { type: 'string' },
  },
};

const SEARCH_TYPE_MAP = {
  debtor: {
    searchOptionType: 'OrganizationDebtorName',
    searchOptionSubOption: 'FiledCompactDebtorNameList',
  },
  lender: {
    searchOptionType: 'SecuredPartyName',
    searchOptionSubOption: 'FiledCompactSecuredPartyNameList',
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

  // Firecrawl v1 scrape API shape:
  //   formats: string[] (e.g. ['json'])
  //   jsonOptions: { schema, prompt } (top-level, not nested in formats)
  //   actions: [{ type, selector?, milliseconds?, text?, key? }]
  // CSS selectors only — :has-text() and other Playwright-only pseudos don't work.
  const payload = {
    url,
    formats: ['json'],
    jsonOptions: {
      schema: LEAD_SCHEMA,
      prompt:
        'Extract every row from the UCC search results list on the page. Capture ' +
        'debtor name, file number, filing date, filing type, secured party, and any ' +
        'visible address. Also extract the "UCC Filings Completed Through" date if ' +
        'shown in the page header. If only the search form is visible and no result ' +
        'rows are rendered, return an empty leads array.',
    },
    onlyMainContent: false,
    waitFor: 3000,
    timeout: 90000,
    actions: [
      // 1. Accept the disclaimer modal: check the agreement, click Next.
      //    The MUI checkbox is the only checkbox on the page during the modal.
      //    The Next button is the only contained/primary button in the dialog.
      { type: 'wait', milliseconds: 2500 },
      { type: 'click', selector: 'input[type="checkbox"]' },
      { type: 'wait', milliseconds: 500 },
      { type: 'click', selector: 'button.MuiButton-contained' },
      { type: 'wait', milliseconds: 3000 },
      // 2. Wait long enough for the search form (with prefilled URL params) to
      //    auto-trigger a load. If the page renders results immediately because
      //    the URL params populate the form, we're done.
      { type: 'wait', milliseconds: 4000 },
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

  const raw = await firecrawlRes.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json(502, { error: 'Firecrawl returned non-JSON response', body: raw.slice(0, 500) });
  }

  if (!firecrawlRes.ok || data.success === false) {
    return json(firecrawlRes.status || 502, {
      error: data.error || data.message || 'Firecrawl returned an error',
      firecrawl_status: firecrawlRes.status,
      firecrawl_details: data,
      payload_sent: { url, actions: payload.actions.length },
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
